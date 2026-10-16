/**
 * @file tests/board-watch-backoff.test.ts — regression tests for the
 * `sages-board-watch` "sucked" behavior.
 *
 * The bug (evidence: ~/.pi/agent/extensions/routines/state.json,
 * tickState['sages-board-watch'], captured 2026-10-16 22:21):
 *   - intervalMs = 30_000 (template says 120_000; persisted state is stale
 *     from a prior install when the template still said 30s)
 *   - tickCount = 168 over a 78-min session
 *   - 14 consecutive "routine already queued" skip records, all produced
 *     during a single 431.8-second fire (the LLM got stuck on a
 *     `tool_use.input` retry storm — see
 *     .pi/orchestrator/analysis/orchestration-progress-2026-10-16.md)
 *   - successful fires return "[~]" (board empty); each fire costs ~3.4KB
 *     of prompt tokens for a near-zero-information round trip
 *
 * The fix (smallest change in `src/`, never in the template) is an
 * adaptive backoff keyed on `RoutineTickState.consecutiveSilentTicks`:
 *   1. `recordRun` bumps the counter when a run is `"silent"` OR a
 *      `"success"` whose snippet is the `[~]` token (the suppressor only
 *      sets `status: "silent"` on exact equality, so we also recognise the
 *      `[~` truncated prefix).
 *   2. `recordRun` resets the counter to 0 on a non-quiet `"success"`.
 *   3. `computePulseIntervalMs` doubles the effective interval for every
 *      consecutive silent tick past the threshold, capped at
 *      `BACKOFF_MAX_INTERVAL_MS` (10 min).
 *   4. The pulse trigger now arms via chained `setTimeout` so the next
 *      delay reflects the *latest* backoff state instead of the value at
 *      session_start.
 *   5. `enqueueTriggerFire` short-circuits when the runtime already holds
 *      the per-routine lock (`runtime.pendingRun?.routineId === id`) — the
 *      "tick-acquire fallback" — logging "skipped: lock held" instead of
 *      stalling the watchdog.
 *   6. `catchUpMissedTicks` already fires at most once per session_start
 *      per routine; we pin that contract here so a future change cannot
 *      regress it into a catch-up stampede.
 *
 * Acceptance for this fix:
 *   - These tests fail on the unfixed runtime (interval stays flat at the
 *     trigger's `intervalMs`, regardless of how many silent fires landed).
 *   - These tests pass on the fixed runtime.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { recordRun } from "../src/executor.ts";
import { computePulseIntervalMs } from "../src/scheduler.ts";
import { emptyStore } from "../src/store.ts";
import {
	BACKOFF_FACTOR,
	BACKOFF_MAX_INTERVAL_MS,
	BACKOFF_MAX_MULTIPLIER,
	BACKOFF_THRESHOLD,
	type PulseTrigger,
	type RoutineRuntimeState,
	SILENT_TOKEN,
} from "../src/types.ts";

function makePulseTrigger(intervalMs: number): PulseTrigger {
	return { kind: "pulse", intervalMs, intervalHuman: `${intervalMs}ms` };
}

function makeRuntime(): RoutineRuntimeState {
	return {
		store: emptyStore(),
		timers: new Map(),
		queue: [],
		isRoutineTurnActive: false,
		activeRoutineName: null,
		lastUiCtx: null,
		triggerOrigin: new Map(),
		pendingRun: null,
	};
}

describe("board-watch adaptive backoff (the 'sucked' fix)", () => {
	describe("computePulseIntervalMs — unit", () => {
		it("returns the trigger interval when there is no tick state", () => {
			assert.equal(computePulseIntervalMs(makePulseTrigger(30_000), undefined), 30_000);
		});

		it("returns the trigger interval while the counter is below the threshold", () => {
			for (let n = 0; n < BACKOFF_THRESHOLD; n++) {
				assert.equal(
					computePulseIntervalMs(makePulseTrigger(30_000), { consecutiveSilentTicks: n }),
					30_000,
					`counter ${n} (below threshold ${BACKOFF_THRESHOLD}) must not back off`,
				);
			}
		});

		it("doubles the interval for each consecutive silent tick past the threshold", () => {
			const trigger = makePulseTrigger(30_000);
			const expected: number[] = [];
			let mult = BACKOFF_FACTOR;
			for (let n = BACKOFF_THRESHOLD; n <= BACKOFF_THRESHOLD + 4; n++) {
				expected.push(Math.min(trigger.intervalMs * mult, BACKOFF_MAX_INTERVAL_MS));
				mult *= BACKOFF_FACTOR;
			}
			for (let i = 0; i < expected.length; i++) {
				const got = computePulseIntervalMs(trigger, {
					consecutiveSilentTicks: BACKOFF_THRESHOLD + i,
				});
				assert.equal(got, expected[i], `counter ${BACKOFF_THRESHOLD + i}`);
			}
		});

		it("caps the interval at BACKOFF_MAX_INTERVAL_MS even after many silent ticks", () => {
			const trigger = makePulseTrigger(30_000);
			const got = computePulseIntervalMs(trigger, { consecutiveSilentTicks: 100 });
			assert.equal(got, BACKOFF_MAX_INTERVAL_MS);
		});

		it("caps the multiplier at BACKOFF_MAX_MULTIPLIER before the absolute cap", () => {
			// For a 1-second trigger, BACKOFF_MAX_MULTIPLIER = 32 yields 32s,
			// which is well below BACKOFF_MAX_INTERVAL_MS — so the multiplier
			// cap is the binding constraint, not the absolute cap.
			const trigger = makePulseTrigger(1_000);
			const got = computePulseIntervalMs(trigger, { consecutiveSilentTicks: 20 });
			assert.equal(got, trigger.intervalMs * BACKOFF_MAX_MULTIPLIER);
		});
	});

	describe("recordRun — backoff counter accounting", () => {
		it("bumps consecutiveSilentTicks on status='silent' runs", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "silent",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: SILENT_TOKEN,
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveSilentTicks, 1);
		});

		it("bumps consecutiveSilentTicks on 'success' runs whose snippet is [~]-prefixed", () => {
			// Suppressor sets status='silent' only on exact "[~]" equality.
			// A "[~` truncated snippet (e.g. "[~] but maybe ..." → truncated
			// to "[~] but maybe …" or longer responses that survive the
			// 200-char cap as "[~` prefix) lands as 'success'. We must still
			// recognise those as quiet.
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				consecutiveSilentTicks: 2,
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "success",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "[~",
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveSilentTicks, 3);
		});

		it("resets consecutiveSilentTicks to 0 on a non-quiet success run", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				consecutiveSilentTicks: 7,
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "success",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "Converted intent 5 into plan tasks 7, 8.",
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveSilentTicks, 0);
		});

		it("leaves consecutiveSilentTicks untouched on 'error' and 'skipped' runs", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				consecutiveSilentTicks: 4,
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "error",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "Provider 400 tool_use.input",
			});
			recordRun(runtime, runtime.store, {
				id: "r2",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "skipped",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "routine already queued",
				skipReason: "routine already queued",
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveSilentTicks, 4);
		});

		it("survives an undefined consecutiveSilentTicks counter (initial state)", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				// consecutiveSilentTicks omitted — common on first-ever fire.
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "silent",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: SILENT_TOKEN,
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveSilentTicks, 1);
		});
	});

	describe("regression — the 'sucked' bug", () => {
		it("after 5 consecutive silent fires the effective interval exceeds 2× the trigger interval", () => {
			// Reproduces the unfixed behaviour: regardless of how many silent
			// fires the runtime sees, the next arm uses the trigger's
			// original intervalMs. Under the fix, 5 silent fires land us
			// past BACKOFF_THRESHOLD (2) and the interval is at least
			// BACKOFF_FACTOR (=2) × the original.
			const trigger = makePulseTrigger(30_000);
			let ts = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
			} as Parameters<typeof computePulseIntervalMs>[1];
			for (let i = 0; i < 5; i++) {
				const runtime = makeRuntime();
				runtime.store.tickState["sages-board-watch"] = {
					tickCount: 0,
					lastFiredAt: 0,
					lastFiredDateLocal: "",
					userState: {},
					consecutiveSilentTicks: ts?.consecutiveSilentTicks ?? 0,
				};
				recordRun(runtime, runtime.store, {
					id: `r${i}`,
					routineId: "sages-board-watch",
					startedAt: 0,
					endedAt: 0,
					durationMs: 0,
					status: "silent",
					triggerIndex: 0,
					triggerKind: "pulse",
					snippet: SILENT_TOKEN,
				});
				ts = runtime.store.tickState["sages-board-watch"];
			}
			const finalInterval = computePulseIntervalMs(trigger, ts);
			assert.ok(
				finalInterval > trigger.intervalMs * 2,
				`expected effective interval > 2× trigger after 5 silent fires, got ${finalInterval}ms`,
			);
		});
	});

	describe("fallback paths", () => {
		it("catch-up fallback: catchUpMissedTicks fires at most once per session_start per routine", async () => {
			// Load scheduler.ts dynamically to avoid bundling its pi-coding-agent
			// type imports in the test graph.
			const scheduler = await import("../src/scheduler.ts");
			const storeMod = await import("../src/store.ts");

			const runtime = makeRuntime();
			const pulse = makePulseTrigger(30_000);
			const routineId = "sages-board-watch";
			const createdAt = Date.now() - 10 * 60_000; // 10 minutes ago
			runtime.store.routines[routineId] = {
				id: routineId,
				name: routineId,
				prompt: "test",
				triggers: [pulse],
				context: "session",
				quiet: true,
				createdAt,
			};
			runtime.store.tickState[routineId] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
			};

			// Catch-up uses runtime.store.routines + lastFiredAt — no pi, no
			// getCtx needed because the function only enqueues (autoDrain: false).
			const fakePi = {} as unknown as Parameters<typeof scheduler.catchUpMissedTicks>[2];
			const fakeGetCtx = (() => null) as unknown as Parameters<
				typeof scheduler.catchUpMissedTicks
			>[3];

			scheduler.catchUpMissedTicks(runtime, fakePi, fakeGetCtx);
			const afterFirst = runtime.queue.length;
			// A second invocation with no progress on the routine MUST NOT
			// enqueue another catch-up — the contract is "at most one per
			// activation" (i.e. one per session_start).
			scheduler.catchUpMissedTicks(runtime, fakePi, fakeGetCtx);
			const afterSecond = runtime.queue.length;

			assert.equal(afterFirst, 1, "first catch-up must enqueue exactly one fire");
			assert.equal(
				afterSecond,
				afterFirst,
				"second catch-up in the same session_start must NOT enqueue another fire",
			);

			// Wait for any pending saveStore to settle so the test doesn't leak file handles.
			await storeMod.flushStoreWrites();
		});

		it("tick-acquire fallback: enqueueTriggerFire skips with 'lock held' when the previous fire is in flight", async () => {
			const scheduler = await import("../src/scheduler.ts");
			const storeMod = await import("../src/store.ts");

			const runtime = makeRuntime();
			const pulse = makePulseTrigger(30_000);
			const routineId = "sages-board-watch";
			const routineObj = {
				id: routineId,
				name: routineId,
				prompt: "test",
				triggers: [pulse],
				context: "session" as const,
				quiet: true,
				createdAt: Date.now(),
			};
			runtime.store.routines[routineId] = routineObj;
			runtime.store.tickState[routineId] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
			};

			// Pretend a previous fire is still in flight by setting pendingRun.
			runtime.pendingRun = {
				routineId,
				runId: "prev",
				triggerIndex: 0,
				triggerKind: "pulse",
				startedAt: Date.now(),
				snippet: "",
				status: "success",
			};

			const fakePi = {} as unknown as Parameters<typeof scheduler.enqueueTriggerFire>[3];
			const fakeGetCtx = (() => null) as unknown as Parameters<
				typeof scheduler.enqueueTriggerFire
			>[4];

			scheduler.enqueueTriggerFire(routineObj, 0, runtime, fakePi, fakeGetCtx);

			// The queue MUST NOT have grown — the lock-held branch records a
			// skip instead of enqueueing. The skip record itself is in
			// tickState.runs, which is what /routine-runs surfaces.
			assert.equal(runtime.queue.length, 0, "lock-held tick must NOT enqueue");
			const runs = runtime.store.tickState[routineId].runs ?? [];
			const lastSkip = runs[runs.length - 1];
			assert.ok(lastSkip, "a skip record must be written");
			assert.equal(lastSkip.status, "skipped");
			assert.equal(lastSkip.skipReason, "lock held: previous fire still in flight");

			await storeMod.flushStoreWrites();
		});

		it("concurrency: two simultaneous enqueueTriggerFire calls for the same routine only enqueue once", async () => {
			const scheduler = await import("../src/scheduler.ts");
			const storeMod = await import("../src/store.ts");

			const runtime = makeRuntime();
			const pulse = makePulseTrigger(30_000);
			const routineId = "sages-board-watch";
			const routineObj = {
				id: routineId,
				name: routineId,
				prompt: "test",
				triggers: [pulse],
				context: "session" as const,
				quiet: true,
				createdAt: Date.now(),
			};
			runtime.store.routines[routineId] = routineObj;
			runtime.store.tickState[routineId] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
			};

			const fakePi = {} as unknown as Parameters<typeof scheduler.enqueueTriggerFire>[3];
			const fakeGetCtx = (() => null) as unknown as Parameters<
				typeof scheduler.enqueueTriggerFire
			>[4];

			// Multi-trigger collapse window is 500ms — fire two calls within
			// that window to exercise both the dedup paths.
			scheduler.enqueueTriggerFire(routineObj, 0, runtime, fakePi, fakeGetCtx);
			scheduler.enqueueTriggerFire(routineObj, 0, runtime, fakePi, fakeGetCtx);
			scheduler.enqueueTriggerFire(routineObj, 0, runtime, fakePi, fakeGetCtx);

			assert.equal(
				runtime.queue.length,
				1,
				"three ticks within the collapse window must dedup to one fire",
			);

			const runs = runtime.store.tickState[routineId].runs ?? [];
			// First call enqueues; second + third are collapsed or already-queued.
			const skippedReasons = runs.filter((r) => r.status === "skipped").map((r) => r.skipReason);
			assert.ok(
				skippedReasons.some(
					(reason) =>
						reason === "collapsed duplicate trigger" || reason === "routine already queued",
				),
				`expected at least one collapsed-or-already-queued skip, got ${JSON.stringify(skippedReasons)}`,
			);

			await storeMod.flushStoreWrites();
		});
	});
});

// --------------------------------------------------------------------------- //
// No-tools fallback — when a routine's session lacks the required tools
// (e.g. sages-board-watch without TaskList / TaskUpdate / TaskCreate in its
// tool surface), every LLM turn attempts a tool call that the runtime
// rejects, landing the run with `status: "error"`. Without engaging
// backoff, the routine would burn ~trigger.intervalMs provider tokens
// indefinitely on a session that can never succeed.
//
// The fix mirrors the silent-counter pattern: a parallel
// `consecutiveErrorTicks` counter on `RoutineTickState` that
// `recordRun` bumps on `status: "error"` and resets on any
// `status: "success"` or `status: "silent"`. `computePulseIntervalMs`
// uses `max(silent, errored)` as the effective streak so either kind
// of non-progress engages the same exponential backoff.
// --------------------------------------------------------------------------- //

describe("board-watch no-tools fallback (status: error → backoff)", () => {
	describe("recordRun — consecutiveErrorTicks accounting", () => {
		it("bumps consecutiveErrorTicks on status='error' runs", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "error",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "Tool 'TaskList' not available in this session",
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveErrorTicks, 1);
		});

		it("resets consecutiveErrorTicks to 0 on a 'success' run", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				consecutiveErrorTicks: 7,
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "success",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "converted intent 5 into plan tasks 7, 8",
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveErrorTicks, 0);
		});

		it("resets consecutiveErrorTicks to 0 on a 'silent' run (tool surface works, just no work)", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				consecutiveErrorTicks: 4,
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "silent",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: SILENT_TOKEN,
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveErrorTicks, 0);
		});

		it("leaves consecutiveErrorTicks untouched on 'skipped' runs", () => {
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				consecutiveErrorTicks: 4,
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "skipped",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "daily cap reached",
				skipReason: "daily cap reached",
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveErrorTicks, 4);
		});

		it("leaves consecutiveSilentTicks untouched when only consecutiveErrorTicks is non-zero (and vice versa)", () => {
			// The two counters track independent streaks; bumping one must
			// not reset the other, so a long silent streak followed by an
			// error streak still keeps the silent history.
			const runtime = makeRuntime();
			runtime.store.tickState["sages-board-watch"] = {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
				consecutiveSilentTicks: 9,
			};
			recordRun(runtime, runtime.store, {
				id: "r1",
				routineId: "sages-board-watch",
				startedAt: 0,
				endedAt: 0,
				durationMs: 0,
				status: "error",
				triggerIndex: 0,
				triggerKind: "pulse",
				snippet: "no tools",
			});
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveSilentTicks, 9);
			assert.equal(runtime.store.tickState["sages-board-watch"].consecutiveErrorTicks, 1);
		});
	});

	describe("computePulseIntervalMs — error streak engages backoff", () => {
		it("returns the trigger interval while the error counter is below the threshold", () => {
			for (let n = 0; n < BACKOFF_THRESHOLD; n++) {
				assert.equal(
					computePulseIntervalMs(makePulseTrigger(30_000), { consecutiveErrorTicks: n }),
					30_000,
					`error counter ${n} (below threshold ${BACKOFF_THRESHOLD}) must not back off`,
				);
			}
		});

		it("doubles the interval for each consecutive error tick past the threshold", () => {
			const trigger = makePulseTrigger(30_000);
			for (let n = BACKOFF_THRESHOLD; n <= BACKOFF_THRESHOLD + 3; n++) {
				const expected = Math.min(
					trigger.intervalMs * BACKOFF_FACTOR ** (n - BACKOFF_THRESHOLD + 1),
					BACKOFF_MAX_INTERVAL_MS,
				);
				const got = computePulseIntervalMs(trigger, { consecutiveErrorTicks: n });
				assert.equal(got, expected, `error counter ${n}`);
			}
		});

		it("uses max(silent, errored) so either streak engages the same backoff", () => {
			const trigger = makePulseTrigger(30_000);
			// Both below threshold → flat.
			assert.equal(
				computePulseIntervalMs(trigger, {
					consecutiveSilentTicks: 1,
					consecutiveErrorTicks: 1,
				}),
				30_000,
			);
			// Only error past threshold → backoff at the same rate as silent.
			const silent = computePulseIntervalMs(trigger, { consecutiveSilentTicks: 3 });
			const error = computePulseIntervalMs(trigger, { consecutiveErrorTicks: 3 });
			assert.equal(error, silent);
			// Mixed: max wins.
			const mixed = computePulseIntervalMs(trigger, {
				consecutiveSilentTicks: 2,
				consecutiveErrorTicks: 5,
			});
			const maxEither = computePulseIntervalMs(trigger, { consecutiveErrorTicks: 5 });
			assert.equal(mixed, maxEither);
		});
	});

	describe("regression — missing tools engage backoff", () => {
		it("after 5 consecutive error fires the effective interval exceeds 2× the trigger interval", () => {
			// Reproduces the unfixed behaviour: a routine in a session that
			// lacks the required tools keeps getting status='error' runs.
			// The unfixed runtime's computePulseIntervalMs ignores error
			// streaks entirely, so the next arm always uses the original
			// intervalMs. Under the fix, 5 error fires land us past
			// BACKOFF_THRESHOLD (2) and the interval is at least
			// BACKOFF_FACTOR (=2) × the original.
			const trigger = makePulseTrigger(30_000);
			let ts: { consecutiveErrorTicks?: number; consecutiveSilentTicks?: number } | undefined;
			for (let i = 0; i < 5; i++) {
				const runtime = makeRuntime();
				runtime.store.tickState["sages-board-watch"] = {
					tickCount: 0,
					lastFiredAt: 0,
					lastFiredDateLocal: "",
					userState: {},
					consecutiveErrorTicks: ts?.consecutiveErrorTicks ?? 0,
				};
				recordRun(runtime, runtime.store, {
					id: `r${i}`,
					routineId: "sages-board-watch",
					startedAt: 0,
					endedAt: 0,
					durationMs: 0,
					status: "error",
					triggerIndex: 0,
					triggerKind: "pulse",
					snippet: "Tool 'TaskList' not available",
				});
				ts = runtime.store.tickState["sages-board-watch"];
			}
			const finalInterval = computePulseIntervalMs(trigger, ts);
			assert.ok(
				finalInterval > trigger.intervalMs * 2,
				`expected effective interval > 2× trigger after 5 error fires, got ${finalInterval}ms`,
			);
		});
	});
});

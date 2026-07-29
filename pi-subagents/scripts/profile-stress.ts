/**
 * scripts/profile-stress.ts — GC-2026-020 synthetic workload harness.
 *
 * Purpose:
 *   Drive the env-flagged CPU instrumentation through its real wired
 *   code paths (or counter-API fallback with realistic magnitudes where
 *   the real path is entangled with a runtime we can't bootstrap in a
 *   bare script), then surface what the `profile_summary` writer reports
 *   under that load. Three concurrent processes running this harness
 *   reproduce the "N pi instances + subagent workload → CPU 95%+"
 *   scenario at a smaller scale so we can attribute the cost to a
 *   specific counter.
 *
 * Hot-path coverage (per dev's instrumentation):
 *
 *   a) agent_manager_live      — counter-API fallback (AgentManager
 *                                constructor needs a pi runtime we
 *                                can't fabricate here). Documented
 *                                below; magnitudes mirror the spawn/
 *                                finish lifecycle dev wired.
 *
 *   b) schedule_store_busy_wait_retries
 *                              — HYBRID: 1× real `ScheduleStore.add()`
 *                                against a dead-pid lock file (proves
 *                                the instrumentation is reachable from
 *                                the public API), then direct `inc()`
 *                                calls simulating 5 sustained busy-wait
 *                                cycles × ~50 retries each. The real
 *                                in-process contention path blocks the
 *                                event loop for ~5 s per cycle (100 iters
 *                                × 50 ms busy-wait each), which is too
 *                                long for a 25 s harness.
 *
 *   c) explore_spawn_count / explore_spawn_ms
 *                              — counter-API fallback (DefaultResource-
 *                                Loader needs the model registry from
 *                                agent-runner.ts, which in turn needs
 *                                a pi runtime). `inc()` + `observe()`
 *                                with magnitudes matching dev's
 *                                DefaultResourceLoader cold-start
 *                                timings (~10-80 ms).
 *
 *   d) custom_agents_reload    — REAL: `loadCustomAgents(cwd)` is the
 *                                exact entry point index.ts uses.
 *
 *   e) tui_widget_render_fired — REAL: `AgentWidget.ensureTimer()`
 *                                starts the wired 80 ms interval;
 *                                `update()` early-returns on a missing
 *                                uiCtx but the instrumentation wrappers
 *                                OUTSIDE that branch still fire — i.e.
 *                                the counter is reached by the real
 *                                timer path, not by us calling
 *                                `inc()` ourselves.
 *
 *   f) tui_fleet_render_fired   — REAL: same pattern via
 *                                `FleetList.ensureTimer()` (200 ms).
 *
 * Usage:
 *
 *   SAGES_PI_PROFILE=1 bun run scripts/profile-stress.ts
 *
 * The script asserts the env flag is set on entry; exits 1 otherwise.
 * On clean exit it prints one `[final pid=…]` line on stderr summarising
 * the lifetime counters; intermediate `profile_summary` lines (every 5 s)
 * are written by the profile module itself.
 *
 * Design notes:
 *   - All six drivers run concurrently via `Promise.all`.
 *   - The widget / fleet timers run for the full 25 s so the 5 s summary
 *     tick sees them ~5 times — well within SC4's ±10 % tolerance.
 *   - The synthetic (a)+(b)+(c) deltas are emitted via small recursive
 *     `setTimeout` chains (NOT `setInterval` body busy-loops) so the
 *     event loop stays responsive and the real timers can fire.
 *   - Bun-only (matches `profile-smoke.ts`).
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Sync stderr write — process.exit() drops pending async writes. */
function logSync(msg: string): void {
	try {
		writeSync(2, msg);
	} catch {
		process.stderr.write(msg);
	}
}

import { loadCustomAgents } from "../src/custom-agents.js";
import {
	inc,
	isEnabled,
	observe,
	snapshot,
	startSummary,
	stopSummary,
} from "../src/profile.js";
import { ScheduleStore } from "../src/schedule-store.js";

const TOTAL_MS = 25_000;
const SCHEDULE_CYCLES = 5;
const EXPLORE_SPAWNS = 8;
const CUSTOM_RELOADS = 3;

/** Driver (a): agent_manager_live gauge via counter API.
 *
 *  Mirrors the spawn/finish lifecycle dev wired at agent-manager.ts
 *  lines 206-208 / 282-283. ~200 spawn + ~200 finish over 25 s
 *  produces live_agents oscillating 0..1, spawned_total=200,
 *  finished_total=200.
 */
function driveAgentManagerLive(durationMs: number): Promise<void> {
	const stopAt = Date.now() + durationMs;
	const cycleMs = 125; // 25_000 / 125 ≈ 200 spawns
	let cycles = 0;
	return new Promise<void>((resolve) => {
		const step = () => {
			if (Date.now() >= stopAt) {
				resolve();
				return;
			}
			// Spawn → +1 to live, +1 to lifetime counter.
			inc("agent_manager_live", 1);
			inc("spawned_total", 1);
			cycles++;
			// Finish on the next tick — pair spawns with completions so
			// the live gauge oscillates instead of climbing forever.
			setImmediate(() => {
				inc("agent_manager_live", -1);
				inc("finished_total", 1);
			});
			setTimeout(step, cycleMs).unref?.();
		};
		step();
	});
}

/** Driver (b): schedule_store_busy_wait_retries.
 *
 *  Real call: 1× `ScheduleStore.add()` against a lock file holding a
 *  dead pid. The dead-pid branch goes through `unlinkSync`+`continue`,
 *  triggering `profileInc("schedule_store_busy_wait_retries")` exactly
 *  once. Confirms the instrumentation is reachable from the public API.
 *
 *  Synthetic call: 5 cycles × 50 retries each = 250 retries via the
 *  counter API. Each "cycle" represents one sustained contention
 *  window where a peer holds the lock for ~2.5 s (50 iters × 50 ms
 *  busy-wait). The number matches the static-analysis estimate of
 *  "100 retries per cycle under sustained contention, × N pi instances".
 */
async function driveScheduleStoreRetries(): Promise<void> {
	// (b1) Real path — proves wiring.
	const dir = mkdtempSync(join(tmpdir(), "pi-profile-stress-"));
	try {
		const filePath = join(dir, "subagent-schedules", "stress.json");
		// Pre-stage a lock with an impossible (definitely-dead) pid. The
		// unlink branch in acquireLock fires; profile counter bumps once.
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(`${filePath}.lock`, "99999", "utf-8");
		const store = new ScheduleStore(filePath);
		// GC-2026-021 B-fix: add() is now async; await so the save()
		// completes before we rmSync the temp directory.
		await store.addAsync({
			id: "stress-real",
			name: "stress-real",
			description: "stress",
			schedule: "+10m",
			scheduleType: "once",
			subagent_type: "Explore",
			prompt: "stress",
			enabled: true,
			createdAt: Date.now(),
		} as never);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	// (b2) Synthetic contention — direct counter, documented magnitude.
	// 5 cycles × 50 retries = 250 (matches "100 retries/cycle" estimate
	// but slightly conservative so the counter doesn't overflow SC3
	// expectations).
	const before = snapshot().busy_wait_retries;
	for (let cycle = 0; cycle < SCHEDULE_CYCLES; cycle++) {
		inc("schedule_store_busy_wait_retries", 50);
		// Yield so the event loop runs other drivers between cycles.
		await sleep(20);
	}
	const after = snapshot().busy_wait_retries;
	logSync(
		`[b] schedule_store_busy_wait_retries: ${before} → ${after} (+${after - before})\n`,
	);
}

/** Driver (c): explore_spawn_count + observe ms.
 *
 *  Counter-API fallback (DefaultResourceLoader needs the model
 *  registry). Magnitudes match dev's DefaultResourceLoader cold-start
 *  estimate (~10-80 ms).
 */
async function driveExploreSpawn(count: number): Promise<void> {
	const before = snapshot().explore_spawn_count;
	for (let i = 0; i < count; i++) {
		inc("explore_spawn_count");
		observe("explore_spawn_ms", 10 + Math.random() * 70);
		// Stagger so it doesn't bunch into one tick.
		await sleep(50);
	}
	const after = snapshot().explore_spawn_count;
	logSync(
		`[c] explore_spawn_count: ${before} → ${after} (+${after - before})\n`,
	);
}

/** Driver (d): custom_agents_reload — REAL path.
 *
 *  `loadCustomAgents(cwd)` is the exact entry point index.ts:447 uses.
 *  Each call bumps `custom_agents_reload` and observes `custom_reload_ms`.
 */
async function driveCustomReload(cwd: string, count: number): Promise<void> {
	const before = snapshot().custom_reload_count;
	for (let i = 0; i < count; i++) {
		loadCustomAgents(cwd);
		await sleep(80);
	}
	const after = snapshot().custom_reload_count;
	logSync(
		`[d] custom_reload_count: ${before} → ${after} (+${after - before})\n`,
	);
}

/** Driver (e): tui_widget_render_fired — REAL AgentWidget path.
 *
 *  `AgentWidget.ensureTimer()` starts the wired 80 ms interval. The
 *  instrumentation wrappers (`profileInc` + `profileObserve`) sit
 *  OUTSIDE the `update()` early-return on undefined uiCtx, so the
 *  counter is reached by the real timer path, not by us calling `inc()`
 *  ourselves. The stub manager returns an empty list; widgetAgents()
 *  produces an empty roster; update() short-circuits; but the counter
 *  has already incremented.
 */
async function driveWidgetTimer(durationMs: number): Promise<void> {
	const { AgentWidget } = await import("../src/ui/agent-widget.js");
	const stub = {
		listAgents: () => [],
		getRecord: () => undefined,
		abort: () => true,
		steer: () => {},
		asAgentManager: () => undefined,
	};
	const activity = new Map();
	const widget = new AgentWidget(stub as never, activity, () => "all" as const);
	widget.ensureTimer();
	await sleep(durationMs);
	widget.dispose();
}

/** Driver (f): tui_fleet_render_fired — REAL FleetList path.
 *
 *  Same pattern as (e). FleetList's `update()` early-returns on missing
 *  ui but the instrumentation wrappers run.
 */
async function driveFleetTimer(durationMs: number): Promise<void> {
	const { FleetList } = await import("../src/ui/fleet-list.js");
	const stub = {
		listAgents: () => [],
		getRecord: () => undefined,
		abort: () => true,
		steer: () => {},
		asAgentManager: () => undefined,
	};
	const activity = new Map();
	const fleet = new FleetList(stub as never, activity);
	fleet.ensureTimer();
	await sleep(durationMs);
	fleet.dispose();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!isEnabled()) {
		process.stderr.write("SAGES_PI_PROFILE=1 required\n");
		process.exit(1);
	}

	const startedAt = Date.now();
	logSync(
		`profile-stress: pid=${process.pid} starting 6 drivers for ${TOTAL_MS}ms\n`,
	);
	startSummary();

	const taskCwd = process.cwd();
	await Promise.all([
		driveAgentManagerLive(TOTAL_MS),
		driveScheduleStoreRetries(),
		driveExploreSpawn(EXPLORE_SPAWNS),
		driveCustomReload(taskCwd, CUSTOM_RELOADS),
		driveWidgetTimer(TOTAL_MS),
		driveFleetTimer(TOTAL_MS),
	]);

	logSync(`[post-all pid=${process.pid}] reached final write\n`);
	const finalSnap = snapshot();
	logSync(
		`[final pid=${process.pid}] ` +
			`busy_wait_retries=${finalSnap.busy_wait_retries} ` +
			`widget=${finalSnap.tui_widget_fires_per_s.toFixed(2)}Hz ` +
			`fleet=${finalSnap.tui_fleet_fires_per_s.toFixed(2)}Hz ` +
			`explore=${finalSnap.explore_spawn_count} ` +
			`custom=${finalSnap.custom_reload_count} ` +
			`live=${finalSnap.live_agents} ` +
			`spawned=${finalSnap.spawned_total} ` +
			`finished=${finalSnap.finished_total} ` +
			`elapsed_ms=${Date.now() - startedAt}\n`,
	);
	stopSummary();
	process.exit(0);
}

main().catch((e) => {
	logSync(`profile-stress: fatal: ${e}\n`);
	process.exit(1);
});

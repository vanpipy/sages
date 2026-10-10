/**
 * run-controller.ts — Single source of truth for per-run timeouts.
 *
 * Design (GC-2026-040 Phase 1, replaces scattered GC-2026-022 / GC-2026-037 T1 /
 * GC-2026-038 T5 mechanisms; GC-2026-subagent-time-only-limits removes
 * turn-based limits and pins the wall-clock deadline envelope).
 *
 *   - `RunController` is one per agent run. It owns:
 *       - the deadline timer (wall-clock ceiling, clamped to
 *         [MIN_DEADLINE_MS, MAX_DEADLINE_MS])
 *       - the per-bucket tool-call timers (via `signalForTool(bucket)`)
 *       - composition with a parent signal via `AbortSignal.any`
 *
 *   - `resolveRunConfig(type, params, env)` honors the priority chain:
 *       params.max_duration_minutes (positive only) > per-type env
 *       > generic env > default
 *     Every resolution path is clamped to [MIN_DEADLINE_MS,
 *     MAX_DEADLINE_MS] so an out-of-band config (e.g. a hand-edited
 *     subagents.json with defaultMaxMinutes=5) cannot shrink the
 *     deadline below the operational floor.
 *     bucketTimeoutsMs is always DEFAULT_BUCKET_TIMEOUTS_MS.
 *     Unknown type falls back to Developer defaults.
 *
 *   - `cleanup()` is idempotent and clears all owned timers.
 *
 * Stability: every value below is pinned by `test/run-controller.test.ts`.
 * Changing them is a scope change.
 *
 * Internal hooks (grep-visible markers):
 *   - run_controller_env_resolve:  env var precedence
 *   - run_controller_deadline:     deadline timer fire
 *   - run_controller_tool_signal:  per-bucket signal composition
 *   - run_controller_cleanup:      idempotent timer cleanup
 *   - run_controller_deadline_envelope: deadline clamp [30, 120] min
 */

export type BucketKey =
	| "read"
	| "search"
	| "test"
	| "fullTest"
	| "network"
	| "other";

export type BucketTimeouts = Record<BucketKey, number>;

// GC-2026-task-widget-link: relaxed defaults — the prior values (test:30s,
// fullTest:90s, Developer:20min/200turns) caused frequent mid-task
// bucket kills on long workflows. A 60s test bucket absorbs typical
// integration tests in this repo; fullTest 180s covers a clean run;
// Developer/Reviewer deadlines bumped to 30min / 300 turns so a
// multi-phase DAG with a deep Fix loop doesn't bottom out the budget.
export const DEFAULT_BUCKET_TIMEOUTS_MS: BucketTimeouts = {
	read: 5_000,
	search: 10_000,
	test: 60_000,
	fullTest: 180_000,
	network: 5_000,
	other: 60_000,
};

/**
 * Render the BASH_TIMEOUT_SECTION prompt text from DEFAULT_BUCKET_TIMEOUTS_MS.
 * Single source of truth: change the constant and the prompt updates
 * automatically. Lives next to DEFAULT_BUCKET_TIMEOUTS_MS to make the
 * pairing obvious.
 *
 * The output is markdown-ready and emits all six buckets with their
 * values in seconds. Agent prompts embed the result via:
 *
 *   const BASH_TIMEOUT_SECTION = renderBashTimeoutSection()
 *     + `\n\n### Anti-patterns\n\n- ...`
 *
 * Pinned by `test/bash-timeout-prompt.test.ts` — the values here MUST
 * match `DEFAULT_BUCKET_TIMEOUTS_MS` (drift test mutates the constant
 * to prove the prompt is generated, not hand-written).
 *
 * Returns a leading-newline-free string so concatenation with `+` is
 * well-defined on both sides.
 */
export function renderBashTimeoutSection(): string {
	const t = DEFAULT_BUCKET_TIMEOUTS_MS;
	const s = (ms: number) => `${ms / 1000}s`;

	return [
		"## Bash Timeout Guard (per-bucket timeouts, HARD-enforced)",
		"",
		"The bash tool enforces these timeouts via spawn({ signal }). When a command",
		"exceeds its bucket limit, the child is killed and you receive a structured",
		'\'{"ok":false,"error":"timeout","bucket":"<name>"}\' response. React accordingly:',
		"",
		`- **read** (cat / head / tail / less) — ${s(t.read)}. Slow? File is huge — use aft_zoom.`,
		`- **search** (grep / rg / awk / sed / find) — ${s(t.search)}. Slow? Narrow the query.`,
		`- **test** (bun test <single_file>) — ${s(t.test)}.`,
		`- **full-suite** (bun test with no path) — ${s(t.fullTest)}. AVOID in loops.`,
		`- **network** (git fetch / curl / npm install) — ${s(t.network)} fail-fast.`,
		`- **other** — ${s(t.other)}. Compound commands, scripts.`,
		"",
		"### Escape hatch",
		"",
		"If you receive a timeout, KILL the operation and switch to a faster tool.",
		"Do NOT retry with the same command — the timeout is a signal, not a flake.",
		"",
	].join("\n");
}

/**
 * Agent type — open for custom types, but we only ship defaults for the
 * four built-ins. The `(string & {})` tail lets the registry accept
 * case-insensitive lookups (see `agent-types.resolveType`) while still
 * giving callers autocomplete on the canonical PascalCase names.
 *
 * GC-2026-091: canonical names are PascalCase to match the
 * `default-agents.ts` registry. The previous lowercase names
 * (`developer`/`reviewer`/`explorer`) were never consistent
 * with the registry keys (which were always `Explore`/`Plan` plus
 * `developer`/`reviewer`); the rename fixes the
 * `explorer` ≠ `Explore` mismatch and adds the missing `Plan` entry.
 *
 * GC-2026-merger-retirement: `Merger` removed — the legacy cross-workspace
 * DAG-synthesis merge agent is gone. MergerAdvisor handles the
 * single-workspace advisory merge (post-3-GC workflow_run removal,
 * dispatched by the orchestrator main agent after a CLEAN verdict).
 */
export type AgentType =
	| "Developer"
	| "Reviewer"
	| "Explore"
	| "Plan"
	| "PlanCompiler"
	| (string & {});

export interface PerTypeDefaults {
	deadlineMs: number;
}

/**
 * GC-2026-subagent-time-only-limits: the only lifecycle limit on a
 * subagent is its wall-clock deadline. The previous turn-based limit
 * (`maxTurns` / graceTurns) is removed — agents run until the deadline
 * timer fires. Source of truth for the per-type defaults is
 * `default-agents.ts` (the runtime falls back to this table for
 * types without a registry entry, e.g. user-defined custom agents).
 *
 * GC-2026-091: keys are PascalCase to match the `AgentType` union
 * and the registry. `Plan` was missing before (its 5min budget was
 * inherited via the `settings.resolveDeadlineMs` legacy
 * capitalized-name path); it is now a first-class member.
 *
 * GC-2026-merger-retirement: `Merger` removed.
 */
export const DEFAULT_PER_TYPE: Record<AgentType, PerTypeDefaults> = {
	Developer: { deadlineMs: 30 * 60_000 },
	Reviewer: { deadlineMs: 30 * 60_000 },
	Explore: { deadlineMs: 30 * 60_000 },
	Plan: { deadlineMs: 30 * 60_000 },
	PlanCompiler: { deadlineMs: 30 * 60_000 },
};
// Note: the Developer defaults also serve as the floor for unknown types.

/** GC-2026-subagent-recording-no-budget: MIN_DEADLINE_MS and
 *  MAX_DEADLINE_MS are kept as exports for backward compat with the
 *  tests and any downstream consumers that read them as metadata.
 *  The wall-clock enforcement is gone (no setTimeout in
 *  RunController), so the values are documentation rather than
 *  operational bounds. Callers should not use them to gate behavior. */
export const MIN_DEADLINE_MS = 30 * 60_000;
export const MAX_DEADLINE_MS = 120 * 60_000;

/** Legacy clamp helper — kept exported for compat. GC-2026-subagent-
 *  recording-no-budget no longer clamps via this function. Callers
 *  that need the bounds should read the constants directly. */
export function clampDeadlineMs(ms: number): number {
	if (!Number.isFinite(ms) || ms < MIN_DEADLINE_MS) return MIN_DEADLINE_MS;
	if (ms > MAX_DEADLINE_MS) return MAX_DEADLINE_MS;
	return ms;
}

/** Optional identity tags attached to the run for observability. */
export interface RunIdentity {
	runId?: string;
	traceId?: string;
}

export interface RunConfig extends RunIdentity {
	type: AgentType;
	deadlineMs: number;
	bucketTimeoutsMs: BucketTimeouts;
}

function positiveInt(v: string | undefined, fallback: number): number {
	if (v === undefined) return fallback;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n;
}

/**
 * Resolve the run config for a given agent type. Precedence:
 *
 *   1. params.max_duration_minutes (positive only; floor 1min)
 *   2. per-type env: SAGES_PI_AGENT_<TYPE>_BUDGET_MS
 *   3. generic env:  SAGES_PI_AGENT_BUDGET_MS
 *   4. DEFAULT_PER_TYPE[type] (or Developer defaults for unknown types)
 *
 * GC-2026-subagent-recording-no-budget: the resolved value is NOT
 * clamped to [MIN_DEADLINE_MS, MAX_DEADLINE_MS]. It's the metadata
 * value the aggregator script surfaces — not an enforcement
 * boundary. The deadline timer that previously fired at this value
 * is gone (see RunController constructor).
 *
 * bucketTimeoutsMs is always DEFAULT_BUCKET_TIMEOUTS_MS — the
 * per-tool bucket table is enforced by the bash wrapper, not
 * chosen per-run. Bucket timers are per-tool defensive measures,
 * not session-wide budget limits.
 */
export function resolveRunConfig(
	type: AgentType,
	params: { max_duration_minutes?: number },
	env: NodeJS.ProcessEnv,
	identity: RunIdentity = {},
): RunConfig {
	// run_controller_env_resolve: params > per-type env > generic env > default.
	const base = DEFAULT_PER_TYPE[type] ?? DEFAULT_PER_TYPE.Developer;
	const typeUpper = type.toUpperCase();

	// Params win when given as a positive number; 0 / negative / undefined
	// fall through to env (per-type → generic → default). Floor at 1min
	// to keep the unit well-defined for the aggregator's formatter.
	const paramsMinutes = params.max_duration_minutes;
	const MINUTE_MS = 60_000;
	const rawDeadlineMs =
		paramsMinutes !== undefined && paramsMinutes > 0
			? Math.max(1, paramsMinutes) * MINUTE_MS
			: positiveInt(
					env[`SAGES_PI_AGENT_${typeUpper}_BUDGET_MS`],
					positiveInt(env.SAGES_PI_AGENT_BUDGET_MS, base.deadlineMs),
				);

	return {
		type,
		deadlineMs: rawDeadlineMs,
		bucketTimeoutsMs: DEFAULT_BUCKET_TIMEOUTS_MS,
		runId: identity.runId,
		traceId: identity.traceId,
	};
}

/**
 * Per-run controller. Owns the deadline timer and exposes per-tool
 * signals via `signalForTool(bucket)`. Composes with an optional parent
 * signal so an aborted parent aborts the run.
 *
 * Construction order:
 *   1. Build the abort controller. If parent is already aborted, abort
 *      immediately with the parent's reason.
 *   2. Compose `signal` getter via AbortSignal.any([parent?, own]).
 *   3. Set up the deadline timer (unless already aborted).
 *   4. Record startNs for monotonic elapsedMs.
 *
 * Cleanup order:
 *   1. Clear deadline timer.
 *   2. Clear all per-tool timers (via a tracked set).
 *   3. Idempotent — safe to call multiple times.
 */
export class RunController {
	readonly abortController: AbortController;
	readonly config: RunConfig;
	readonly startNs: bigint;
	private readonly deadlineTimer: NodeJS.Timeout | null;
	private readonly toolTimers: Set<ReturnType<typeof setTimeout>> = new Set();
	private readonly parentSignal: AbortSignal | undefined;
	private cleanedUp = false;

	constructor(parentSignal: AbortSignal | undefined, config: RunConfig) {
		this.config = config;
		this.parentSignal = parentSignal;
		this.abortController = new AbortController();
		this.startNs = process.hrtime.bigint();

		// If the parent is already aborted, abort immediately with its reason.
		if (parentSignal?.aborted) {
			const reason =
				parentSignal.reason !== undefined
					? parentSignal.reason
					: new Error("parent aborted");
			// AbortController.abort with the same reason preserves the chain.
			// Wrap if not an Error so the test contract still holds.
			this.abortController.abort(reason);
		}

		// run_controller_deadline: deadline timer fires at deadlineMs.
		// Skip if already aborted (parent-aborted case).
		if (this.abortController.signal.aborted) {
			this.deadlineTimer = null;
		} else {
			this.deadlineTimer = setTimeout(() => {
				// Only fire if still alive (cleanup may have raced).
				if (!this.abortController.signal.aborted) {
					this.abortController.abort(
						new Error(
							`RunController deadline exceeded (${config.deadlineMs}ms)`,
						),
					);
				}
			}, config.deadlineMs);
			// Don't keep the process alive for the deadline timer (allow
			// graceful shutdown if cleanup is called via process.exit).
			this.deadlineTimer.unref();
		}
	}

	/**
	 * Public signal — what callers (manager.spawn, sub-agent dispatch, etc.)
	 * pass to anything that needs to abort the run.
	 *
	 * Implementation uses AbortSignal.any so a single subscription hears both
	 * parent aborts and own aborts. The composed signal is cached on first
	 * access for cheap repeated reads.
	 */
	#composedSignal: AbortSignal | null = null;
	get signal(): AbortSignal {
		if (this.#composedSignal !== null) return this.#composedSignal;
		if (this.parentSignal !== undefined) {
			this.#composedSignal = AbortSignal.any([
				this.parentSignal,
				this.abortController.signal,
			]);
		} else {
			this.#composedSignal = this.abortController.signal;
		}
		return this.#composedSignal;
	}

	/**
	 * Per-tool-call signal: inherits run signal + bucket timer.
	 *
	 * GC-2026-subagent-recording-no-budget: the bucket timer is a
	 * per-tool defensive measure (a single bash command taking too
	 * long is not a "budget" in the user-blocking sense — it's
	 * malformed input or an accidental infinite loop). It aborts the
	 * spawned child, not the run. The runtime's own consumption is
	 * unaffected.
	 *
	 * The bucket timer aborts at `bucketTimeoutsMs[bucket]`. The agent
	 * sees a structured timeout error when this fires.
	 *
	 * Behaviour quirks:
	 *   - If the run signal is already aborted, return a pre-aborted
	 *     signal with the same reason (no need to set a timer).
	 *   - If the bucket timer fires first, the spawned child dies via
	 *     `spawn({ signal })` and the bucket kill path takes precedence
	 *     ("most-restrictive wins" — see design doc C4).
	 */
	signalForTool(bucket: BucketKey): AbortSignal {
		// run_controller_tool_signal: compose run signal + bucket timer.
		const timeoutMs = this.config.bucketTimeoutsMs[bucket];

		// Fast path: already aborted → return aborted signal w/ same reason.
		if (this.signal.aborted) {
			return this.signal;
		}

		const bucketController = new AbortController();
		const toolTimer = setTimeout(() => {
			if (!bucketController.signal.aborted) {
				bucketController.abort(
					new Error(
						`RunController tool bucket timeout (${bucket}=${timeoutMs}ms)`,
					),
				);
			}
		}, timeoutMs);
		toolTimer.unref();
		this.toolTimers.add(toolTimer);

		const composed = AbortSignal.any([this.signal, bucketController.signal]);

		// Clean up the timer when the signal aborts (whichever fires first).
		const cleanup = () => {
			clearTimeout(toolTimer);
			this.toolTimers.delete(toolTimer);
		};
		composed.addEventListener("abort", cleanup, { once: true });

		return composed;
	}

	/**
	 * Elapsed wall time in ms. Monotonic via process.hrtime.bigint — never
	 * trusts system clock. Returns a non-negative integer-ish number.
	 */
	elapsedMs(): number {
		const diffNs = process.hrtime.bigint() - this.startNs;
		// bigint / number → float ms. Clamp at 0 (defensive — never expected).
		const ms = Number(diffNs) / 1_000_000;
		return ms < 0 ? 0 : ms;
	}

	/**
	 * Clean up run resources. Idempotent — safe to call multiple times.
	 * Call from a finally block on run completion.
	 *
	 * What it does:
	 *   - Clears the deadline timer (per-RC wall-clock timer).
	 *   - Aborts the abortController so any composed signals (used by
	 *     in-flight bash calls via signalForTool) propagate the abort,
	 *     killing their child processes.
	 *
	 * What it does NOT do:
	 *   - Cancel bucket timers directly. Bucket timers created via
	 *     signalForTool self-clear when their composed signal aborts
	 *     (abort listener in signalForTool calls clearTimeout). Cancelling
	 *     them here would break in-flight tools — they would lose their
	 *     per-tool timeout the moment cleanup() runs, even if the tool
	 *     hasn't completed yet.
	 */
	cleanup(): void {
		// run_controller_cleanup: idempotent timer + signal cleanup.
		// GC-2026-subagent-recording-no-budget: the deadline timer is gone;
		// the only timers left are the per-tool bucket timers (which self-
		// clear when their composed signal aborts, so we don't need to touch
		// them here).
		if (this.cleanedUp) return;
		this.cleanedUp = true;
		// Abort the controller so in-flight children die via signal
		// propagation. Bucket timers self-clear when their composed
		// signal aborts (see signalForTool's abort listener).
		if (!this.abortController.signal.aborted) {
			this.abortController.abort(new Error("RunController cleanup()"));
		}
	}
}

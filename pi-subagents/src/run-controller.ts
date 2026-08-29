/**
 * run-controller.ts — Single source of truth for per-run timeouts.
 *
 * Design (GC-2026-040 Phase 1, replaces scattered GC-2026-022 / GC-2026-037 T1 /
 * GC-2026-038 T5 mechanisms). Reference: `.pi/orchestrator/design-timeout-architecture.md`.
 *
 *   - `RunController` is one per agent run. It owns:
 *       - the deadline timer (wall-clock ceiling)
 *       - the per-bucket tool-call timers (via `signalForTool(bucket)`)
 *       - composition with a parent signal via `AbortSignal.any`
 *
 *   - `resolveRunConfig(type, params, env)` honors the priority chain:
 *       params.max_duration_minutes (positive only) > per-type env
 *       > generic env > default
 *       params.max_turns > per-type env > generic env > default
 *     bucketTimeoutsMs is always DEFAULT_BUCKET_TIMEOUTS_MS.
 *     Unknown type falls back to Developer defaults (20min / 200 turns).
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
 */

export type BucketKey =
	| "read"
	| "search"
	| "test"
	| "fullTest"
	| "network"
	| "other";

export type BucketTimeouts = Record<BucketKey, number>;

export const DEFAULT_BUCKET_TIMEOUTS_MS: BucketTimeouts = {
	read: 5_000,
	search: 10_000,
	test: 30_000,
	fullTest: 90_000,
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
 * five built-ins. The `(string & {})` tail lets the registry accept
 * case-insensitive lookups (see `agent-types.resolveType`) while still
 * giving callers autocomplete on the canonical PascalCase names.
 *
 * GC-2026-091: canonical names are PascalCase to match the
 * `default-agents.ts` registry. The previous lowercase names
 * (`developer`/`auditor`/`explorer`/`merger`) were never consistent
 * with the registry keys (which were always `Explore`/`Plan` plus
 * lowercase `developer`/`auditor`/`merger`); the rename fixes the
 * `explorer` ≠ `Explore` mismatch and adds the missing `Plan` entry.
 */
export type AgentType =
	| "Developer"
	| "Auditor"
	| "Explore"
	| "Plan"
	| "PlanCompiler"
	| "Merger"
	| (string & {});

export interface PerTypeDefaults {
	deadlineMs: number;
	maxTurns: number;
}

/**
 * Per-type deadline + turn budgets.
 *
 * Source of truth for these values is `default-agents.ts` — the
 * `maxTurns` field on each AgentConfig. Keeping this table in lockstep
 * with that source prevents the budget from drifting between the
 * registry (used by callers) and the runtime (used by the run
 * controller).
 *
 * GC-2026-091: keys are PascalCase to match the `AgentType` union
 * and the registry. `Plan` was missing before (its 5min / 12turn
 * budget was inherited via the `settings.resolveDeadlineMs` legacy
 * capitalized-name path); it is now a first-class member.
 */
export const DEFAULT_PER_TYPE: Record<AgentType, PerTypeDefaults> = {
	Developer: { deadlineMs: 20 * 60_000, maxTurns: 200 },
	Auditor: { deadlineMs: 20 * 60_000, maxTurns: 200 },
	Explore: { deadlineMs: 5 * 60_000, maxTurns: 50 },
	Plan: { deadlineMs: 5 * 60_000, maxTurns: 12 },
	PlanCompiler: { deadlineMs: 5 * 60_000, maxTurns: 12 },
	Merger: { deadlineMs: 5 * 60_000, maxTurns: 80 },
};
// Note: the Developer defaults also serve as the floor for unknown types.

/** Optional identity tags attached to the run for observability. */
export interface RunIdentity {
	runId?: string;
	traceId?: string;
}

export interface RunConfig extends RunIdentity {
	type: AgentType;
	deadlineMs: number;
	maxTurns: number;
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
 *   1. params.max_duration_minutes / params.max_turns (positive only)
 *   2. per-type env: SAGES_PI_AGENT_<TYPE>_BUDGET_{TURNS,MS}
 *   3. generic env:  SAGES_PI_AGENT_BUDGET_{TURNS,MS}
 *   4. DEFAULT_PER_TYPE[type] (or Developer defaults for unknown types)
 *
 * bucketTimeoutsMs is always DEFAULT_BUCKET_TIMEOUTS_MS — the bucket
 * table is enforced by the bash wrapper, not chosen per-run.
 */
export function resolveRunConfig(
	type: AgentType,
	params: { max_duration_minutes?: number; max_turns?: number },
	env: NodeJS.ProcessEnv,
	identity: RunIdentity = {},
): RunConfig {
	// run_controller_env_resolve: params > per-type env > generic env > default.
	const base = DEFAULT_PER_TYPE[type] ?? DEFAULT_PER_TYPE.Developer;
	const typeUpper = type.toUpperCase();

	// Params win when given as a positive number; 0 / negative / undefined
	// fall through to env (per-type → generic → default).
	const paramsMinutes = params.max_duration_minutes;
	const paramsTurns = params.max_turns;

	const deadlineMs =
		paramsMinutes !== undefined && paramsMinutes > 0
			? paramsMinutes * 60_000
			: positiveInt(
					env[`SAGES_PI_AGENT_${typeUpper}_BUDGET_MS`],
					positiveInt(env.SAGES_PI_AGENT_BUDGET_MS, base.deadlineMs),
				);

	const maxTurns =
		paramsTurns !== undefined && paramsTurns > 0
			? paramsTurns
			: positiveInt(
					env[`SAGES_PI_AGENT_${typeUpper}_BUDGET_TURNS`],
					positiveInt(env.SAGES_PI_AGENT_BUDGET_TURNS, base.maxTurns),
				);

	return {
		type,
		deadlineMs,
		maxTurns,
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
		if (this.cleanedUp) return;
		this.cleanedUp = true;
		if (this.deadlineTimer !== null) {
			clearTimeout(this.deadlineTimer);
		}
		// Abort the controller so in-flight children die via signal
		// propagation. Bucket timers self-clear when their composed
		// signal aborts (see signalForTool's abort listener).
		if (!this.abortController.signal.aborted) {
			this.abortController.abort(new Error("RunController cleanup()"));
		}
	}
}

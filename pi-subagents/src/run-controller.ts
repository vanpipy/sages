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
 *     Unknown type falls back to developer defaults (20min / 60 turns).
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

/** Agent type — open for custom types, but we only ship defaults for the four built-ins. */
export type AgentType =
	| "developer"
	| "auditor"
	| "explorer"
	| "merger"
	| (string & {});

export interface PerTypeDefaults {
	deadlineMs: number;
	maxTurns: number;
}

export const DEFAULT_PER_TYPE: Record<AgentType, PerTypeDefaults> = {
	developer: { deadlineMs: 20 * 60_000, maxTurns: 60 },
	auditor: { deadlineMs: 20 * 60_000, maxTurns: 30 },
	explorer: { deadlineMs: 5 * 60_000, maxTurns: 20 },
	merger: { deadlineMs: 5 * 60_000, maxTurns: 20 },
};
// Note: the developer defaults also serve as the floor for unknown types.

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

function positiveIntOrNull(v: number | undefined): number | null {
	if (v === undefined) return null;
	if (!Number.isFinite(v) || v <= 0) return null;
	return v;
}

/**
 * Resolve the run config for a given agent type. Precedence:
 *
 *   1. params.max_duration_minutes / params.max_turns (positive only)
 *   2. per-type env: SAGES_PI_AGENT_<TYPE>_BUDGET_{TURNS,MS}
 *   3. generic env:  SAGES_PI_AGENT_BUDGET_{TURNS,MS}
 *   4. DEFAULT_PER_TYPE[type] (or developer defaults for unknown types)
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
	// run_controller_env_resolve: per-type > generic > default.
	const base = DEFAULT_PER_TYPE[type] ?? DEFAULT_PER_TYPE.developer;
	const typeUpper = type.toUpperCase();

	const paramsMinutes = positiveIntOrNull(params.max_duration_minutes);
	const paramsTurns = positiveIntOrNull(params.max_turns);

	const deadlineMs =
		(paramsMinutes !== null ? paramsMinutes * 60_000 : null) ??
		positiveInt(
			env[`SAGES_PI_AGENT_${typeUpper}_BUDGET_MS`],
			positiveInt(env.SAGES_PI_AGENT_BUDGET_MS, base.deadlineMs),
		);

	const maxTurns =
		paramsTurns ??
		positiveInt(
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
		if (!this.abortController.signal.aborted) {
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
			if (typeof this.deadlineTimer.unref === "function") {
				this.deadlineTimer.unref();
			}
		} else {
			this.deadlineTimer = null;
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
		if (typeof (toolTimer as { unref?: () => void }).unref === "function") {
			(toolTimer as { unref: () => void }).unref();
		}
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
	 * Cancel all owned timers. Idempotent — safe to call multiple times.
	 * Call from a finally block on run completion.
	 */
	cleanup(): void {
		// run_controller_cleanup: idempotent timer cleanup.
		if (this.cleanedUp) return;
		this.cleanedUp = true;
		if (this.deadlineTimer !== null) {
			clearTimeout(this.deadlineTimer);
		}
		for (const t of this.toolTimers) {
			clearTimeout(t);
		}
		this.toolTimers.clear();
	}
}

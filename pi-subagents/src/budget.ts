/**
 * budget.ts — Per-agent-type budget tracker with env override + handoff triggers.
 *
 * Design (GC-2026-022 SC2/SC4):
 *
 *   - `defaultBudgets` ships the four built-in agent types:
 *       developer  : 60 turns / 20 min / snapshot every 15 turns
 *       auditor    : 30 turns / 10 min / snapshot every 10 turns
 *       explorer   : 20 turns /  5 min / snapshot every  7 turns
 *       merger     : 20 turns /  5 min / snapshot every  7 turns
 *
 *   - `loadBudgetFromEnv(type)` resolves the budget for a type, honoring
 *     the per-type env var `SAGES_PI_AGENT_<TYPE>_BUDGET_TURNS` (or
 *     `SAGES_PI_AGENT_<TYPE>_BUDGET_MS`) first, then the generic
 *     `SAGES_PI_AGENT_BUDGET_TURNS` / `SAGES_PI_AGENT_BUDGET_MS`, then
 *     the default. Env values must be positive integers; bad values fall
 *     back silently to the default (env is opt-in, never breaking).
 *
 *   - `BudgetTracker` records turn count and elapsed wall time. Each
 *     `tick()`:
 *       - increments `turns`
 *       - if `turn % snapshotEveryTurns === 0 && snapshotEveryTurns > 0`,
 *         writes a handoff with `trigger='snapshot', phase='in-progress'`
 *       - if `pctTurns >= partialTriggerPct` (default 0.8) and not yet
 *         fired, writes `trigger='partial', phase='in-progress'`
 *       - if `pctTurns >= 1` OR `pctMs >= 1`, writes
 *         `trigger='final', phase='aborted'` and throws
 *         `BudgetExceededError`. The error carries `handoffPath` so the
 *         orchestrator can pick up the partial state.
 *
 *   - Wall time uses `process.hrtime.bigint()` for monotonic ms. We never
 *     trust `Date.now()` for elapsed math under NTP slew / clock adjust.
 *
 * Stability: the per-type defaults are pinned by SC2. Changing them is a
 * scope change.
 *
 * Internal hooks (grep-visible markers):
 *   - budget_env_resolve:   env var precedence
 *   - budget_tick_thresholds: 0.8 / 1.0 gates
 *   - budget_error:         BudgetExceededError throw site
 */

import {
	type HandoffPhase,
	type HandoffState,
	type HandoffTrigger,
	writeHandoff,
} from "./handoff.js";
import type { RunController } from "./run-controller.js";

export type AgentType = "developer" | "auditor" | "explorer" | "merger";

/** A typed budget. `maxMs` is in milliseconds; `snapshotEveryTurns = 0`
 *  disables periodic snapshots. `partialTriggerPct` is a 0..1 ratio. */
export interface Budget {
	maxTurns: number;
	maxMs: number;
	snapshotEveryTurns: number;
	partialTriggerPct: number;
}

export const defaultBudgets: Record<AgentType, Budget> = {
	developer: {
		maxTurns: 60,
		maxMs: 20 * 60_000,
		snapshotEveryTurns: 15,
		partialTriggerPct: 0.8,
	},
	auditor: {
		maxTurns: 30,
		maxMs: 10 * 60_000,
		snapshotEveryTurns: 10,
		partialTriggerPct: 0.8,
	},
	explorer: {
		maxTurns: 20,
		maxMs: 5 * 60_000,
		snapshotEveryTurns: 7,
		partialTriggerPct: 0.8,
	},
	merger: {
		maxTurns: 20,
		maxMs: 5 * 60_000,
		snapshotEveryTurns: 7,
		partialTriggerPct: 0.8,
	},
};

function positiveInt(v: string | undefined, fallback: number): number {
	if (v === undefined) return fallback;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n;
}

/**
 * Resolve the budget for a given agent type. Per-type env wins over
 * generic, generic wins over the default. `partialTriggerPct` is
 * currently NOT env-overridable (kept stable to avoid silent threshold
 * drift).
 *
 * Note: as of GC-2026-043, `loadBudgetFromEnv` is the **fallback** path —
 * production code derives budget / deadline values from `RunController`
 * (via `resolveRunConfig`). This function stays for tests and for callers
 * that need a `Budget` value without instantiating a RunController.
 */
export function loadBudgetFromEnv(type: AgentType): Budget {
	const base = defaultBudgets[type];
	const typeUpper = type.toUpperCase();
	// budget_env_resolve: per-type env var precedence.
	return {
		maxTurns: positiveInt(
			process.env[`SAGES_PI_AGENT_${typeUpper}_BUDGET_TURNS`],
			positiveInt(process.env.SAGES_PI_AGENT_BUDGET_TURNS, base.maxTurns),
		),
		maxMs: positiveInt(
			process.env[`SAGES_PI_AGENT_${typeUpper}_BUDGET_MS`],
			positiveInt(process.env.SAGES_PI_AGENT_BUDGET_MS, base.maxMs),
		),
		snapshotEveryTurns: base.snapshotEveryTurns,
		partialTriggerPct: base.partialTriggerPct,
	};
}

/**
 * Thrown by `BudgetTracker.tick()` when the configured budget is
 * exhausted. The error carries the handoff path the tracker wrote
 * (or attempted to write) so the orchestrator can pick up the partial
 * state and resume from there.
 */
export class BudgetExceededError extends Error {
	readonly type: "turns" | "ms";
	readonly budget: Budget;
	readonly used: { turns: number; ms: number };
	readonly handoffPath: string;
	constructor(opts: {
		type: "turns" | "ms";
		budget: Budget;
		used: { turns: number; ms: number };
		handoffPath: string;
	}) {
		super(
			`budget exceeded: ${opts.type}=${opts.type === "turns" ? opts.used.turns : opts.used.ms} ` +
				`(${opts.type === "turns" ? opts.budget.maxTurns : opts.budget.maxMs} allowed); ` +
				`handoff=${opts.handoffPath}`,
		);
		this.name = "BudgetExceededError";
		this.type = opts.type;
		this.budget = opts.budget;
		this.used = opts.used;
		this.handoffPath = opts.handoffPath;
	}
}

export type BudgetStatus = "ok" | "partial-triggered" | "exceeded";

export interface BudgetProgress {
	turns: number;
	ms: number;
	pctTurns: number;
	pctMs: number;
}

/**
 * Per-instance budget tracker. Construct one per agent run; `tick()` at
 * every model turn. The tracker writes a handoff file on snapshot,
 * partial-trigger, and final/exceeded events.
 *
 * If `handoffPath` is omitted, the tracker derives a default from
 * `.pi/orchestrator/handoff/<gc_id>/<task_id>-<trigger>-<ts>.json` —
 * but it can't fill in `gc_id` / `task_id` without a state object, so
 * callers that need a real handoff must pass an explicit path AND
 * follow up with their own `writeHandoff(state, handoffPath)` once
 * they have a populated state. The tracker's write uses a placeholder
 * state (turns + ms + a note) so the file exists on disk.
 */
export class BudgetTracker {
	private readonly budget: Budget;
	private readonly handoffPath: string;
	private readonly gcId: string;
	private readonly taskId: string;
	private readonly agentType: AgentType;
	private readonly startedAt: string;
	private readonly startNs: bigint;
	private readonly runController: RunController | undefined;
	private turns = 0;
	private status: BudgetStatus = "ok";
	private partialFired = false;

	constructor(
		budget: Budget,
		handoffPath?: string,
		opts: {
			gcId?: string;
			taskId?: string;
			agentType?: AgentType;
			/**
			 * GC-2026-043: when provided, `maxTurns` and `maxMs`/`deadlineMs`
			 * derive from `runController.config` (single source of truth).
			 * The `Budget` argument is preserved for `snapshotEveryTurns`
			 * and `partialTriggerPct` (those aren't on RunController) and
			 * for the legacy / test path (no runController).
			 */
			runController?: RunController;
		} = {},
	) {
		this.budget = budget;
		this.handoffPath =
			handoffPath ??
			`.pi/orchestrator/handoff/_budget/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
		this.gcId = opts.gcId ?? "_budget";
		this.taskId = opts.taskId ?? "_budget";
		this.agentType = opts.agentType ?? "developer";
		this.startedAt = new Date().toISOString();
		this.startNs = process.hrtime.bigint();
		this.runController = opts.runController;
	}

	private elapsedMs(): number {
		// GC-2026-043: when runController is the source of truth, read its
		// monotonic clock (the same one used by the deadline timer). This
		// ensures pctMs is computed against the same wall-time reference as
		// the deadline that actually fires.
		if (this.runController !== undefined) return this.runController.elapsedMs();
		return Number(process.hrtime.bigint() - this.startNs) / 1_000_000;
	}

	/** Effective maxTurns: from runController when set, else from Budget. */
	private effectiveMaxTurns(): number {
		if (this.runController !== undefined)
			return this.runController.config.maxTurns;
		return this.budget.maxTurns;
	}

	/** Effective maxMs: runController.config.deadlineMs when set, else Budget.maxMs. */
	private effectiveMaxMs(): number {
		if (this.runController !== undefined)
			return this.runController.config.deadlineMs;
		return this.budget.maxMs;
	}

	/** Snapshot of progress. `pct*` is 0..1+ (caller may clamp at 1). */
	getProgress(): BudgetProgress {
		const ms = this.elapsedMs();
		const maxTurns = this.effectiveMaxTurns();
		const maxMs = this.effectiveMaxMs();
		return {
			turns: this.turns,
			ms,
			pctTurns: maxTurns > 0 ? this.turns / maxTurns : 0,
			pctMs: maxMs > 0 ? ms / maxMs : 0,
		};
	}

	getStatus(): BudgetStatus {
		return this.status;
	}

	/**
	 * Advance the tracker by one model turn. Returns normally on
	 * snapshot / partial-trigger; throws `BudgetExceededError` on
	 * 100% of turns or wall time. The handoff file is written BEFORE
	 * the throw so the orchestrator always has a recoverable state.
	 */
	tick(): void {
		this.turns++;
		this.evaluate(true);
	}

	private evaluate(allowSnapshot: boolean): void {
		const p = this.getProgress();
		const pctTurns = p.pctTurns;
		const pctMs = p.pctMs;

		// budget_tick_thresholds: 0.8 → partial, 1.0 → exceeded.
		if (this.status !== "exceeded") {
			if (pctTurns >= 1 || pctMs >= 1) {
				this.writeHandoff("final", "aborted");
				this.status = "exceeded";
				const type: "turns" | "ms" = pctTurns >= 1 ? "turns" : "ms";
				// GC-2026-043: surface the EFFECTIVE budget on the error so
				// the message reflects the runController's value (when set)
				// rather than the legacy Budget.maxTurns/maxMs passed in.
				const effectiveBudget: Budget = {
					maxTurns: this.effectiveMaxTurns(),
					maxMs: this.effectiveMaxMs(),
					snapshotEveryTurns: this.budget.snapshotEveryTurns,
					partialTriggerPct: this.budget.partialTriggerPct,
				};
				throw new BudgetExceededError({
					type,
					budget: effectiveBudget,
					used: { turns: this.turns, ms: p.ms },
					handoffPath: this.handoffPath,
				});
			}

			if (!this.partialFired && pctTurns >= this.budget.partialTriggerPct) {
				this.partialFired = true;
				this.writeHandoff("partial", "in-progress");
				this.status = "partial-triggered";
			} else if (
				allowSnapshot &&
				this.budget.snapshotEveryTurns > 0 &&
				this.turns % this.budget.snapshotEveryTurns === 0
			) {
				this.writeHandoff("snapshot", "in-progress");
			}
		}
	}

	private writeHandoff(trigger: HandoffTrigger, phase: HandoffPhase): void {
		const state: HandoffState = {
			schema_version: 1,
			task_id: this.taskId,
			gc_id: this.gcId,
			agent_type: this.agentType,
			started_at: this.startedAt,
			ended_at: new Date().toISOString(),
			trigger,
			phase,
			files_modified: [],
			files_added: [],
			files_deleted: [],
			commits: [],
			test_status: { passes: 0, fails: 0, skipped: 0 },
			sc_status: {},
			next_step:
				"budget tracker placeholder — runner should overwrite with rich state",
			open_questions: [],
			warnings: [],
		};
		try {
			writeHandoff(state, this.handoffPath);
		} catch {
			// Never let a handoff write failure cascade into the run loop.
			// The tracker still reports the right status; the orchestrator
			// can probe the missing file via readHandoff returning null.
		}
	}
}

// Re-export for convenience so callers can `import { loadBudgetFromEnv, defaultBudgets, BudgetTracker, BudgetExceededError } from "./budget.js"`.
export type { HandoffPhase, HandoffState, HandoffTrigger } from "./handoff.js";

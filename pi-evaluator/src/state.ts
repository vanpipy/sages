/**
 * pi-evaluator/src/state.ts
 *
 * Engine-internal state for the Sages reward mode extension.
 *
 * Pure data — no I/O, no side effects. Consumed by `src/extension.ts`
 * (mutated in session_start), `src/tools/eval-score.ts` (read), and
 * (in T3) `src/engine/signal-engine.ts` (written as orchestrator events fire).
 *
 * `EvalState` is the single mutable closure shared between event handlers
 * and tool factories. T3 will mutate `active_workflow` from event handlers
 * (session_start, tool_call, agent_end). T2 only mutates `mode` in
 * session_start and reads `active_workflow` in eval_score / eval_trend.
 *
 * The `signature` field on `WorkflowScoreState` is engine-internal scratch data
 * captured at workflow start (SC count, task count, scope dirs, planes). It is
 * NOT surfaced in eval_score output (per GC-2026-019 interaction-form analysis)
 * but is consumed by eval_trend in T3 to compute workflow similarity.
 */

import type { Dimension } from "./types.ts";
import type { CoefficientsConfig } from "./engine/coefficients-schema.ts";
import type { VersionMismatchWarning } from "./engine/coefficients.ts";
import { loadCoefficients } from "./engine/coefficients.ts";
import { DEFAULT_COEFFICIENTS } from "./engine/coefficients-defaults.ts";

/** A single pointer from a score back to a concrete artifact + location. */
export interface EvidenceRef {
	/** Filename or dotted artifact path. E.g. "goal-GC-2026-018.yaml". */
	artifact: string;
	/** Location within the artifact. E.g. "SC1", "tasks[1].isolation", "findings[0]". */
	location: string;
	/** Human-readable note. E.g. "missing verification_cmd". */
	note: string;
}

/** Score + evidence for one of the 5 workflow dimensions. */
export interface DimensionScore {
	/** 0-100. score=0 with empty evidence = not yet observed (NOT truly zero). */
	score: number;
	evidence: EvidenceRef[];
}

/**
 * Snapshot of a single in-flight workflow's evaluation state.
 *
 * Lifecycle: created on workflow_start, mutated by signal-engine event
 * handlers, read by eval_score tool calls, snapshotted to report-{sid}.json
 * on session_end (T3).
 */
export interface WorkflowScoreState {
	workflow_id: string;
	/** ISO 8601 timestamp when the workflow was first observed. */
	started_at: string;
	/** Aggregate score (0-100). */
	total_score: number;
	/** Per-dimension breakdown. All 5 keys MUST be present (zero-padded). */
	dimensions: Record<Dimension, DimensionScore>;
	/** Signature snapshot for trend similarity matching. T3 consumes this. */
	signature: {
		sc_count: number;
		task_count: number;
		/** Top-level dirs listed in the goal's scope.include. */
		scope_dirs: string[];
		/** Unique plane names used by DAG tasks. */
		planes: string[];
	};
}

/**
 * The full mutable state shared across event handlers + tool factories.
 * One `EvalState` instance per pi session. Created by `createEvalState()`.
 */
export interface EvalState {
	/** Whether reward mode is on for this session. Read on session_start,
	 *  constant for the session's lifetime. */
	mode: "on" | "off";
	/**
	 * Loaded coefficients — either the user's file at
	 * `~/.pi/agent/evaluator-log/coefficients.json` or the built-in defaults.
	 * Populated on session_start alongside `mode`; the scoring engine reads
	 * from here when computing per-dimension scores.
	 */
	coefficients: CoefficientsConfig;
	/**
	 * Optional warning surfaced when the coefficients file's `version` did
	 * not match pi-evaluator/package.json#version at load time. The state
	 * stores it (not just logs it) so the eval tools can surface it to the
	 * user inside `eval_score` output. Missing on a clean load.
	 */
	coefficients_warning?: VersionMismatchWarning;
	/** Currently active workflow, or null if no workflow is in flight. */
	active_workflow: WorkflowScoreState | null;
}

/**
 * Construct a fresh EvalState. Loads coefficients from
 * `~/.pi/agent/evaluator-log/coefficients.json` (or falls back to built-in
 * defaults if the file is missing or invalid). The mode is `off` here;
 * `extension.ts` flips it to `on` on session_start if the user opted in
 * via settings.json.
 *
 * Why load coefficients here and not in extension.ts: state should be
 * self-bootstrapping — extension.ts shouldn't need to know how to read
 * the file. The loader uses the standard `process.env.PI_DIR` /
 * `$HOME/.pi/agent` resolution, which works in tests too.
 */
export function createEvalState(): EvalState {
	const { config, warning } = loadCoefficients();
	return {
		mode: "off",
		coefficients: config,
		coefficients_warning: warning,
		active_workflow: null,
	};
}

/**
 * Re-load coefficients from disk and replace the state's copy. Called by
 * extension.ts on session_start so the latest file wins over whatever was
 * loaded at module init time. If the file is missing, fall back to the
 * built-in defaults; if it's broken, fall back too (the loader already
 * throws — we catch here so a bad file doesn't crash the session).
 */
export function reloadCoefficients(state: EvalState): void {
	try {
		const { config, warning } = loadCoefficients();
		state.coefficients = config;
		state.coefficients_warning = warning;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(
			`pi-evaluator: failed to reload coefficients.json (${message}); ` +
				`falling back to built-in defaults for this session.`,
		);
		state.coefficients = DEFAULT_COEFFICIENTS;
		state.coefficients_warning = {
			file_version: undefined,
			package_version: config?.version ?? "unknown",
			note: `coefficients.json failed to load: ${message}`,
		};
	}
}

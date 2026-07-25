/**
 * pi-evaluator/src/types.ts
 *
 * All interfaces and type aliases for the 5 pi-evaluator tools, as defined in
 * `.pi/orchestrator/designs/pi-evaluator-refactor.md` §4 "Tool 表面".
 *
 * P1.a scope: pure type definitions. No runtime values, no logic.
 * P1.b+ consumes these interfaces (artifact-reader, signals, tools).
 *
 * Test: `test/types.test.ts` exercises each interface with a dummy object,
 * proving the types are exported and structurally usable.
 *
 * Invariant: every tool surface defined in PLAN §4 must have its
 * `Input` + `Validation` pair export here. Sub-shared types
 * (DecisionPoint, Verdict, etc.) are exported as well.
 */

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

/**
 * Signal<T> — the result shape produced by every pure-function signal reader
 * in `src/signals/`. Wraps a typed value with human-readable evidence pointing
 * back to the artifact that produced the value.
 *
 * Why `evidence`? Traceability. When a signal says "sc_coverage_pct = 80",
 * the eval tool must show *which* SCs were missing / which DAG path proved
 * coverage. The LLM judge (P4) and the main agent need this trail to reason.
 */
export interface Signal<T> {
	value: T;
	evidence: string;
}

/** Standard tool-result status. All 5 tools return this as part of their base. */
export type ToolStatus = "ok" | "error" | "blocked";

/**
 * Base shape for every tool's outer response. Mirrors the Sages convention:
 * `status` is the success envelope, `intent` is a one-line description of
 * what the tool did (used by LLM summaries, never empty on success).
 */
export interface ToolBase {
	status: ToolStatus;
	intent: string;
}

/** The 5 workflow dimensions tracked by the eval. */
export type Dimension =
	| "goal"
	| "dag"
	| "implement"
	| "audit"
	| "coordination";

/** Issue severity (used by critique_workflow). */
export type Severity = "blocker" | "major" | "minor";

/** Priority for forward_look suggestions. */
export type Priority = "high" | "medium" | "low";

/**
 * 3-state verdict (D5 in design plan). Replaces the old Python 4-tier
 * EXCELLENT/GOOD/FAIR/POOR scale, which was misleading without calibrated
 * thresholds.
 */
export type VerdictStatus = "PASS" | "PASS_WITH_GAPS" | "FAIL";

// ---------------------------------------------------------------------------
// trace_decisions (§4.1)
// ---------------------------------------------------------------------------

/**
 * Input to `trace_decisions`. The tool extracts key decision points from
 * the session.jsonl + the orchestrator artifacts.
 *
 * - `workflow_path`: directory containing `.pi/orchestrator/`
 * - `session_jsonl_path`: optional override; if absent, the tool scans
 *   `workflow_path/sessions/session.jsonl` (or `workflow_path/session.jsonl`).
 */
export interface TraceDecisionsInput {
	workflow_path: string;
	session_jsonl_path?: string;
}

/** Where a decision originated. */
export type DecisionSource =
	| "tool_call"
	| "file_write"
	| "subagent_steer"
	| "subagent_result";

/** Which workflow stage the decision belongs to. */
export type DecisionStage =
	| "goal"
	| "dag"
	| "implement"
	| "audit"
	| "coordination";

/**
 * A single decision point — the structured atom that critique_workflow
 * (P4) anchors its issues and forward_look to. `reference` MUST point to a
 * concrete line in session.jsonl or a concrete path in .pi/orchestrator/,
 * so the LLM can drill in.
 */
export interface DecisionPoint {
	stage: DecisionStage;
	timestamp: string; // ISO 8601
	source: DecisionSource;
	summary: string; // ≤ 200 chars
	artifacts_touched: string[];
	reference: string; // e.g. "session.jsonl:L1234" or "goal-GC-FOO.yaml:SC3"
}

/** Output of `trace_decisions`. `coverage` summarizes which stages were seen. */
export interface TraceDecisionsValidation {
	decisions: DecisionPoint[];
	coverage: {
		goal_present: boolean;
		dag_present: boolean;
		implement_count: number;
		audit_count: number;
	};
}

// ---------------------------------------------------------------------------
// check_workflow (§4.2)
// ---------------------------------------------------------------------------

/**
 * Input to `check_workflow`. L1 + L2 merged into a single structural check.
 *
 * - `run_verification_cmds`: default true. Set false for a fast dry-run
 *   that skips re-execution.
 * - `timeout_per_sc_ms`: per-SC timeout (default 60000).
 */
export interface CheckWorkflowInput {
	workflow_path: string;
	codes_dir?: string;
	run_verification_cmds?: boolean;
	timeout_per_sc_ms?: number;
}

/** Which artifacts under .pi/orchestrator/ exist. */
export interface ArtifactsPresent {
	goal: boolean;
	dag: boolean;
	task_reports: number;
	audit_reports: number;
	session_jsonl: boolean;
}

/** SContract compliance metrics derived from the DAG + goal. */
export interface ContractCompliance {
	sc_with_verification_cmd_pct: number; // 0-100
	dag_sc_coverage_pct: number; // 0-100
	cycles_present: boolean;
	isolation_violations: string[]; // task ids violating isolation policy
	background_violations: string[]; // task ids violating run_in_background policy
}

/** One SC's outcome-verification result. */
export interface ScResult {
	sc_id: string;
	passed: boolean;
	exit_code: number;
	duration_ms: number;
	output_tail: string; // last N lines for the LLM
}

/** Outcome verification: re-run each SC's verification_cmd and aggregate. */
export interface OutcomeVerification {
	sc_results: ScResult[];
	pass_rate: number; // 0.0 - 1.0
	timed_out: string[]; // SC ids that exceeded timeout_per_sc_ms
}

/**
 * Overall verdict of check_workflow. Status rules (from PLAN §4.2):
 *  - FAIL:                 pass_rate < 0.8 OR sc_with_verification_cmd_pct < 60
 *  - PASS_WITH_GAPS:       pass_rate ≥ 0.8 AND contract_compliance passes, but minor issues
 *  - PASS:                 pass_rate = 1.0 AND contract_compliance ≥ 80
 */
export interface Verdict {
	status: VerdictStatus;
	reason: string; // one-line summary
}

/** Output of `check_workflow`. */
export interface CheckWorkflowValidation {
	artifacts_present: ArtifactsPresent;
	contract_compliance: ContractCompliance;
	outcome_verification: OutcomeVerification;
	blockers: string[]; // high-level blockers surfaced for the LLM
}

// ---------------------------------------------------------------------------
// critique_workflow (§4.3)
// ---------------------------------------------------------------------------

/**
 * Subset of `Dimension` that callers can pass to `focus_dimensions` to
 * narrow the judge's attention. Always a subset of `Dimension`.
 */
export type FocusDimension = Dimension;

/**
 * Input to `critique_workflow`. `decisions` can be pre-supplied from
 * `trace_decisions` to avoid re-scanning.
 */
export interface CritiqueWorkflowInput {
	workflow_path: string;
	codes_dir?: string;
	decisions?: DecisionPoint[];
	baseline_path?: string;
	focus_dimensions?: FocusDimension[];
	model_override?: string;
}

/**
 * One-line overall verdict from the LLM judge. The PLAN uses Chinese
 * strings (the tool's eval output is Chinese per design). The literal
 * union keeps the judge prompt honest.
 */
export type OverallVerdict = "有效" | "局部有效但 X 有缺口" | "未达成目标";

/** Judge's confidence in its own critique. */
export type Confidence = "high" | "medium" | "low";

/** A positive observation — what the workflow did well. */
export interface ReinforcedObservation {
	dimension: Dimension;
	observation: string;
	why_it_mattered: string;
}

/** A negative observation — what the workflow did wrong. */
export interface IssueItem {
	dimension: Dimension;
	severity: Severity;
	evidence: string; // concrete reference
	impact: string;
	/** Anchored to a DecisionPoint.reference when applicable. */
	decision_point_ref?: string;
}

/** An actionable forward-looking suggestion. `anchor_to_issue` ties it to a known issue. */
export interface ForwardLookItem {
	priority: Priority;
	suggestion: string;
	rationale: string;
	expected_impact: string;
	/** Index into `issues[]`; undefined for "fresh" suggestions. */
	anchor_to_issue?: number;
}

/** Trend report when `baseline_path` is provided. */
export interface TrendReport {
	regressed_dimensions: string[];
	improved_dimensions: string[];
	unchanged_dimensions: string[];
	summary: string;
}

/** Judge metadata — model, token usage, wall-clock duration. */
export interface JudgeMeta {
	model: string;
	input_tokens: number;
	output_tokens: number;
	duration_ms: number;
}

/** Output of `critique_workflow`. */
export interface CritiqueWorkflowValidation {
	overall: {
		one_line_verdict: OverallVerdict;
		confidence: Confidence;
	};
	reinforced: ReinforcedObservation[];
	issues: IssueItem[];
	forward_look: ForwardLookItem[];
	/** Present only when baseline_path was supplied. */
	trend?: TrendReport;
	judge_meta: JudgeMeta;
}

// ---------------------------------------------------------------------------
// compare_workflows (§4.4)
// ---------------------------------------------------------------------------

/**
 * Input to `compare_workflows`. Both paths point to prior critique JSON
 * files (validated by `CritiqueWorkflowValidation` shape).
 */
export interface CompareWorkflowsInput {
	workflow_a_path: string;
	workflow_b_path: string;
}

/** Per-dimension diff between two critiques. */
export interface DimensionDiff {
	goal: { new_issues: string[]; resolved_issues: string[] };
	dag: { new_issues: string[]; resolved_issues: string[] };
	implement: { new_issues: string[]; resolved_issues: string[] };
	audit: { new_issues: string[]; resolved_issues: string[] };
	coordination: { new_issues: string[]; resolved_issues: string[] };
}

/** Diff of forward_look suggestions. */
export interface ForwardLookDiff {
	new_suggestions: string[];
	obsolete_suggestions: string[];
}

/** Side-by-side numeric summary of the two critiques. */
export interface OverallChange {
	verdict_a: string;
	verdict_b: string;
	issues_a: number;
	issues_b: number;
	forward_look_a: number;
	forward_look_b: number;
}

/** Output of `compare_workflows`. */
export interface CompareWorkflowsValidation {
	trend: "IMPROVED" | "REGRESSION" | "STABLE";
	overall_change: OverallChange;
	dimension_diffs: DimensionDiff;
	forward_look_diff: ForwardLookDiff;
	recommendations: string[];
}

// ---------------------------------------------------------------------------
// eval_env (§4.5)
// ---------------------------------------------------------------------------

/** A single env check (git, node, pi-binary, optional HF evaluate). */
export interface EnvCheck {
	name: string;
	ok: boolean;
	version?: string;
	hint?: string;
}

/** Output of `eval_env`. Called before any other eval tool to gate execution. */
export interface EvalEnvValidation {
	ready: boolean;
	checks: EnvCheck[];
}

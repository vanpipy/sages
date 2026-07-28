/**
 * pi-evaluator/src/types.ts
 *
 * All interfaces and type aliases for the Sages reward mode extension, as
 * defined in the GC-2026-019 spec.
 *
 * Scope: pure type definitions. No runtime values, no logic.
 * Consumed by src/lib/artifact-reader.ts, src/lib/jsonl-reader.ts, and the
 * signal engine + tool implementations added in T2+.
 *
 * Test: `test/types.test.ts` exercises each interface with a dummy object,
 * proving the types are exported and structurally usable.
 *
 * Invariant: every tool surface defined in the GC-2026-019 spec must have its
 * `Input` + `Validation` pair export here. Sub-shared types
 * (DecisionPoint, Verdict, etc.) are exported as well.
 *
 * Additions during GC-2026-019 P1: artifact + session types consumed by
 * lib/artifact-reader.ts and lib/jsonl-reader.ts (GoalArtifact, DagArtifact,
 * TaskReportArtifact, AuditReportArtifact, SessionEntry, Message,
 * ContentBlock, ArtifactReadError, plus small structural helpers for MD
 * parsing).
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
 * coverage. The eval tool callers (eval_score / eval_trend) and the main
 * agent need this trail to reason.
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
 * anchors its issues and forward_look to. `reference` MUST point to a
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
 * Overall verdict of check_workflow. Status rules (from GC-2026-019 spec):
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
 * One-line overall verdict from the LLM judge.
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

// ---------------------------------------------------------------------------
// Artifact types (consumed by src/lib/artifact-reader.ts)
// ---------------------------------------------------------------------------

/** A single success criterion inside a GoalContract's success_criteria array. */
export interface SuccessCriterion {
	id: string;
	criterion: string;
	verification_cmd?: string;
	expected_output?: string;
	severity?: Severity;
}

/** Scope block — declarative include / exclude path lists. */
export interface Scope {
	include: string[];
	exclude: string[];
}

/** Constraints block — non-functional rules (max deps, lint, etc.). */
export interface GoalConstraints {
	max_dependency_additions?: number;
	test_coverage_min?: number;
	typecheck_required?: boolean;
	lint_required?: boolean;
	must_use_existing_patterns?: boolean;
}

/**
 * Parsed GoalContract (from goal-{id}.yaml under .pi/orchestrator/).
 * Mirrors the YAML schema used by GC-2026-* contracts.
 */
export interface GoalArtifact {
	id: string;
	title: string;
	rationale?: string;
	success_criteria: SuccessCriterion[];
	anti_goals: string[];
	scope: Scope;
	constraints: GoalConstraints;
	done_definition?: string;
	created_at?: string;
}

/** Isolation mode declared by a DAG task. Either a string literal form or the
 *  canonical managed-worktree object (per DAG-2026-011 Phase A P3). */
export type IsolationMode =
	| "worktree"
	| "none"
	| "branch"
	| ManagedWorktreeIsolation;

/** Canonical managed-worktree isolation: developer tasks declare the explicit
 *  worktree object instead of the legacy `worktree` string literal. */
export interface ManagedWorktreeIsolation {
	dag_id: string;
	task_id: string;
	mode: "create" | "reuse";
	base_ref?: string;
}

/** A task node inside a DAG. */
export interface DagTask {
	id: string;
	description: string;
	plane?: string;
	priority?: Priority;
	depends_on: string[];
	files?: string[];
	subagent_type?: string;
	batch?: number;
	isolation?: IsolationMode;
	tdd?: string;
	run_in_background?: boolean;
	acceptance?: {
		covers: string[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/**
 * Parsed DAG (from dag-{id}.yaml under .pi/orchestrator/).
 * Tasks may reference goal SCs via acceptance.covers.
 */
export interface DagArtifact {
	id: string;
	goal_id: string;
	title: string;
	tasks: DagTask[];
	created_at?: string;
	state?: string;
	isolation_default?: IsolationMode;
}

/** Parsed task report (task-{id}-report.md). Free-form text, kept raw + first heading. */
export interface TaskReportArtifact {
	task_id: string;
	file_path: string;
	raw_markdown: string;
}

/** Parsed audit report (audit-{id}.md). Verdict + findings + workflowReady extracted. */
export interface AuditReportArtifact {
	audit_id: string;
	file_path: string;
	raw_markdown: string;
	verdict: string;
	findings: string[];
	workflowReady: boolean;
}

/**
 * Thrown by every artifact-reader function on read / parse failure.
 * `file_path` is the absolute path of the file that could not be read or parsed.
 *
 * Subclasses Error so `err instanceof ArtifactReadError` works in callers.
 * The original cause (if any) is captured via `Error.cause` (ES2022) — not
 * re-declared here to avoid the `noImplicitOverride` clash with the base class.
 */
export class ArtifactReadError extends Error {
	readonly file_path: string;
	constructor(message: string, file_path: string, cause?: unknown) {
		super(`${message}: ${file_path}`);
		this.name = "ArtifactReadError";
		this.file_path = file_path;
		if (cause !== undefined) {
			// ES2022 `Error.cause` is a writable field; assigning here is safe
			// even though it's not declared on this class.
			(this as { cause?: unknown }).cause = cause;
		}
	}
}

// ---------------------------------------------------------------------------
// Session JSONL types (consumed by src/lib/jsonl-reader.ts)
// ---------------------------------------------------------------------------

/** A single content block inside a Message. */
export type ContentBlock =
	| { type: "text"; content: string }
	| { type: "thinking"; content: string }
	| { type: "toolCall"; name: string; arguments?: Record<string, unknown> }
	| { type: "toolResult"; name: string; content: unknown; is_error?: boolean };

/** Role of a Message in the session log. */
export type SessionRole = "user" | "assistant" | "system";

/** A message in the session log (user / assistant / system). */
export interface Message {
	role: SessionRole;
	content: ContentBlock[];
	usage?: Record<string, number>;
}

/**
 * Single entry in session.jsonl. The discriminator is `type`.
 *
 * - `message` carries a `Message` in either pi-format (nested `message` field
 *   in the raw JSONL) or legacy-format (top-level `content` field)
 * - `session_start` / `session_end` mark session boundaries
 * - `model_change` records provider / model switches
 * - `thinking_level_change` records changes to the thinking level
 */
export type SessionEntry =
	| { type: "message"; timestamp: string; message: Message | null; raw: Record<string, unknown> }
	| { type: "session_start"; timestamp: string; session_id?: string; raw: Record<string, unknown> }
	| { type: "session_end"; timestamp: string; session_id?: string; raw: Record<string, unknown> }
	| { type: "model_change"; timestamp: string; provider?: string; model_id?: string; raw: Record<string, unknown> }
	| { type: "thinking_level_change"; timestamp: string; raw: Record<string, unknown> };

/** Aggregate readSession result: entries + parse statistics. */
export interface SessionReadResult {
	entries: SessionEntry[];
	error_count: number;
	line_count: number;
}

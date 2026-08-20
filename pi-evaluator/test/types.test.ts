/**
 * pi-evaluator/types.test.ts
 *
 * TDD: this test file is the FIRST write. It must FAIL before src/types.ts exists
 * (module-not-found), then PASS after src/types.ts is created.
 *
 * Strategy: at-runtime, we build "dummy" objects that satisfy each major interface
 * from src/types.ts. If a type is missing, the import fails (TS will catch this
 * pre-runtime via `tsc --noEmit`). At runtime, we assert the dummy objects are
 * defined and structurally sane.
 *
 * This is intentionally a "structural" test — it does NOT runtime-verify every
 * field; its primary job is to prove the types are EXPORTED and USABLE.
 */

import { describe, expect, test } from "bun:test";
// Runtime import: forces module resolution. If src/types.ts is missing,
// this fails at bun test runtime with "Cannot find module" — the RED state.
// All TYPE-only imports below use `import type` so they're erased at runtime.
import * as TypesModule from "../src/types.ts";
import type {
	// Common
	Signal,
	ToolStatus,
	ToolBase,
	Dimension,
	Severity,
	Priority,
	VerdictStatus,
	// trace_decisions
	TraceDecisionsInput,
	TraceDecisionsValidation,
	DecisionPoint,
	DecisionSource,
	DecisionStage,
	// check_workflow
	CheckWorkflowInput,
	CheckWorkflowValidation,
	Verdict,
	ArtifactsPresent,
	ContractCompliance,
	OutcomeVerification,
	ScResult,
	// critique_workflow
	CritiqueWorkflowInput,
	CritiqueWorkflowValidation,
	OverallVerdict,
	Confidence,
	ReinforcedObservation,
	IssueItem,
	ForwardLookItem,
	TrendReport,
	JudgeMeta,
	FocusDimension,
	// compare_workflows
	CompareWorkflowsInput,
	CompareWorkflowsValidation,
	DimensionDiff,
	ForwardLookDiff,
	OverallChange,
	// eval_env
	EvalEnvValidation,
	EnvCheck,
} from "../src/types.ts";

// ---- Common ----

const signalDemo: Signal<number> = {
	value: 42,
	evidence: "placeholder evidence",
};

const toolStatus: ToolStatus = "ok";
const toolBase: ToolBase = {
	status: toolStatus,
	intent: "demo",
};
const dimension: Dimension = "implement";
const severity: Severity = "major";
const priority: Priority = "high";
const verdictStatus: VerdictStatus = "PASS_WITH_GAPS";

// ---- trace_decisions ----

const decisionStage: DecisionStage = "goal";
const decisionSource: DecisionSource = "tool_call";

const decisionPoint: DecisionPoint = {
	stage: decisionStage,
	timestamp: "2026-07-25T10:00:00.000Z",
	source: decisionSource,
	summary: "created goal contract",
	artifacts_touched: [".pi/orchestrator/goal-FOO.yaml"],
	reference: "session.jsonl:L12",
};

const traceDecisionsInput: TraceDecisionsInput = {
	workflow_path: "/tmp/example",
};

const traceDecisionsValidation: TraceDecisionsValidation = {
	decisions: [decisionPoint],
	coverage: {
		goal_present: true,
		dag_present: true,
		implement_count: 1,
		audit_count: 1,
	},
};

// ---- check_workflow ----

const checkWorkflowInput: CheckWorkflowInput = {
	workflow_path: "/tmp/example",
};

const artifactsPresent: ArtifactsPresent = {
	goal: true,
	dag: true,
	task_reports: 1,
	audit_reports: 1,
	session_jsonl: true,
};

const contractCompliance: ContractCompliance = {
	sc_with_verification_cmd_pct: 100,
	dag_sc_coverage_pct: 100,
	cycles_present: false,
	isolation_violations: [],
	background_violations: [],
};

const scResult: ScResult = {
	sc_id: "SC1",
	passed: true,
	exit_code: 0,
	duration_ms: 12,
	output_tail: "test passes for SC1",
};

const outcomeVerification: OutcomeVerification = {
	sc_results: [scResult],
	pass_rate: 1.0,
	timed_out: [],
};

const verdict: Verdict = {
	status: verdictStatus,
	reason: "all good",
};

const checkWorkflowValidation: CheckWorkflowValidation = {
	artifacts_present: artifactsPresent,
	contract_compliance: contractCompliance,
	outcome_verification: outcomeVerification,
	blockers: [],
};

// ---- critique_workflow ----

const focusDimension: FocusDimension = "implement";

const critiqueWorkflowInput: CritiqueWorkflowInput = {
	workflow_path: "/tmp/example",
};

const overallVerdict: OverallVerdict = "partially effective with gaps in X";
const confidence: Confidence = "high";

const reinforcedObservation: ReinforcedObservation = {
	dimension: "implement",
	observation: "TDD discipline was followed",
	why_it_mattered: "reduces regression risk",
};

const issueItem: IssueItem = {
	dimension: "dag",
	severity: "major",
	evidence: "task-P1.md:SC3 not covered",
	impact: "audit cannot verify SC3",
	decision_point_ref: "session.jsonl:L42",
};

const forwardLookItem: ForwardLookItem = {
	priority: "high",
	suggestion: "add SC3 to dag acceptance.covers",
	rationale: "otherwise SC3 cannot be verified",
	expected_impact: "complete SC coverage",
	anchor_to_issue: 0,
};

const trendReport: TrendReport = {
	regressed_dimensions: [],
	improved_dimensions: ["implement"],
	unchanged_dimensions: ["goal", "dag", "audit", "coordination"],
	summary: "improved implementation discipline",
};

const judgeMeta: JudgeMeta = {
	model: "test-model",
	input_tokens: 100,
	output_tokens: 200,
	duration_ms: 500,
};

const critiqueWorkflowValidation: CritiqueWorkflowValidation = {
	overall: {
		one_line_verdict: overallVerdict,
		confidence: confidence,
	},
	reinforced: [reinforcedObservation],
	issues: [issueItem],
	forward_look: [forwardLookItem],
	trend: trendReport,
	judge_meta: judgeMeta,
};

// ---- compare_workflows ----

const compareWorkflowsInput: CompareWorkflowsInput = {
	workflow_a_path: "/tmp/a",
	workflow_b_path: "/tmp/b",
};

const dimensionDiff: DimensionDiff = {
	goal: { new_issues: [], resolved_issues: [] },
	dag: { new_issues: [], resolved_issues: [] },
	implement: { new_issues: [], resolved_issues: [] },
	audit: { new_issues: [], resolved_issues: [] },
	coordination: { new_issues: [], resolved_issues: [] },
};

const forwardLookDiff: ForwardLookDiff = {
	new_suggestions: [],
	obsolete_suggestions: [],
};

const overallChange: OverallChange = {
	verdict_a: "PASS_WITH_GAPS",
	verdict_b: "PASS",
	issues_a: 5,
	issues_b: 2,
	forward_look_a: 5,
	forward_look_b: 2,
};

const compareWorkflowsValidation: CompareWorkflowsValidation = {
	trend: "IMPROVED",
	overall_change: overallChange,
	dimension_diffs: dimensionDiff,
	forward_look_diff: forwardLookDiff,
	recommendations: [],
};

// ---- eval_env ----

const envCheck: EnvCheck = {
	name: "git",
	ok: true,
	version: "2.40.0",
	hint: undefined,
};

const evalEnvValidation: EvalEnvValidation = {
	ready: true,
	checks: [envCheck],
};

// ---- Sufficient dummy count to prove >=13 interfaces exported ----

describe("pi-evaluator types.ts", () => {
	test("src/types.ts module is resolvable (runtime import succeeds)", () => {
		// If src/types.ts is missing, `import * as TypesModule` fails at module
		// load time and bun test reports 0 pass / 1 fail. This is the RED-state
		// signal for the TDD cycle.
		expect(TypesModule).toBeDefined();
	});

	test("module loads and exports all required interfaces", () => {
		// The const declarations above are the proof: if any interface is missing
		// from src/types.ts, this file fails to compile via `tsc --noEmit`. At
		// runtime, we just assert the dummy objects are defined.
		expect(signalDemo).toBeDefined();
		expect(toolBase).toBeDefined();
		expect(decisionPoint).toBeDefined();
		expect(traceDecisionsValidation).toBeDefined();
		expect(checkWorkflowValidation).toBeDefined();
		expect(critiqueWorkflowValidation).toBeDefined();
		expect(compareWorkflowsValidation).toBeDefined();
		expect(evalEnvValidation).toBeDefined();
	});

	test("Signal<T> wraps a typed value with evidence", () => {
		expect(signalDemo.value).toBe(42);
		expect(signalDemo.evidence).toBeTypeOf("string");
	});

	test("DecisionPoint has required structural fields", () => {
		expect(decisionPoint.stage).toBe("goal");
		expect(decisionPoint.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(decisionPoint.source).toBe("tool_call");
		expect(decisionPoint.reference).toBeTypeOf("string");
		expect(Array.isArray(decisionPoint.artifacts_touched)).toBe(true);
	});

	test("Verdict has a 3-state status enum", () => {
		expect(verdict.status).toBe("PASS_WITH_GAPS");
		expect(verdict.reason).toBeTypeOf("string");
	});

	test("CheckWorkflowValidation has three top-level sections", () => {
		expect(checkWorkflowValidation.artifacts_present).toBeDefined();
		expect(checkWorkflowValidation.contract_compliance).toBeDefined();
		expect(checkWorkflowValidation.outcome_verification).toBeDefined();
		expect(Array.isArray(checkWorkflowValidation.blockers)).toBe(true);
	});

	test("CritiqueWorkflowValidation has overall + reinforced + issues + forward_look", () => {
		expect(critiqueWorkflowValidation.overall.one_line_verdict).toBeTypeOf("string");
		expect(critiqueWorkflowValidation.overall.confidence).toBe("high");
		expect(critiqueWorkflowValidation.reinforced).toHaveLength(1);
		expect(critiqueWorkflowValidation.issues).toHaveLength(1);
		expect(critiqueWorkflowValidation.forward_look).toHaveLength(1);
		expect(critiqueWorkflowValidation.judge_meta.model).toBeTypeOf("string");
	});

	test("CompareWorkflowsValidation has trend + dimension_diffs + forward_look_diff", () => {
		expect(compareWorkflowsValidation.trend).toBe("IMPROVED");
		expect(compareWorkflowsValidation.overall_change.issues_a).toBe(5);
		const dims = compareWorkflowsValidation.dimension_diffs;
		expect(dims.goal).toBeDefined();
		expect(dims.dag).toBeDefined();
		expect(dims.implement).toBeDefined();
		expect(dims.audit).toBeDefined();
		expect(dims.coordination).toBeDefined();
	});

	test("EvalEnvValidation has ready + checks array", () => {
		expect(evalEnvValidation.ready).toBe(true);
		expect(evalEnvValidation.checks).toHaveLength(1);
		expect(evalEnvValidation.checks[0]?.name).toBe("git");
	});

	test("ToolStatus / Dimension / Severity / Priority / VerdictStatus are correct literal unions", () => {
		expect(toolStatus).toBe("ok");
		expect(dimension).toBe("implement");
		expect(severity).toBe("major");
		expect(priority).toBe("high");
		expect(verdictStatus).toBe("PASS_WITH_GAPS");
	});
});

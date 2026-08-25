/**
 * Orchestrator Audit Tool
 *
 * Stage 4 of orchestrator workflow: workflow-level audit rollup.
 *
 * A3 split: per-task audit (re-run verification_cmd, inspect diff, check TDD
 * discipline) is delegated to the `auditor` subagent, which writes
 * `.pi/orchestrator/audit-{task_id}.md`. This tool pools those per-task
 * reports and aggregates them into a workflow-level view — focusing on
 * cross-task consistency, SC coverage, and integration-level concerns.
 *
 * Phases (A3 scope — workflow-level unless noted):
 *   - ink:       verify each task has an auditor report AND it's CERTIFIED
 *   - nose:      cross-check SC coverage across all tasks (goal contract)
 *   - foot:      OPTIONAL re-run of cross-cutting verification_cmd (per-task
 *                verification is auditor's job)
 *   - castration: workflow-level security (full only) — orphaned worktrees,
 *                shared secrets across tasks
 *   - death:     long-term viability (full only) — orphaned branches, drive-by
 *                refactoring across task boundaries
 *
 * Output: writes markdown report + returns verdict + score + findings.
 */

import { Type, type Static } from "typebox";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type {
  OrchestratorAuditResult,
  OrchestratorFinding,
  OrchestrationPlan,
  TaskNode,
} from "./types.js";
import {
  ORCHESTRATOR_DIR,
  TASK_AUDIT_PREFIX,
  taskAuditPath,
  WORKFLOW_AUDIT,
} from "./types.js";
import {
  atomicWriteOrchestratorFile,
  atomicWriteOrchestratorText,
} from "./state-persistence.js";
import { loadPlan } from "./dag-synthesizer.js";
// GC-2026-041: Cross-package import. The full extractAuditFindings
// parser lives in pi-subagents/src/agent-runner.ts (5 rules). The
// ambient declaration in pi/types/pi-subagents-audit.d.ts declares
// the module shape so tsc accepts the import. The ambient declaration
// + a `// @ts-ignore` on the import line bypass the rootDir check
// (which would otherwise reject with TS6059). Runtime resolution
// uses Node ESM (relative path is correct in the monorepo).
// @ts-ignore -- tsc rejects cross-package imports under rootDir.
import { extractAuditFindings, type AuditFinding } from "../../pi-subagents/src/agent-runner.js";
// @ts-ignore -- tsc rejects cross-package imports under rootDir.
import { readAllDiagnostics, DIAGNOSTICS_RELDIR } from "../../pi-subagents/src/diagnostic.js";

const COMPLETE_OBSERVATION = Type.Object({
  verdict: Type.Union([Type.Literal("PASS"), Type.Literal("REVISE"), Type.Literal("REJECT")]),
  score: Type.Number({ minimum: 0, maximum: 100 }),
  summary: Type.String({ minLength: 1 }),
}, { description: "Finalize the audit" });

export const OrchestratorAuditParams = Type.Object({
  dag_id: Type.String({ description: "DAG id" }),
  /** If omitted, audit the whole DAG; if set, audit only this batch */
  batch: Type.Optional(Type.Number({ description: "Batch number to audit (omit for whole DAG)" })),
  /** If set, audit only this task within the DAG */
  task_id: Type.Optional(Type.String({ description: "Single task id to audit" })),
  /** Sub-mode: 'fast' = quick checks (ink+nose+foot); 'full' = all 5 phases */
  depth: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("full")])),
  /**
   * Return the full init payload (phase_guidance, tasks_to_audit,
   * inline_findings, failure_mode_stats, phases). Default false returns a
   * compact summary (status/phase/intent/validation/audit_identity/
   * workflow_summary).
   */
  verbose: Type.Optional(Type.Boolean({ description: "Return the full init payload (phase_guidance, tasks_to_audit, inline_findings, failure_mode_stats, phases). Default false returns a compact summary." })),
  /**
   * Observation mode: omit for first call (audit-init), then pass on follow-up
   * calls to record findings / complete the audit. The state is persisted to
   * disk between calls so the LLM can resume after context compaction.
   *
   * Two ways to record findings (mutually exclusive):
   *   - `finding`: SINGLE finding (kept for backward compat / per-finding granularity)
   *   - `findings`: ARRAY of findings — preferred for batch submission (fewer
   *     tool round-trips; one call can submit all findings from a phase)
   */
  observation: Type.Optional(Type.Object({
    /** A single audit finding (backward-compat — prefer `findings` array) */
    finding: Type.Optional(Type.Object({
      task_id: Type.Optional(Type.String()),
      category: Type.Union([
        Type.Literal("ink"),
        Type.Literal("nose"),
        Type.Literal("foot"),
        Type.Literal("castration"),
        Type.Literal("death"),
      ]),
      severity: Type.Union([
        Type.Literal("critical"),
        Type.Literal("major"),
        Type.Literal("minor"),
      ]),
      issue: Type.String({ minLength: 1 }),
      evidence: Type.Optional(Type.String()),
      recommendation: Type.Optional(Type.String()),
    }, { description: "A single audit finding to record" })),
    /** Batch of findings — preferred (reduces audit tool calls ~60%) */
    findings: Type.Optional(Type.Array(Type.Object({
      task_id: Type.Optional(Type.String()),
      category: Type.Union([
        Type.Literal("ink"),
        Type.Literal("nose"),
        Type.Literal("foot"),
        Type.Literal("castration"),
        Type.Literal("death"),
      ]),
      severity: Type.Union([
        Type.Literal("critical"),
        Type.Literal("major"),
        Type.Literal("minor"),
      ]),
      issue: Type.String({ minLength: 1 }),
      evidence: Type.Optional(Type.String()),
      recommendation: Type.Optional(Type.String()),
    }), { description: "An array of findings to record in a single call" })),
    /** Mark audit as complete — verdict, score, summary, all findings */
    complete: Type.Optional(COMPLETE_OBSERVATION),
  }, { description: "Audit progress: record a finding or complete the audit" })),
});

export type OrchestratorAuditInput = Static<typeof OrchestratorAuditParams>;

function auditIdentityFor(params: { dag_id: string; task_id?: string; batch?: number }, depth: "fast" | "full"): AuditIdentity {
  if (params.task_id) return { dag_id: params.dag_id, scope: "task", scope_key: params.task_id, depth };
  if (params.batch !== undefined) return { dag_id: params.dag_id, scope: "batch", scope_key: String(params.batch), depth };
  return { dag_id: params.dag_id, scope: "workflow", scope_key: "workflow", depth };
}

/** Persisted state file name. Lives at .pi/orchestrator/audit-state-{dag_id}.yaml */
function auditStatePath(cwd: string, dagId: string): string {
  return join(cwd, ORCHESTRATOR_DIR, `audit-state-${dagId}.yaml`);
}

/** Identity carried by persisted state to reject cross-scope/depth reuse. */
export interface AuditIdentity {
  dag_id: string;
  scope: "task" | "batch" | "workflow";
  scope_key: string;
  depth: "fast" | "full";
}

/** Audit state — persisted between tool calls so LLM can resume after context compaction. */
export interface AuditState {
  dag_id: string;
  plan: OrchestrationPlan;
  tasks: TaskNode[];
  findings: OrchestratorFinding[];
  score: number;
  depth: "fast" | "full";
  identity: AuditIdentity;
  /** Lifecycle: "init" right after first call, "recording" while accumulating findings, "complete" after the final call. */
  status: "init" | "recording" | "complete";
  created_at: string;
  updated_at: string;
}

/** Default minimum findings required for verdict=PASS at each depth. */
export function findingsRequiredMin(depth: "fast" | "full"): number {
  return depth === "fast" ? 1 : 3;
}

function loadAuditState(cwd: string, dagId: string): AuditState | null {
  const path = auditStatePath(cwd, dagId);
  if (!existsSync(path)) return null;
  try {
    return yaml.load(readFileSync(path, "utf-8")) as AuditState;
  } catch {
    return null;
  }
}

function saveAuditState(cwd: string, state: AuditState): void {
  const path = auditStatePath(cwd, state.dag_id);
  const serialized = yaml.dump(state, { indent: 2, lineWidth: 120, noRefs: true });
  const saved = atomicWriteOrchestratorText(cwd, `audit-state-${state.dag_id}.yaml`, serialized, "orchestrator");
  if (saved !== path) throw new Error(`audit state path mismatch: ${saved} vs ${path}`);
}

/**
 * Tool registration. The actual audit work is done by the LLM using semantic tools
 * (file read, aft_search, bash to re-run verification_cmd, etc.). This tool
 * provides the structured framework + persists state + writes the final report.
 *
 * Lifecycle:
 *   1. First call (no observation): init AuditState, persist, return phase guidance
 *   2. Subsequent calls with observation.finding(s): append finding(s), persist
 *   3. Final call with observation.complete: write report, return verdict
 *
 * State is persisted to .pi/orchestrator/audit-state-{dag_id}.yaml between
 * calls so the audit can survive context compaction.
 */
export function registerOrchestratorAuditTool(pi: any): void {
  pi.registerTool({
    name: "orchestrator_audit",
    label: "Orchestrator Audit",
    description: "Stage 4: workflow-level audit rollup (A3). Reads auditor reports, aggregates verdicts, surfaces cross-task findings. Default depth fast (3 phases: ink/nose/foot); pass depth:full for castration/death. State persists between calls. Verdict: PASS/REVISE/REJECT with score.",
    parameters: OrchestratorAuditParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return await executeOrchestratorAudit(params, { cwd: ctx.cwd });
    },
  });
}

/**
 * Pure (well — file I/O only) entry point for orchestrator_audit. Extracted
 * from the registered tool so it can be unit-tested directly without going
 * through pi.registerTool.
 */
export async function executeOrchestratorAudit(
  params: Static<typeof OrchestratorAuditParams>,
  ctx: { cwd: string },
): Promise<{ content: { type: "text"; text: string }[] }> {
  const cwd = ctx.cwd;
  // Default to "fast" depth (3 phases: ink/nose/foot). The full 5-phase
  // audit is opt-in via depth: "full" — saves 40% audit time on routine
  // workflows where castration/death aren't relevant.
  const depth = (params.depth ?? "fast") as "fast" | "full";

  // Load plan
  const plan = loadPlan(cwd, params.dag_id);
  if (!plan) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: `DAG ${params.dag_id} not found. Run dag_synthesize first.`,
        validation: { errors: ["DAG not found"] },
      }) }],
    };
  }

  // Filter tasks to audit
  const tasks = params.task_id
    ? plan.tasks.filter(t => t.id === params.task_id)
    : params.batch !== undefined
    ? plan.tasks.filter(t => t.batch === params.batch)
    : plan.tasks;

  if (tasks.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "No tasks match the filter.",
        validation: { errors: ["empty task filter"] },
      }) }],
    };
  }

  const obs = params.observation ?? ({} as any);
  const hasFindings = !!(obs.finding || (obs.findings && obs.findings.length > 0));
  const hasComplete = !!obs.complete;

  // ── Path 1: Complete (with optional findings merged in first) ─────
  // When both `findings` and `complete` are present in the SAME call,
  // persist the findings first so completeAudit's `state.findings`
  // reflects them (otherwise the findings are silently dropped — the
  // previous 2-tool-call SKILL.md pattern relied on this).
  if (hasComplete) {
    if (hasFindings) {
      const rec = await recordFindings(cwd, plan, params, tasks, depth);
      // If recordFindings errored, surface it directly.
      try {
        const recJson = JSON.parse(rec.content[0].text);
        if (recJson.status === "error") return rec;
      } catch { /* fall through */ }
    }
    return await completeAudit(cwd, plan, params, tasks);
  }

  // ── Path 2: Record findings only ─────────────────────────────────
  if (hasFindings) {
    return await recordFindings(cwd, plan, params, tasks, depth);
  }

  // ── Path 3: Init the audit (first call, no observation) ──────────
  return await initAudit(cwd, plan, params, tasks, depth);
}

/** Init: create state file + read per-task audit reports + return workflow-level view. */
async function initAudit(
  cwd: string,
  plan: OrchestrationPlan,
  params: any,
  tasks: TaskNode[],
  depth: "fast" | "full",
): Promise<any> {
  const now = new Date().toISOString();
  const identity = auditIdentityFor(params, depth);
  const state: AuditState = {
    dag_id: plan.id,
    plan,
    tasks,
    findings: [],
    score: 100,
    depth,
    identity,
    status: "init",
    created_at: now,
    updated_at: now,
  };
  saveAuditState(cwd, state);

  const phases = getPhasesForDepth(depth);
  const phaseGuidance = buildWorkflowPhaseGuidance(phases);

  // A3 — read auditor's per-task reports and aggregate
  const reports = readAuditReports(cwd, tasks);
  const workflowSummary = aggregateTaskAudits(tasks, reports);

  // GC-2026-070: surface the retryable-failure rollup so the orchestrator
  // sees the hint even at the compact (non-verbose) audit-init summary.
  // When `retryable.length > 0`, the orchestrator has at least one
  // spec-classified failure mode with budget remaining — a re-dispatch with
  // mode: "reuse" + the catalog's feedback template is the right move.
  const failureModeStats = gatherFailureModeStats(cwd, plan.id);
  const retryableHint =
    failureModeStats.retryable.length > 0
      ? ` GC-2026-070: ${failureModeStats.retryable.length} retryable failure mode(s) detected (${failureModeStats.retryable.map((r) => `${r.id}(${r.count})`).join(", ")}); consider buildReDispatchSuggestion(prior_diagnostic) for mode: "reuse" re-dispatch.`
      : "";

  // GC-2026-039: Runtime enforcement. Read each task's report and run
  // the inline governance check. This catches BLOCKED-no-reason, missing
  // YAML block, and stuck-checkpoint patterns that the per-task audit
  // may have missed. The findings are surfaced as audit-gate warnings;
  // they do NOT block the audit (workflowReady stays as the auditor's
  // verdict) but they trigger the orchestrator to record additional findings.
  const taskReports = readTaskReports(cwd, tasks);
  // GC-2026-041: Use the full 5-rule extractAuditFindings from pi-subagents.
  // The inline 3-rule subset is gone. Each task's report is parsed and any
  // findings are surfaced as inline_findings for the orchestrator to record.
  const inlineFindings: Array<{ task_id: string; finding: AuditFinding }> = [];
  for (const t of tasks) {
    const report = taskReports.get(t.id);
    if (report == null) continue;
    const findings = extractAuditFindings(report, "");
    for (const f of findings) {
      inlineFindings.push({ task_id: t.id, finding: f });
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "in_progress",
      phase: "audit-init",
      intent: `Audit initialized for ${tasks.length} task(s). workflowReady=${workflowSummary.workflowReady}. ${workflowSummary.blockingTasks.length > 0 ? `Blocking: ${workflowSummary.blockingTasks.join(", ")}. Run any remaining tasks + audits, then record findings (≥${findingsRequiredMin(depth)} required) and complete.` : "All tasks certified — record findings (≥" + findingsRequiredMin(depth) + " required for fast depth) and complete."}` + (inlineFindings.length > 0 ? ` GC-2026-039 runtime enforcement surfaced ${inlineFindings.length} finding(s); the orchestrator should record them via the observation.findings array.` : "") + retryableHint,
      validation: {
        errors: workflowSummary.workflowReady ? [] : [`tasks not yet certified: ${workflowSummary.blockingTasks.join(", ")}`],
        warnings: inlineFindings.length > 0 ? [`GC-2026-039: ${inlineFindings.length} runtime enforcement finding(s) surfaced — see inline_findings`]: [],
        files_required: [auditStatePath(cwd, plan.id)],
        findings_required_min: findingsRequiredMin(depth),
      },
      audit_identity: identity,
      workflow_summary: workflowSummary,
      // GC-2026-063: verbose-only guidance/report fields. Dropped from the
      // default compact summary; still computed (inlineFindings/phaseGuidance
      // above) and included when `verbose: true`.
      ...(params.verbose === true ? {
        phases,
        phase_guidance: phaseGuidance,
        failure_mode_stats: gatherFailureModeStats(cwd, plan.id),
        inline_findings: inlineFindings,
        tasks_to_audit: tasks.map(t => ({
          id: t.id,
          description: t.description,
          subagent_type: t.subagent_type,
          acceptance_covers: t.acceptance.covers,
          self_check_cmd: t.acceptance.self_check_cmd,
          report_path: taskAuditPath(cwd, t.id),
        })),
      } : {}),
    }) }],
  };
}

/**
 * Record: load state, append one or more findings (single OR batch), persist,
 * return updated count.
 *
 * Accepts either:
 *   - `observation.finding` (single — backward compat)
 *   - `observation.findings` (array — preferred, saves tool round-trips)
 *
 * Both can be combined in one call. The score is recomputed once from the
 * full findings list (not incrementally).
 */
async function recordFindings(
  cwd: string,
  plan: OrchestrationPlan,
  params: any,
  tasks: TaskNode[],
  depth: "fast" | "full",
): Promise<any> {
  let state = loadAuditState(cwd, plan.id);
  if (!state) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "No active audit. Call without observation to init, or pass complete to finalize.",
        validation: { errors: ["audit state not found — call orchestrator_audit without observation first"] },
      }) }],
    };
  }

  // Reject post-finalize appends (would silently mutate a sealed state).
  if (state.status === "complete") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "Audit is already finalized. Re-run init to start a new audit (or pass force: true on complete to overwrite).",
        validation: { errors: ["audit is finalized; cannot append findings"] },
      }) }],
    };
  }

  const expectedIdentity = auditIdentityFor(params, depth);
  if (!sameIdentity(state.identity, expectedIdentity)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "Audit identity mismatch: persisted state was created with a different scope or depth. Re-run init to start a new audit.",
        validation: { errors: ["audit identity mismatch: cross-scope or cross-depth reuse rejected"] },
      }) }],
    };
  }

  // Normalize: accept either `finding` (single) or `findings` (array)
  const obs = params.observation;
  const newFindings: OrchestratorFinding[] = [];
  if (obs.finding) newFindings.push(obs.finding);
  if (obs.findings && Array.isArray(obs.findings)) newFindings.push(...obs.findings);

  if (newFindings.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "observation provided but neither `finding` nor `findings` is set.",
        validation: { errors: ["empty observation payload"] },
      }) }],
    };
  }

  // Single recompute via pure function — no per-finding disk churn
  const next = appendFindings(state, newFindings);
  next.status = "recording";
  saveAuditState(cwd, next);

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "in_progress",
      phase: "audit-recording",
      intent: `Recorded ${newFindings.length} finding(s). ${next.findings.length} total, current score: ${next.score}. Continue auditing or call with observation.complete to finalize.`,
      validation: {
        errors: [],
        warnings: [],
        files_required: [auditStatePath(cwd, plan.id)],
      },
      findings_count: next.findings.length,
      score: next.score,
      added_this_call: newFindings.length,
    }) }],
  };
}

/** Complete: write the final audit report (markdown) + return verdict. */
async function completeAudit(
  cwd: string,
  plan: OrchestrationPlan,
  params: any,
  tasks: TaskNode[],
): Promise<any> {
  let state = loadAuditState(cwd, plan.id);
  if (!state) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "No active audit to complete. Call without observation to init first.",
        validation: { errors: ["audit state not found"] },
      }) }],
    };
  }
  const expectedIdentity = auditIdentityFor(params, state.depth);
  if (!sameIdentity(state.identity, expectedIdentity)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "Audit identity mismatch: persisted state was created with a different scope or depth.",
        validation: { errors: ["audit identity mismatch: cross-scope or cross-depth reuse rejected"] },
      }) }],
    };
  }

  const requested = params.observation.complete as {
    verdict: "PASS" | "REVISE" | "REJECT";
    score: number;
    summary: string;
  };
  let { verdict } = requested;
  const { score, summary } = requested;
  const errors: string[] = [];

  // F5/F6 — decouple PASS gate from finding severity:
  //   - Clean audits (no defect findings + workflowReady) may PASS.
  //     findingsRequiredMin(depth) is reported as informational only;
  //     0 defect findings is a valid PASS outcome.
  //   - workflowReady=false still downgrades PASS to REVISE because
  //     at least one task's audit is missing/non-CERTIFIED.
  //   - Severity gates (critical → REJECT, major → REVISE) only override
  //     a PASS verdict; explicit REVISE/REJECT from the LLM is respected.

  // Re-read the per-task reports to compute workflowReady (always fresh
  // — a downstream re-audit may have flipped a task from NEEDS WORK to
  // CERTIFIED between init and complete).
  const reports = readAuditReports(cwd, state.tasks);
  const workflowSummary = aggregateTaskAudits(state.tasks, reports);
  if (verdict === "PASS" && !workflowSummary.workflowReady) {
    errors.push(
      `verdict:PASS requires all tasks certified; blocking: ${workflowSummary.blockingTasks.join(", ")}`,
    );
    verdict = "REVISE";
  }

  // GC-2026-041: Auto-inject inline findings into state.findings.
  // Re-run extractAuditFindings on each task's report. For any finding
  // NOT already in state.findings (i.e. the orchestrator didn't record it via
  // observation.findings), auto-record it as a synthetic finding with
  // category=castration (the cross-cutting governance concern) and
  // severity matching the inline finding's severity. This ensures
  // computeScore penalizes governance violations even if the orchestrator
  // forgets to record them. The synthetic findings are visible in the
  // audit report; the orchestrator still has the option to add its own findings.
  const taskReportsAuto = readTaskReports(cwd, state.tasks);
  for (const t of state.tasks) {
    const report = taskReportsAuto.get(t.id);
    if (report == null) continue;
    const inlineResults = extractAuditFindings(report, "");
    for (const inf of inlineResults) {
      // Has the orchestrator already recorded an equivalent finding? (Match by
      // rule + task_id.) If yes, skip. If no, auto-inject.
      const already = state.findings.some(
        (f) =>
          (f.task_id === t.id || f.task_id == null) &&
          f.issue === inf.issue,
      );
      if (!already) {
        state = appendFindings(state, [
          {
            task_id: t.id,
            category: "castration",
            severity: inf.severity,
            issue: inf.issue,
            evidence: inf.evidence,
            recommendation: inf.recommendation,
          },
        ]);
      }
    }
  }

  // Severity gates only override PASS — the LLM's explicit REVISE/REJECT
  // verdict is respected. This lets the LLM self-correct without the tool
  // refusing to honor an honest downgrade.
  if (verdict === "PASS") {
    const hasCritical = state.findings.some((f) => f.severity === "critical");
    const hasMajor = state.findings.some((f) => f.severity === "major");
    if (hasCritical) verdict = "REJECT";
    else if (hasMajor) verdict = "REVISE";
  }

  // Recompute score from findings (don't trust the LLM-supplied score blindly)
  const computedScore = computeScore(state.findings);
  const finalScore = Math.min(score, computedScore);

  // Namespace ownership check — auditor owns audit-{id}.md, Orchestrator owns the
  // workflow rollup. The path the tool returns MUST match the path the
  // tool actually writes to (C1 regression guard). Ownership classification
  // also rejects cross-namespace writes before they reach the file system.
  // Per-scope report path:
  //   - workflow → audit-workflow.md (orchestrator-owned rollup)
  //   - task     → audit-<task_id>.md      (auditor-owned per-task report)
  //   - batch    → audit-<batch>.md        (auditor-owned per-batch report)
  // Both task and batch use the AUDITOR namespace — taskAuditPath gives
  // identical layout, and the discriminated path matches the test contract
  // (C1: report_path returned must equal the file actually written).
  const reportRelative = state.identity.scope === "workflow"
    ? WORKFLOW_AUDIT
    : `${TASK_AUDIT_PREFIX}${state.identity.scope_key}.md`;
  const reportPath = join(cwd, ORCHESTRATOR_DIR, reportRelative);
  const result: OrchestratorAuditResult = {
    verdict,
    score: finalScore,
    findings: state.findings,
    report_path: reportPath,
    summary,
  };

  // Update state to finalized
  state.score = finalScore;
  state.status = "complete";
  state.updated_at = new Date().toISOString();
  saveAuditState(cwd, state);

  // Write the markdown report (separate from state file) at the resolved path
  writeAuditReport(cwd, result, reportPath);

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "complete",
      phase: "audit-complete",
      intent: `Audit complete. Verdict: ${verdict}, score: ${finalScore}/100. Report at ${reportPath}.`,
      validation: {
        errors,
        warnings: [],
        files_required: [reportPath, auditStatePath(cwd, plan.id)],
        // Informational only — F6 decoupled the PASS gate from this count.
        // The LLM uses it to plan how many findings to record when defects
        // exist; a clean audit (0 findings) may still PASS.
        findings_required_min: findingsRequiredMin(state.depth),
      },
      verdict,
      score: finalScore,
      findings: state.findings,
      summary,
      report_path: reportPath,
      workflow_summary: workflowSummary,
    }) }],
  };
}

/**
 * Phase selection by depth. Pure function — exported for testing.
 *   - fast: ink / nose / foot  (default; covers 90% of workflows)
 *   - full: adds castration / death for security + long-term viability
 */
export function getPhasesForDepth(depth: "fast" | "full"): string[] {
  return depth === "fast"
    ? ["ink", "nose", "foot"]
    : ["ink", "nose", "foot", "castration", "death"];
}

/**
 * Compute a 0-100 score from findings. Critical findings heavily penalize.
 * Exported for unit testing.
 */
export function computeScore(findings: OrchestratorFinding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.severity === "critical") score -= 30;
    else if (f.severity === "major") score -= 10;
    else if (f.severity === "minor") score -= 2;
  }
  return Math.max(0, score);
}

/**
 * Append one or more findings to an audit state in a single recompute.
 * Pure function — caller is responsible for persistence.
 *
 * Replaces the previous one-finding-per-tool-call pattern: now the LLM can
 * submit all findings from a phase (or all phases) in a single call,
 * cutting audit tool calls by ~60%.
 */
export function appendFindings(
  state: AuditState,
  newFindings: OrchestratorFinding[],
): AuditState {
  const findings = [...state.findings, ...newFindings];
  return {
    ...state,
    findings,
    score: computeScore(findings),
    updated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A3 — workflow-level audit aggregation (read auditor's reports)
// ─────────────────────────────────────────────────────────────────────────────

/** Verdict strings emitted by the auditor subagent (defined in pi-subagents). */
export type SubagentVerdict = "CERTIFIED" | "NEEDS WORK" | "BLOCKED" | "UNKNOWN";

/** Per-task summary extracted from an auditor audit report. */
export interface TaskAuditSummary {
  task_id: string;
  has_report: boolean;
  verdict?: SubagentVerdict;
  findings_total: number;
}

/** Workflow-level rollup across all task audits. */
export interface WorkflowAuditSummary {
  tasks: TaskAuditSummary[];
  /** True iff every task has a report AND every report is CERTIFIED. */
  workflowReady: boolean;
  /** Tasks whose audit is missing or non-passing (NEEDS WORK / BLOCKED). */
  blockingTasks: string[];
}

/** One failure-catalog id and how often it fired in this workflow. */
export interface FailureModeStat {
  id: string;
  count: number;
  /** ISO8601 `emittedAt` of the most recent diagnostic in this bucket. */
  latest: string;
  /**
   * GC-2026-070: catalog-derived metadata. `handlerKind` is `"spec"` for
   * LLM-side misses (retryable) and `"error"` for infrastructure failures.
   * `minRetryBudgetLeft` is the minimum retryBudgetLeft observed across the
   * bucket — 0 means at least one diagnostic showed the budget as exhausted.
   * `undefined` when the cause is not in the catalog (unknown id).
   */
  handlerKind?: "spec" | "error";
  /** Per-bucket minimum of `retryBudgetLeft`; undefined when no diagnostic carried it. */
  minRetryBudgetLeft?: number;
}

/** GC-2026-044 design §5.6 — failure-mode rollup for a workflow. */
export interface FailureModeStats {
  total: number;
  /** Buckets sorted by count desc, then id, so the report is stable. */
  byCause: FailureModeStat[];
  byOutcome: Record<string, number>;
  /**
   * GC-2026-070: subset of `byCause` whose handler.kind === "retry-subagent".
   * Surfaced separately so the orchestrator's intent text can name the
   * retryable failure count without re-filtering client-side.
   */
  retryable: Array<{ id: string; count: number; minRetryBudgetLeft?: number }>;
}

/**
 * Parse an auditor report (markdown) into a structured summary.
 * Pure function — caller handles file I/O.
 *
 * Recognizes:
 *   - "**CERTIFIED**" / "**NEEDS WORK**" / "**BLOCKED**" under
 *     "## Final Verdict" (or directly after "**Verdict**")
 *   - Findings as bullet lines under "## Concerns" section
 */
export function parseAuditReport(
  taskId: string,
  content: string | null,
): TaskAuditSummary {
  if (content === null) {
    return { task_id: taskId, has_report: false, findings_total: 0 };
  }

  // Verdict: first match after "Final Verdict" heading, else anywhere.
  const verdictMatch = content.match(
    /\*\*Final\s+Verdict\*\*[\s\S]*?\*\*(CERTIFIED|NEEDS WORK|BLOCKED)\*\*/i,
  ) ?? content.match(/\*\*(CERTIFIED|NEEDS WORK|BLOCKED)\*\*/i);
  const verdict: SubagentVerdict = (verdictMatch?.[1] as SubagentVerdict) ?? "UNKNOWN";

  // Findings: count bullet lines under "## Concerns" if present, else 0.
  const concernsMatch = content.match(/##\s+Concerns\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i);
  const findingsTotal = concernsMatch
    ? (concernsMatch[1].match(/^\s*-\s+/gm) ?? []).length
    : 0;

  return {
    task_id: taskId,
    has_report: true,
    verdict,
    findings_total: findingsTotal,
  };
}

/**
 * Roll up per-task audit reports into a workflow-level summary.
 * Pure function — caller supplies the report contents map.
 *
 * Use this in `initAudit` to compute `workflowReady` / `blockingTasks` so the
 * LLM can see at a glance whether the workflow is ready to finalize.
 */
export function aggregateTaskAudits(
	tasks: TaskNode[],
	reports: Map<string, string | null>,
): WorkflowAuditSummary {
	const summaries: TaskAuditSummary[] = tasks.map((t) =>
		parseAuditReport(t.id, reports.get(t.id) ?? null),
	);
	const blockingTasks = summaries
		.filter((s) => !s.has_report || s.verdict !== "CERTIFIED")
		.map((s) => s.task_id);
	return {
		tasks: summaries,
		workflowReady: blockingTasks.length === 0,
		blockingTasks,
	};
}

/**
 * GC-2026-044 mechanism 1.3/1.4 (design §5.6): roll up the diagnostics that
 * sub-agents wrote during this workflow, bucketed by the failure-mode `cause`.
 *
 * The two mechanisms share one vocabulary — `DiagnosticJsonV1.cause` is a
 * failure-catalog id — which is what makes this aggregation possible at all.
 * Before it, a failed dispatch left only a string in a tool result, so "which
 * failure mode dominates this workflow?" was not an answerable question.
 *
 * Read-only and never throws: a corrupt or absent diagnostics directory yields
 * empty stats rather than failing the audit that came to inspect it.
 */
export function gatherFailureModeStats(
	cwd: string,
	dagId?: string,
): FailureModeStats {
	const all = readAllDiagnostics(join(cwd, DIAGNOSTICS_RELDIR)) as any[];
	const scoped =
		dagId === undefined
			? all
			: all.filter((d: any) => d.context?.dagId === dagId);

	// GC-2026-070: bucket also tracks the per-bucket minimum retryBudgetLeft
	// and the handler kind from the catalog (so the orchestrator can see at a
	// glance which failures are retryable vs. escalation-required).
	const buckets = new Map<
		string,
		{ count: number; latest: string; minBudget: number | undefined }
	>();
	const byOutcome: Record<string, number> = {};

	// Lazy-load the catalog so unknown causes don't throw — we already handle
	// unknown via `?? undefined` on the lookup result below.
	const catalog = (() => {
		try {
			// @ts-ignore -- tsc rejects cross-package imports under rootDir.
			return require("../../pi-subagents/src/failure-catalog.js").getFailureCatalog(cwd);
		} catch {
			return null;
		}
	})();

	for (const d of scoped) {
		const prior = buckets.get(d.cause);
		if (prior === undefined) {
			buckets.set(d.cause, {
				count: 1,
				latest: d.emittedAt,
				minBudget:
					typeof d.retryBudgetLeft === "number" ? d.retryBudgetLeft : undefined,
			});
		} else {
			prior.count++;
			if (d.emittedAt > prior.latest) prior.latest = d.emittedAt;
			if (typeof d.retryBudgetLeft === "number") {
				prior.minBudget =
					prior.minBudget === undefined
						? d.retryBudgetLeft
						: Math.min(prior.minBudget, d.retryBudgetLeft);
			}
		}
		byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
	}

	const byCause = [...buckets.entries()]
		.map(([id, v]) => {
			const mode = catalog?.lookup?.(id);
			return {
				id,
				count: v.count,
				latest: v.latest,
				handlerKind: mode?.kind,
				minRetryBudgetLeft: v.minBudget,
			};
		})
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

	// GC-2026-070: a separate view of retryable buckets so the orchestrator
	// doesn't have to filter client-side.
	const retryable = byCause
		.filter((s) => s.handlerKind === "spec" && s.minRetryBudgetLeft !== 0)
		.map((s) => ({ id: s.id, count: s.count, minRetryBudgetLeft: s.minRetryBudgetLeft }));

	return { total: scoped.length, byCause, byOutcome, retryable };
}

/**
 * GC-2026-041: Inline governance check is REMOVED. The full 5-rule
 * extractAuditFindings from pi-subagents is now used directly in the
 * audit-init flow. The inline subset is gone.
 */
export function runInlineGovernanceCheck(
	_taskId: string,
	_taskReportText: string,
): Array<unknown> {
	// Deprecated: kept as a no-op stub for backward compat. Use
	// extractAuditFindings from pi-subagents instead.
	return [];
}

/**
 * Read each task's audit-*.md report from disk. Returns a map keyed by task
 * id; missing or unreadable files map to null.
 *
 * This is the A3 glue: the orchestrator_audit tool at workflow level reads
 * auditor's per-task reports rather than re-running the audit.
 */
function readAuditReports(cwd: string, tasks: TaskNode[]): Map<string, string | null> {
	const reports = new Map<string, string | null>();
	for (const t of tasks) {
		const path = taskAuditPath(cwd, t.id);
		if (existsSync(path)) {
			try {
				reports.set(t.id, readFileSync(path, "utf-8"));
			} catch {
				reports.set(t.id, null);
			}
		} else {
			reports.set(t.id, null);
		}
	}
	return reports;
}

/**
 * GC-2026-039: Read each task's report (task-{id}-report.md) for
 * runtime enforcement checks. Returns a map keyed by task id; missing
 * or unreadable files map to null.
 *
 * The task report is what the sub-agent developer (or orchestrator fallback)
 * writes at the end of a task. It contains the agent's last message
 * embedded in markdown + a structured summary by the orchestrator.
 */
function readTaskReports(cwd: string, tasks: TaskNode[]): Map<string, string | null> {
	const reports = new Map<string, string | null>();
	for (const t of tasks) {
		const path = join(cwd, ".pi", "orchestrator", `task-${t.id}-report.md`);
		if (existsSync(path)) {
			try {
				reports.set(t.id, readFileSync(path, "utf-8"));
			} catch {
				reports.set(t.id, null);
			}
		} else {
			reports.set(t.id, null);
		}
	}
	return reports;
}

/**
 * Build workflow-level phase guidance (A3 — the per-task details are now
 * handled by auditor; this tool focuses on cross-task concerns).
 */
function buildWorkflowPhaseGuidance(phases: string[]): Record<string, string> {
  const g: Record<string, string> = {};
  if (phases.includes("ink")) {
    g.ink = "INK — verify each task has an auditor report at .pi/orchestrator/audit-{id}.md. `workflowReady=true` means all tasks are certified. Missing/blocked reports are listed in `blockingTasks`.";
  }
  if (phases.includes("nose")) {
    g.nose = "NOSE — cross-check SC coverage across all tasks. Goal contract at .pi/orchestrator/goal-{id}.yaml. Each SC must be covered by at least one task's acceptance.covers AND that task's audit must be CERTIFIED.";
  }
  if (phases.includes("foot")) {
    g.foot = "FOOT — OPTIONAL re-run of goal-contract verification_cmd (auditor already ran them per-task). Use only for cross-cutting SCs that span multiple tasks (e.g., end-to-end integration tests).";
  }
  if (phases.includes("castration")) {
    g.castration = "CASTRATION — workflow-level security: no orphaned worktrees, no shared secrets across tasks, no inconsistent auth patterns across the codebase.";
  }
  if (phases.includes("death")) {
    g.death = "DEATH — long-term viability: no orphaned branches, no drive-by refactoring across task boundaries, dependencies actually used.";
  }
  return g;
}

/**
 * Helper for the LLM to write the final audit report. Called when the LLM
 * passes `observation.complete` (the `complete` field, NOT `audit_complete`).
 *
 * The report is written at the caller-supplied path. When the LLM does not
 * specify scope, the report lands at the canonical `audit-workflow.md`.
 */
export function writeAuditReport(
  cwd: string,
  result: OrchestratorAuditResult,
  reportPath?: string,
): string {
  const dir = join(cwd, ORCHESTRATOR_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const path = reportPath ?? join(cwd, ORCHESTRATOR_DIR, WORKFLOW_AUDIT);
  const lines: string[] = [];
  lines.push(`# Orchestrator Audit — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`**Verdict**: ${result.verdict}`);
  lines.push(`**Score**: ${result.score}/100`);
  lines.push("");
  lines.push(`**Summary**: ${result.summary}`);
  lines.push("");
  lines.push("## Findings");
  for (const f of result.findings) {
    lines.push(`### [${f.category}/${f.severity}] ${f.task_id ?? "workflow"}`);
    lines.push(`- **Issue**: ${f.issue}`);
    if (f.evidence) lines.push(`- **Evidence**: ${f.evidence}`);
    if (f.recommendation) lines.push(`- **Recommendation**: ${f.recommendation}`);
    lines.push("");
  }

  // Namespace ownership check — only auditor-owned audit-{task|batch|scope}.md
  // and orchestrator-owned audit-workflow.md / audit-rollup-*.md may be written from
  // this tool. Without this guard, a state-prefixed report path could
  // accidentally cross a namespace boundary.
  const relative = path.replace(`${cwd}/${ORCHESTRATOR_DIR}/`, "").replaceAll("\\", "/");
  const owner: "auditor" | "orchestrator" = relative === WORKFLOW_AUDIT || relative.startsWith("audit-rollup-")
    ? "orchestrator"
    : "auditor";
  atomicWriteOrchestratorText(cwd, relative, lines.join("\n"), owner);
  return path;
}

function sameIdentity(a: AuditIdentity, b: AuditIdentity): boolean {
  return a.dag_id === b.dag_id && a.scope === b.scope && a.scope_key === b.scope_key && a.depth === b.depth;
}
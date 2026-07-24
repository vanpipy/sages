/**
 * Orchestrator Audit Tool
 *
 * Stage 4 of orchestrator workflow: workflow-level audit rollup.
 *
 * A3 split: per-task audit (re-run verification_cmd, inspect diff, check TDD
 * discipline) is delegated to the `software-auditor` subagent, which writes
 * `.pi/orchestrator/audit-{task_id}.md`. This tool pools those per-task
 * reports and aggregates them into a workflow-level view — focusing on
 * cross-task consistency, SC coverage, and integration-level concerns.
 *
 * Phases (A3 scope — workflow-level unless noted):
 *   - ink:       verify each task has a software-auditor report AND it's CERTIFIED
 *   - nose:      cross-check SC coverage across all tasks (goal contract)
 *   - foot:      OPTIONAL re-run of cross-cutting verification_cmd (per-task
 *                verification is software-auditor's job)
 *   - castration: workflow-level security (full only) — orphaned worktrees,
 *                shared secrets across tasks
 *   - death:     long-term viability (full only) — orphaned branches, drive-by
 *                refactoring across task boundaries
 *
 * Output: writes markdown report + returns verdict + score + findings.
 */

import { Type, type Static } from "typebox";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
  taskAuditPath,
  WORKFLOW_AUDIT,
} from "./types.js";
import { loadPlan } from "./dag-synthesizer.js";

export const OrchestratorAuditParams = Type.Object({
  dag_id: Type.String({ description: "DAG id" }),
  /** If omitted, audit the whole DAG; if set, audit only this batch */
  batch: Type.Optional(Type.Number({ description: "Batch number to audit (omit for whole DAG)" })),
  /** If set, audit only this task within the DAG */
  task_id: Type.Optional(Type.String({ description: "Single task id to audit" })),
  /** Sub-mode: 'fast' = quick checks (ink+nose+foot); 'full' = all 5 phases */
  depth: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("full")])),
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
    complete: Type.Optional(Type.Object({
      verdict: Type.Union([Type.Literal("PASS"), Type.Literal("REVISE"), Type.Literal("REJECT")]),
      score: Type.Number({ minimum: 0, maximum: 100 }),
      summary: Type.String({ minLength: 1 }),
    }, { description: "Finalize the audit" })),
  }, { description: "Audit progress: record a finding or complete the audit" })),
});

export type OrchestratorAuditInput = Static<typeof OrchestratorAuditParams>;

/** Persisted state file name. Lives at .pi/orchestrator/audit-state-{dag_id}.yaml */
function auditStatePath(cwd: string, dagId: string): string {
  return join(cwd, ORCHESTRATOR_DIR, `audit-state-${dagId}.yaml`);
}

/** Audit state — persisted between tool calls so LLM can resume after context compaction. */
export interface AuditState {
  dag_id: string;
  plan: OrchestrationPlan;
  tasks: TaskNode[];
  findings: OrchestratorFinding[];
  score: number;
  depth: "fast" | "full";
  created_at: string;
  updated_at: string;
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
  const dir = join(cwd, ORCHESTRATOR_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    auditStatePath(cwd, state.dag_id),
    yaml.dump(state, { indent: 2, lineWidth: 120, noRefs: true }),
    "utf-8",
  );
  // Lock down file permissions too (state file may contain SC details)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try { require("node:fs").chmodSync(auditStatePath(cwd, state.dag_id), 0o600); } catch { /* best-effort */ }
}

/**
 * Tool registration. The actual audit work is done by the LLM using semantic tools
 * (file read, aft_search, bash to re-run verification_cmd, etc.). This tool
 * provides the structured framework + persists state + writes the final report.
 *
 * Lifecycle:
 *   1. First call (no observation): init AuditState, persist, return phase guidance
 *   2. Subsequent calls with observation.finding: append finding, persist
 *   3. Final call with observation.complete: write report, return verdict
 *
 * State is persisted to .pi/orchestrator/audit-state-{dag_id}.yaml between
 * calls so the audit can survive context compaction.
 */
export function registerOrchestratorAuditTool(pi: any): void {
  pi.registerTool({
    name: "orchestrator_audit",
    label: "Orchestrator Audit",
    description: "Stage 4: workflow-level audit rollup (A3). Reads software-auditor reports, aggregates verdicts, surfaces cross-task findings. Default depth fast (3 phases: ink/nose/foot); pass depth:full for castration/death. State persists between calls. Verdict: PASS/REVISE/REJECT with score.",
    parameters: OrchestratorAuditParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd: string = ctx.cwd;
      // Default to "fast" depth (3 phases: ink/nose/foot). The full 5-phase
      // audit is opt-in via depth: "full" — saves 40% audit time on routine
      // workflows where castration/death aren't relevant.
      const depth = params.depth ?? "fast";

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

      // ── Path 1: Complete the audit ────────────────────────────────
      if (params.observation?.complete) {
        return await completeAudit(cwd, plan, params, tasks);
      }

      // ── Path 2: Record findings (single `finding` OR batch `findings[]`) ──
      const singleFinding = params.observation?.finding;
      const batchFindings = params.observation?.findings;
      if (singleFinding || (batchFindings && batchFindings.length > 0)) {
        return await recordFindings(cwd, plan, params, tasks, depth);
      }

      // ── Path 3: Init the audit (first call, no observation) ───────
      return await initAudit(cwd, plan, params, tasks, depth);
    },
  });
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
  const state: AuditState = {
    dag_id: plan.id,
    plan,
    tasks,
    findings: [],
    score: 100,
    depth,
    created_at: now,
    updated_at: now,
  };
  saveAuditState(cwd, state);

  const phases = getPhasesForDepth(depth);
  const phaseGuidance = buildWorkflowPhaseGuidance(phases);

  // A3 — read software-auditor's per-task reports and aggregate
  const reports = readAuditReports(cwd, tasks);
  const workflowSummary = aggregateTaskAudits(tasks, reports);

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "in_progress",
      phase: "audit-init",
      intent: `Audit initialized for ${tasks.length} task(s). workflowReady=${workflowSummary.workflowReady}. ${workflowSummary.blockingTasks.length > 0 ? `Blocking: ${workflowSummary.blockingTasks.join(", ")}. Run any remaining tasks + audits, then record findings in a single batch call to finalize.` : "All tasks certified — submit your workflow-level findings (or pass with 0 findings) and complete."}`,
      validation: {
        errors: workflowSummary.workflowReady ? [] : [`tasks not yet certified: ${workflowSummary.blockingTasks.join(", ")}`],
        warnings: [],
        files_required: [auditStatePath(cwd, plan.id)],
        findings_required_min: depth === "fast" ? 1 : 3,
      },
      phases,
      phase_guidance: phaseGuidance,
      workflow_summary: workflowSummary,
      tasks_to_audit: tasks.map(t => ({
        id: t.id,
        description: t.description,
        subagent_type: t.subagent_type,
        acceptance_covers: t.acceptance.covers,
        self_check_cmd: t.acceptance.self_check_cmd,
        report_path: taskAuditPath(cwd, t.id),
      })),
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

  const { verdict, score, summary } = params.observation.complete;

  // Recompute score from findings (don't trust the LLM-supplied score blindly)
  const computedScore = computeScore(state.findings);
  const finalScore = Math.min(score, computedScore);

  // Build the result + write the report
  const result: OrchestratorAuditResult = {
    verdict,
    score: finalScore,
    findings: state.findings,
    report_path: taskAuditPath(cwd, params.task_id ?? params.batch?.toString() ?? "workflow"),
    summary,
  };

  // Update state to finalized
  state.score = finalScore;
  state.updated_at = new Date().toISOString();
  saveAuditState(cwd, state);

  // Write the markdown report (separate from state file)
  writeAuditReport(cwd, result);

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "complete",
      phase: "audit-complete",
      intent: `Audit complete. Verdict: ${verdict}, score: ${finalScore}/100. Report at ${result.report_path}.`,
      validation: {
        errors: [],
        warnings: [],
        files_required: [result.report_path, auditStatePath(cwd, plan.id)],
      },
      verdict,
      score: finalScore,
      findings: state.findings,
      summary,
      report_path: result.report_path,
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
// A3 — workflow-level audit aggregation (read software-auditor's reports)
// ─────────────────────────────────────────────────────────────────────────────

/** Verdict strings emitted by software-auditor subagent (per SUBAGENTS.md). */
export type SubagentVerdict = "CERTIFIED" | "NEEDS WORK" | "BLOCKED" | "UNKNOWN";

/** Per-task summary extracted from a software-auditor audit report. */
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

/**
 * Parse a software-auditor report (markdown) into a structured summary.
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
 * Read each task's audit-*.md report from disk. Returns a map keyed by task
 * id; missing or unreadable files map to null.
 *
 * This is the A3 glue: the orchestrator_audit tool at workflow level reads
 * software-auditor's per-task reports rather than re-running the audit.
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
 * Build workflow-level phase guidance (A3 — the per-task details are now
 * handled by software-auditor; this tool focuses on cross-task concerns).
 */
function buildWorkflowPhaseGuidance(phases: string[]): Record<string, string> {
  const g: Record<string, string> = {};
  if (phases.includes("ink")) {
    g.ink = "INK — verify each task has a software-auditor report at .pi/orchestrator/audit-{id}.md. `workflowReady=true` means all tasks are certified. Missing/blocked reports are listed in `blockingTasks`.";
  }
  if (phases.includes("nose")) {
    g.nose = "NOSE — cross-check SC coverage across all tasks. Goal contract at .pi/orchestrator/goal-{id}.yaml. Each SC must be covered by at least one task's acceptance.covers AND that task's audit must be CERTIFIED.";
  }
  if (phases.includes("foot")) {
    g.foot = "FOOT — OPTIONAL re-run of goal-contract verification_cmd (software-auditor already ran them per-task). Use only for cross-cutting SCs that span multiple tasks (e.g., end-to-end integration tests).";
  }
  if (phases.includes("castration")) {
    g.castration = "CASTRATION — workflow-level security: no orphaned worktrees, no shared secrets across tasks, no inconsistent auth patterns across the codebase.";
  }
  if (phases.includes("death")) {
    g.death = "DEATH — long-term viability: no orphaned branches, no drive-by refactoring across task boundaries, dependencies actually used.";
  }
  return g;
}

export function buildPhaseGuidance(tasks: TaskNode[], phases: string[]): Record<string, string> {
  const guidance: Record<string, string> = {};

  if (phases.includes("ink")) {
    guidance.ink = "INK — verify each task has evidence: a report file at .pi/orchestrator/task-{id}-report.md with file paths and command output. No narrative without evidence. Each missing report = 1 minor finding.";
  }
  if (phases.includes("nose")) {
    guidance.nose = `NOSE — verify alignment with goal-contract. For each task, check its acceptance.covers SC ids match what was actually delivered. Re-read the goal contract at .pi/orchestrator/goal-*.yaml.`;
  }
  if (phases.includes("foot")) {
    guidance.foot = `FOOT — re-run verification_cmd for every success_criterion the tasks cover. Capture exit codes + output. Any failure = critical finding.`;
  }
  if (phases.includes("castration")) {
    guidance.castration = "CASTRATION — security check. Use grep/aft_search for: hardcoded secrets, raw SQL with concatenation, eval/exec, missing input validation, prompt-injection sinks, unsafe worktree merge patterns.";
  }
  if (phases.includes("death")) {
    guidance.death = "DEATH — long-term viability. Check: new tests added (not just modifications), no drive-by refactoring outside scope, dependencies actually used, worktree branches not polluted with stale commits.";
  }

  return guidance;
}

/**
 * Helper for the LLM to write the final audit report.
 * Called when the LLM passes observation.audit_complete=true.
 */
export function writeAuditReport(
  cwd: string,
  result: OrchestratorAuditResult,
): string {
  const dir = join(cwd, ORCHESTRATOR_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const path = join(cwd, ORCHESTRATOR_DIR, WORKFLOW_AUDIT);
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

  writeFileSync(path, lines.join("\n"), "utf-8");
  return path;
}
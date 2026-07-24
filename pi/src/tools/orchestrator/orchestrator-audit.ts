/**
 * Orchestrator Audit Tool
 *
 * Stage 4 of orchestrator workflow: 5-phase audit on a single task or the
 * whole DAG. The phase vocabulary (ink / nose / foot / castration / death)
 * is the legacy inherited from the now-removed GaoYao role tool — kept
 * because it remains a useful audit discipline, but the tool itself is
 * the only auditor in the package now.
 *
 * Phases:
 *   - ink:       every claim has evidence (file paths, command output)
 *   - nose:      alignment with goal-contract.success_criteria
 *   - foot:      actually runs (typecheck / lint / test) — re-executes verification_cmd
 *   - castration: security / isolation (no hardcoded secrets, no risky patterns)
 *   - death:     long-term viability (tests added, no new tech debt, worktree clean)
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
   */
  observation: Type.Optional(Type.Object({
    /** Finding to record (one per call) */
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
    description: "Stage 4: 5-phase audit (ink/nose/foot/castration/death). State persists between calls. Verdict: PASS/REVISE/REJECT with score.",
    parameters: OrchestratorAuditParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd: string = ctx.cwd;
      const depth = params.depth ?? "full";

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

      // ── Path 2: Record a finding ──────────────────────────────────
      if (params.observation?.finding) {
        return await recordFinding(cwd, plan, params, tasks, depth);
      }

      // ── Path 3: Init the audit (first call, no observation) ───────
      return await initAudit(cwd, plan, params, tasks, depth);
    },
  });
}

/** Init: create state file + return phase guidance. */
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

  const phases = depth === "fast"
    ? ["ink", "nose", "foot"]
    : ["ink", "nose", "foot", "castration", "death"];
  const phaseGuidance = buildPhaseGuidance(tasks, phases);

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "in_progress",
      phase: "audit-init",
      intent: `Audit initialized for ${tasks.length} task(s). Run each phase, calling orchestrator_audit({ observation: { finding: {...} } }) to record findings. When done, pass observation: { complete: { verdict, score, summary } } to finalize.`,
      validation: {
        errors: [],
        warnings: [],
        files_required: [auditStatePath(cwd, plan.id)],
        findings_required_min: depth === "fast" ? 1 : 3,
      },
      phases,
      phase_guidance: phaseGuidance,
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

/** Record: load state, append finding, persist, return updated count. */
async function recordFinding(
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

  const f: OrchestratorFinding = params.observation.finding;
  state.findings.push(f);
  state.score = computeScore(state.findings);
  state.updated_at = new Date().toISOString();
  saveAuditState(cwd, state);

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "in_progress",
      phase: "audit-recording",
      intent: `Finding recorded. ${state.findings.length} finding(s) total, current score: ${state.score}. Continue auditing or call with observation.complete to finalize.`,
      validation: {
        errors: [],
        warnings: [],
        files_required: [auditStatePath(cwd, plan.id)],
      },
      findings_count: state.findings.length,
      score: state.score,
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

/** Compute a 0-100 score from findings. Critical findings heavily penalize. */
function computeScore(findings: OrchestratorFinding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.severity === "critical") score -= 30;
    else if (f.severity === "major") score -= 10;
    else if (f.severity === "minor") score -= 2;
  }
  return Math.max(0, score);
}

function buildPhaseGuidance(tasks: TaskNode[], phases: string[]): Record<string, string> {
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
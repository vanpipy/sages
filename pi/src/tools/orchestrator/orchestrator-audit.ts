/**
 * Orchestrator Audit Tool
 *
 * Stage 4 of orchestrator workflow: GaoYao-style 5-phase audit on a single task
 * or the whole DAG. Complements (does not replace) the sages gaoyao_audit tool:
 *   - gaoyao_audit: audits ONE workflow (process-level, uses .sages/workspace/audit.md)
 *   - orchestrator_audit: audits orchestrator-managed tasks (uses .pi/orchestrator/audit-*.md)
 *
 * Phases (mirror gaoyao's INK/NOSE/FOOT/CASTRATION/DEATH):
 *   - ink:       every claim has evidence (file paths, command output)
 *   - nose:      alignment with goal-contract.success_criteria
 *   - foot:      actually runs (typecheck / lint / test) — re-executes verification_cmd
 *   - castration: security / isolation (no hardcoded secrets, no risky patterns)
 *   - death:     long-term viability (tests added, no new tech debt, worktree clean)
 *
 * Output: writes markdown report + returns verdict + score + findings.
 */

import { Type, type Static } from "typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
});

export type OrchestratorAuditInput = Static<typeof OrchestratorAuditParams>;

interface AuditState {
  plan: OrchestrationPlan;
  tasks: TaskNode[];
  findings: OrchestratorFinding[];
  /** Score accumulated 0-100, capped */
  score: number;
  /** Whether a CRITICAL finding was raised (auto-REJECT) */
  hasCritical: boolean;
}

/**
 * Tool registration. The actual audit work is done by the LLM using semantic tools
 * (file read, aft_search, bash to re-run verification_cmd, etc.). This tool
 * provides the structured framework + writes the report.
 */
export function registerOrchestratorAuditTool(pi: any): void {
  pi.registerTool({
    name: "orchestrator_audit",
    label: "Orchestrator Audit",
    description: "5-phase audit (ink/nose/foot/castration/death) on orchestrator-managed tasks. Writes report to .pi/orchestrator/. Verdict: PASS/REVISE/REJECT with score.",
    parameters: OrchestratorAuditParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd: string = ctx.cwd;
      const depth = params.depth ?? "full";

      const plan = loadPlan(cwd, params.dag_id);
      if (!plan) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            intent: `DAG ${params.dag_id} not found.`,
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

      // Initialize audit state — the LLM will mutate findings[] as it runs each phase
      const state: AuditState = {
        plan,
        tasks,
        findings: [],
        score: 100,
        hasCritical: false,
      };

      // Provide phase-by-phase guidance for the LLM
      const phases = depth === "fast"
        ? ["ink", "nose", "foot"]
        : ["ink", "nose", "foot", "castration", "death"];

      const phaseGuidance = buildPhaseGuidance(tasks, phases);

      // Return contract for LLM to perform audit (state will be passed back via observation)
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "in_progress",
          phase: "audit-init",
          intent: `Audit initialized for ${tasks.length} task(s). Run each phase below, recording findings. When complete, re-call orchestrator_audit with observation.audit_complete=true and pass the final findings array.`,
          validation: {
            errors: [],
            warnings: [],
            files_required: [taskAuditPath(cwd, params.task_id ?? params.batch?.toString() ?? "workflow")],
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
          state_for_observation: state,
        }) }],
        details: { state, phases },
      };
    },
  });
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
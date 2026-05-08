/**
 * Fuxi Tools (伏羲) - Architect 
 * 
 * MDD Seven Planes:
 * 1. Business Plane - Process × Rules
 * 2. Data Plane - Logic × State
 * 3. Control Plane - Strategy × Distribution
 * 4. Foundation Plane - Resource × Abstraction
 * 5. Observation Plane - Data × Analysis
 * 6. Security Plane - Identity × Permissions
 * 7. Evolution Plane - Time × Change
 * 
 * Design Mode Rules:
 * - ✅ Only modify draft.md
 * - ❌ Read-only for all other files
 * - ❌ No code writing in design phase
 * 
 * Phase modes:
 * - design: read-only, only draft.md
 * - plan: read-only, plan.md, execution.yaml
 * - implement: writeable, all files
 * - review: read-only, audit.md
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMinimalDraft } from "../utils/draft-generator.js";

const WORKSPACE_DIR = ".sages/workspace";
const ARCHIVE_DIR = ".sages/archive";
const SESSIONS_DIR = ".sages/sessions";

export type FuxiPhase = "idle" | "design" | "plan" | "implement" | "review" | "complete";

interface WorkflowState {
  id: string;
  phase: FuxiPhase;
  planName: string;
  request: string;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

function ensureWorkspaceDirs(cwd: string): string {
  const workspacePath = join(cwd, WORKSPACE_DIR);
  const sessionsPath = join(cwd, SESSIONS_DIR);
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }
  if (!existsSync(sessionsPath)) {
    mkdirSync(sessionsPath, { recursive: true });
  }
  return workspacePath;
}

/**
 * Extract plan name from request text
 */
function extractPlanName(content: string): string {
  const words = content.trim().split(/\s+/).slice(0, 4);
  return words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()).join("-");
}

/**
 * Get current workflow state
 */
function getWorkflowState(cwd: string): { state: WorkflowState | null; workspacePath: string } {
  const workspacePath = join(cwd, WORKSPACE_DIR);
  const statePath = join(workspacePath, "state.json");

  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
      return { state, workspacePath };
    } catch { /* ignore */ }
  }

  return { state: null, workspacePath };
}

/**
 * Save workflow state
 */
function saveWorkflowState(cwd: string, state: WorkflowState): string {
  const workspacePath = ensureWorkspaceDirs(cwd);
  const statePath = join(workspacePath, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return statePath;
}

/**
 * Archive workflow to .sages/archive/{planName}/{timestamp}/
 */
function archiveWorkflow(cwd: string, state: WorkflowState): string | null {
  const archivePath = join(cwd, ARCHIVE_DIR);
  if (!existsSync(archivePath)) {
    mkdirSync(archivePath, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workflowArchivePath = join(archivePath, state.planName, timestamp);
  mkdirSync(workflowArchivePath, { recursive: true });

  // Copy workspace files
  const workspacePath = join(cwd, WORKSPACE_DIR);
  const files = ["draft.md", "plan.md", "execution.yaml", "state.json"];
  const archivedFiles: string[] = [];

  for (const file of files) {
    const srcPath = join(workspacePath, file);
    if (existsSync(srcPath)) {
      writeFileSync(join(workflowArchivePath, file), readFileSync(srcPath));
      archivedFiles.push(file);
    }
  }

  // Create summary
  const summary = `# Workflow Archive: ${state.planName}

**Phase**: ${state.phase}
**Request**: ${state.request}
**Archived**: ${new Date().toISOString()}

**Files**: ${archivedFiles.join(", ")}

---
*Archived by Fuxi Workflow*
`;
  writeFileSync(join(workflowArchivePath, "summary.md"), summary);

  return workflowArchivePath;
}

export function registerFuxiTools(pi: ExtensionAPI): void {

  /**
   * fuxi_start - Start workflow, set design phase in state.json
   * Design Mode (Read-Only): Only modify draft.md
   */
  pi.registerTool({
    name: "fuxi_start",
    label: "Start Workflow",
    description: "Start workflow - set design phase in state.json. Creates state.json with planName and request.",
    parameters: Type.Object({
      plan_name: Type.String({ description: "Plan name (e.g., 'my-feature')" }),
      request: Type.String({ description: "User's feature request or description" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const now = new Date().toISOString();

      const state: WorkflowState = {
        id: `sages-${Date.now()}`,
        phase: "design",
        planName: params.plan_name,
        request: params.request,
        createdAt: now,
        updatedAt: now,
      };

      const statePath = saveWorkflowState(cwd, state);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow started: ${params.plan_name}`,
            phase: "design",
            state_path: statePath,
          }),
        }],
        details: { phase: "design", state },
      };
    },
  });

  /**
   * fuxi_request - Create MDD design draft using Seven Planes analysis
   * Creates draft.md with: Business, Data, Control, Foundation, Observation, Security, Evolution planes
   */
  pi.registerTool({
    name: "fuxi_request",
    label: "Create Draft",
    description: "Create MDD design draft (draft.md) using Seven Planes analysis. Outputs overview, plane analysis, cross-plane deps, decisions, questions.",
    parameters: Type.Object({
      request: Type.String({ description: "User's request to create draft for" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const workspacePath = ensureWorkspaceDirs(cwd);
      const { state } = getWorkflowState(cwd);

      const planName = state?.planName || extractPlanName(params.request);
      const draftPath = join(workspacePath, "draft.md");
      const draft = generateMinimalDraft(planName, params.request);

      writeFileSync(draftPath, draft);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            draft_path: draftPath,
            plan_name: planName,
            message: `Draft created: ${draftPath}`,
          }),
        }],
        details: { draftPath, planName },
      };
    },
  });

  /**
   * fuxi_plan - Transition to plan phase (only if score > 80)
   * Updates state phase to "plan" if score > 80
   */
  pi.registerTool({
    name: "fuxi_plan",
    label: "Start Plan",
    description: "Transition to plan phase - only if score > 80. Updates phase to 'plan' in state.json.",
    parameters: Type.Object({
      score: Type.Number({ description: "Review score (must be > 80)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { state } = getWorkflowState(cwd);

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No active workflow. Use /fuxi-start first.",
            }),
          }],
          isError: true,
          details: { error: "no_workflow" },
        };
      }

      if (params.score <= 80) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Score ${params.score} <= 80. Plan can only start when score > 80.`,
            }),
          }],
          isError: true,
          details: { error: "score_too_low", score: params.score },
        };
      }

      // Update phase to plan
      state.phase = "plan";
      state.score = params.score;
      state.updatedAt = new Date().toISOString();
      const statePath = saveWorkflowState(cwd, state);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Plan phase started (score: ${params.score})`,
            phase: "plan",
            state_path: statePath,
          }),
        }],
        details: { phase: "plan", score: params.score },
      };
    },
  });

  /**
   * fuxi_recover - Recover workflow from state.json
   * Returns current phase, planName, and workspace path
   */
  pi.registerTool({
    name: "fuxi_recover",
    label: "Recover Workflow",
    description: "Recover workflow from state.json. Returns state with phase, planName, request, score, workspace path.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { state, workspacePath } = getWorkflowState(cwd);

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No workflow state found. Use /fuxi-start to start a new workflow.",
            }),
          }],
          isError: true,
          details: { error: "no_workflow" },
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            state: {
              id: state.id,
              phase: state.phase,
              plan_name: state.planName,
              request: state.request,
              score: state.score,
            },
            workspace_path: workspacePath,
            message: `Workflow recovered: ${state.planName} (phase: ${state.phase})`,
          }),
        }],
        details: { state, workspacePath },
      };
    },
  });

  /**
   * fuxi_end - End workflow, archive to .sages/archive/{plan}/{timestamp}/, set phase to complete
   */
  pi.registerTool({
    name: "fuxi_end",
    label: "End Workflow",
    description: "End workflow, archive to .sages/archive/{plan}/{timestamp}/, and set phase to 'complete'. Archives all workspace files.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { state } = getWorkflowState(cwd);

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No active workflow to end.",
            }),
          }],
          isError: true,
          details: { error: "no_active_workflow" },
        };
      }

      // Set phase to complete
      state.phase = "complete";
      state.updatedAt = new Date().toISOString();

      // Archive workflow
      const archivePath = archiveWorkflow(cwd, state);

      // Clear workspace
      const workspacePath = join(cwd, WORKSPACE_DIR);
      const statePath = join(workspacePath, "state.json");
      if (existsSync(statePath)) {
        // Already saved in archive
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow ended and archived: ${state.planName}`,
            archive_path: archivePath,
            phase: "complete",
          }),
        }],
        details: { archivePath, phase: "complete" },
      };
    },
  });

  /**
   * fuxi_get_status - Get current workflow status from state.json (also callable as fuxi-get-status)
   * Returns: has_workflow, phase, planName, request, score, workspace_path
   */
  pi.registerTool({
    name: "fuxi_get_status",
    label: "Get Status",
    description: "Get current workflow status. Returns: has_workflow, phase, planName, request, score, workspace_path.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { state, workspacePath } = getWorkflowState(cwd);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            has_workflow: state !== null,
            phase: state?.phase || "idle",
            plan_name: state?.planName || null,
            request: state?.request || null,
            score: state?.score || null,
            workspace_path: workspacePath,
          }),
        }],
        details: { state },
      };
    },
  });

  /**
   * fuxi_update_score - Update review score in state (set by qiaochui-review)
   * Score thresholds: >80 proceed, 50-80 revise, <50 reject
   */
  pi.registerTool({
    name: "fuxi_update_score",
    label: "Update Score",
    description: "Update review score in state. Used by qiaochui-review. Score >80 allows plan phase.",
    parameters: Type.Object({
      score: Type.Number({ description: "Review score from qiaochui" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { state } = getWorkflowState(cwd);

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No active workflow.",
            }),
          }],
          isError: true,
          details: { error: "no_active_workflow" },
        };
      }

      state.score = params.score;
      state.updatedAt = new Date().toISOString();
      saveWorkflowState(cwd, state);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            score: params.score,
            can_start_plan: params.score > 80,
            message: `Score updated to ${params.score}. Can start plan: ${params.score > 80}`,
          }),
        }],
        details: { score: params.score },
      };
    },
  });
}
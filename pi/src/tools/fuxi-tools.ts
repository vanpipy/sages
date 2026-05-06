/**
 * Fuxi Tools - Design phase tools
 * Drafts are saved to .sages/workspace/draft.md
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMinimalDraft } from "../utils/draft-generator.js";

const WORKSPACE_DIR = ".sages/workspace";
const SESSIONS_DIR = ".sages/sessions";

interface WorkflowState {
  id: string;
  phase: "idle" | "design" | "review" | "plan" | "execute" | "audit" | "complete";
  planName: string;
  request: string;
  createdAt: string;
  updatedAt: string;
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
 * Check if there's an existing workflow that can be recovered
 */
function getExistingWorkflow(cwd: string): { hasDraft: boolean; hasState: boolean; state: WorkflowState | null } {
  const workspacePath = join(cwd, WORKSPACE_DIR);
  const draftPath = join(workspacePath, "draft.md");
  const statePath = join(workspacePath, "state.json");

  const hasDraft = existsSync(draftPath);
  const hasState = existsSync(statePath);
  let state: WorkflowState | null = null;

  if (hasState) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
    } catch { /* ignore */ }
  }

  return { hasDraft, hasState, state };
}

export function registerFuxiTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fuxi_create_draft",
    label: "Create Draft",
    description: "Create architectural design drafts using Multi-Dimensional Design (MDD) methodology",
    parameters: Type.Object({
      request: Type.String({ description: "User's request to analyze" }),
      name: Type.Optional(Type.String({ description: "Plan name (optional, derived from request)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { request, name } = params;

      try {
        const workspacePath = ensureWorkspaceDirs(cwd);
        const draftPath = join(workspacePath, "draft.md");

        // Check for existing workflow that can be recovered
        const existing = getExistingWorkflow(cwd);

        // If there's an existing draft with state, detect the phase
        let recoveryInfo: { planName?: string; phase?: string; request?: string } | null = null;
        if (existing.hasDraft && existing.hasState && existing.state) {
          recoveryInfo = {
            planName: existing.state.planName,
            phase: existing.state.phase,
            request: existing.state.request,
          };
        }

        // Generate plan name from request if not provided
        const planName = name || extractPlanName(request);

        const draft = generateMinimalDraft(planName, request);
        writeFileSync(draftPath, draft);

        // Update state.json if it exists, otherwise create it
        const statePath = join(workspacePath, "state.json");
        const now = new Date().toISOString();
        const state: WorkflowState = existing.state ? {
          ...existing.state,
          planName,
          request,
          phase: existing.state.phase === "idle" ? "design" : existing.state.phase,
          updatedAt: now,
        } : {
          id: `sages-${Date.now()}`,
          phase: "design",
          planName,
          request,
          createdAt: now,
          updatedAt: now,
        };
        writeFileSync(statePath, JSON.stringify(state, null, 2));

        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            draft_path: draftPath,
            timestamp: now,
            plan_name: planName,
            recovery: recoveryInfo ? {
              available: true,
              planName: recoveryInfo.planName,
              phase: recoveryInfo.phase,
              note: "Existing workflow detected. Draft updated with new request."
            } : { available: false }
          }) }],
          details: { draftPath, workspacePath, planName, recovery: recoveryInfo },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });

  pi.registerTool({
    name: "fuxi_get_draft",
    label: "Get Draft",
    description: "Read the current MDD design draft",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Draft path (default: .sages/workspace/draft.md)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const workspacePath = join(cwd, WORKSPACE_DIR);
      const draftPath = params.path || join(workspacePath, "draft.md");

      try {
        if (!existsSync(draftPath)) {
          // Check for recovery scenario - state exists but draft is missing
          const existing = getExistingWorkflow(cwd);
          if (existing.hasState && existing.state) {
            return {
              content: [{ type: "text", text: JSON.stringify({
                success: false,
                error: { message: "Draft not found, but existing workflow detected" },
                recovery: {
                  available: true,
                  planName: existing.state.planName,
                  phase: existing.state.phase,
                  request: existing.state.request,
                  hint: "Use fuxi_create_draft to regenerate the draft for this workflow"
                }
              }) }],
              isError: true,
              details: { draftPath, recovery: existing.state },
            };
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draftPath}` } }) }],
            isError: true,
            details: { draftPath },
          };
        }

        const content = readFileSync(draftPath, "utf-8");
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, path: draftPath, content }) }],
          details: { draftPath, contentLength: content.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });

  pi.registerTool({
    name: "fuxi_get_status",
    label: "Get Status",
    description: "Query MDD design status and workflow progress",
    parameters: Type.Object({
      plan_name: Type.Optional(Type.String({ description: "Plan name (optional)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const workspacePath = join(cwd, WORKSPACE_DIR);

      try {
        const draftPath = join(workspacePath, "draft.md");
        const planPath = join(workspacePath, "plan.md");
        const executionPath = join(workspacePath, "execution.yaml");
        const statePath = join(workspacePath, "state.json");
        const hasDraft = existsSync(draftPath);
        const hasPlan = existsSync(planPath);
        const hasExecution = existsSync(executionPath);
        const hasState = existsSync(statePath);

        // Load state for accurate phase detection
        let storedState: WorkflowState | null = null;
        if (hasState) {
          try {
            storedState = JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
          } catch { /* ignore */ }
        }

        // Determine status based on state.json first, then file existence
        let status = "idle";
        let nextStep = "";
        const planName = storedState?.planName || (hasDraft ? extractPlanName(readFileSync(draftPath, "utf-8").slice(0, 200)) : null);

        // Use stored phase if available, otherwise infer from files
        if (storedState && storedState.phase !== "idle") {
          status = storedState.phase;
          switch (storedState.phase) {
            case "design":
              nextStep = storedState.request ? "Review with qiaochui then decompose" : "Use qiaochui_review and qiaochui_decompose";
              break;
            case "review":
              nextStep = "Decompose with qiaochui_decompose";
              break;
            case "plan":
              nextStep = "Ready for execution (awaiting /fuxi-approve)";
              break;
            case "execute":
              nextStep = "Execute tasks with luban_execute_all";
              break;
            case "audit":
              nextStep = "Run audit with gaoyao_review";
              break;
            case "complete":
              nextStep = "Workflow complete - use /fuxi-archive to save";
              break;
          }
        } else if (hasDraft && !hasPlan) {
          status = "design";
          nextStep = "Use qiaochui_review then qiaochui_decompose";
        } else if (hasPlan && !hasExecution) {
          status = "plan";
          nextStep = "Ready for execution (awaiting approval)";
        } else if (hasExecution) {
          status = "ready";
          nextStep = "Use /fuxi-execute to run tasks";
        }

        let taskCount = 0;
        if (hasExecution) {
          try {
            const yamlContent = readFileSync(executionPath, "utf-8");
            const taskMatches = yamlContent.match(/^\s*-\s*id:\s*([A-Z][0-9]+)/gm);
            taskCount = taskMatches ? taskMatches.length : 0;
          } catch { /* ignore */ }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              status,
              workspace: workspacePath,
              plan_name: planName,
              has_draft: hasDraft,
              has_plan: hasPlan,
              has_execution: hasExecution,
              has_state: hasState,
              task_count: taskCount,
              next_step: nextStep,
              stored_phase: storedState?.phase,
            }),
          }],
          details: { status, hasDraft, hasPlan, hasExecution, taskCount, storedState },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });
}

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

/**
 * Get actionable next steps based on workspace state
 */
function getNextSteps(workspace: { hasDraft: boolean; hasPlan: boolean; hasExecution: boolean; state: WorkflowState | null }): { action: string; command: string; description: string } {
  const { hasDraft, hasPlan, hasExecution, state } = workspace;
  const phase = state?.phase || "idle";

  // If no state, nothing to recover
  if (!state) {
    return {
      action: "new",
      command: "fuxi_create_draft",
      description: "No existing workflow found. Create a new draft."
    };
  }

  // Based on current phase, determine what to do next
  switch (phase) {
    case "idle":
    case "design":
      if (hasDraft && !hasPlan) {
        return {
          action: "review",
          command: "qiaochui_review",
          description: "Draft exists. Review it with QiaoChui."
        };
      }
      return {
        action: "create_draft",
        command: "fuxi_create_draft",
        description: "Draft may be missing. Create or regenerate the draft."
      };

    case "review":
      if (hasDraft && !hasPlan) {
        return {
          action: "review",
          command: "qiaochui_review",
          description: "Continue reviewing with QiaoChui."
        };
      }
      return {
        action: "decompose",
        command: "qiaochui_decompose",
        description: "Draft reviewed. Decompose into tasks."
      };

    case "plan":
      if (hasPlan && !hasExecution) {
        return {
          action: "approve_plan",
          command: "fuxi_advance_phase execute",
          description: "Plan ready. Advance to execute phase."
        };
      }
      return {
        action: "decompose",
        command: "qiaochui_decompose",
        description: "Create execution plan from draft."
      };

    case "execute":
      if (hasExecution) {
        return {
          action: "execute",
          command: "luban_execute_all",
          description: "Execute remaining tasks with LuBan."
        };
      }
      return {
        action: "decompose",
        command: "qiaochui_decompose",
        description: "Create execution plan first."
      };

    case "audit":
      return {
        action: "audit",
        command: "gaoyao_review",
        description: "Run final audit with GaoYao."
      };

    case "complete":
      return {
        action: "complete",
        command: "none",
        description: "Workflow already complete. Use /fuxi-archive to save."
      };

    default:
      return {
        action: "unknown",
        command: "fuxi_restart",
        description: `Unknown phase: ${phase}. Try restarting.`
      };
  }
}

export function registerFuxiTools(pi: ExtensionAPI): void {

  /**
   * fuxi_restart - Check workspace state and provide next steps to recover workflow
   */
  pi.registerTool({
    name: "fuxi_restart",
    label: "Restart Workflow",
    description: "Check workspace state and provide next steps to recover an interrupted workflow",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const workspacePath = join(cwd, ".sages/workspace");

      try {
        // Ensure workspace directory exists
        if (!existsSync(workspacePath)) {
          mkdirSync(workspacePath, { recursive: true });
        }

        // Check workspace files
        const draftPath = join(workspacePath, "draft.md");
        const planPath = join(workspacePath, "plan.md");
        const executionPath = join(workspacePath, "execution.yaml");
        const statePath = join(workspacePath, "state.json");

        const hasDraft = existsSync(draftPath);
        const hasPlan = existsSync(planPath);
        const hasExecution = existsSync(executionPath);
        const hasState = existsSync(statePath);

        // Load state
        let state: WorkflowState | null = null;
        if (hasState) {
          try {
            state = JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
          } catch { /* ignore */ }
        }

        // Get next steps
        const nextSteps = getNextSteps({ hasDraft, hasPlan, hasExecution, state });

        // Build response
        const workspace = {
          path: workspacePath,
          has_draft: hasDraft,
          has_plan: hasPlan,
          has_execution: hasExecution,
          has_state: hasState,
        };

        const result = {
          success: true,
          workspace,
          state: state ? {
            id: state.id,
            phase: state.phase,
            plan_name: state.planName,
            request: state.request,
            created_at: state.createdAt,
            updated_at: state.updatedAt,
          } : null,
          next_steps: nextSteps,
          available_actions: {
            create_draft: !hasDraft || state?.phase === "idle" || state?.phase === "design",
            review: hasDraft && (!hasPlan || state?.phase === "review"),
            decompose: hasDraft && (!hasPlan || state?.phase === "review"),
            advance_to_execute: hasPlan && !hasExecution && state?.phase === "plan",
            execute: hasExecution && (state?.phase === "execute" || state?.phase === "plan"),
            audit: hasExecution && state?.phase === "audit",
            archive: state?.phase === "complete",
          },
          message: state 
            ? `Workflow recovered: ${state.planName} (phase: ${state.phase}). ${nextSteps.description}`
            : "No existing workflow found. Use fuxi_create_draft to create a new one.",
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
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

  /**
   * fuxi_advance_phase - Manually advance workflow to a specific phase
   */
  pi.registerTool({
    name: "fuxi_advance_phase",
    label: "Advance Phase",
    description: "Manually advance workflow to a specific phase (use for recovery when /fuxi-approve doesn't work)",
    parameters: Type.Object({
      phase: Type.String({
        description: "Phase to advance to: design, review, plan, execute, audit, complete"
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const workspacePath = join(cwd, WORKSPACE_DIR);
      const statePath = join(workspacePath, "state.json");

      const validPhases = ["idle", "design", "review", "plan", "execute", "audit", "complete"];
      const targetPhase = params.phase.toLowerCase();

      if (!validPhases.includes(targetPhase)) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: { message: `Invalid phase: ${params.phase}. Valid phases: ${validPhases.join(", ")}` }
          }) }],
          isError: true,
          details: { error: `Invalid phase: ${params.phase}` },
        };
      }

      try {
        // Ensure workspace exists
        ensureWorkspaceDirs(cwd);

        // Load existing state or create new
        const now = new Date().toISOString();
        let state: WorkflowState;

        if (existsSync(statePath)) {
          try {
            state = JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
            state.phase = targetPhase as WorkflowState["phase"];
            state.updatedAt = now;
          } catch {
            state = {
              id: `sages-${Date.now()}`,
              phase: targetPhase as WorkflowState["phase"],
              planName: "unknown",
              request: "unknown",
              createdAt: now,
              updatedAt: now,
            };
          }
        } else {
          state = {
            id: `sages-${Date.now()}`,
            phase: targetPhase as WorkflowState["phase"],
            planName: "unknown",
            request: "unknown",
            createdAt: now,
            updatedAt: now,
          };
        }

        writeFileSync(statePath, JSON.stringify(state, null, 2));

        // Get next steps based on new phase
        const nextSteps = getNextSteps({
          hasDraft: existsSync(join(workspacePath, "draft.md")),
          hasPlan: existsSync(join(workspacePath, "plan.md")),
          hasExecution: existsSync(join(workspacePath, "execution.yaml")),
          state,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            previous_phase: state.phase,
            new_phase: targetPhase,
            state_path: statePath,
            next_steps: nextSteps,
            message: `Workflow advanced to phase: ${targetPhase}. ${nextSteps.description}`,
          }) }],
          details: { phase: targetPhase, state },
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

  /**
   * fuxi_create_draft - Create MDD architectural design draft
   */
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

  /**
   * fuxi_get_draft - Read the current MDD design draft
   */
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

  /**
   * fuxi_get_status - Query MDD design status and workflow progress
   */
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

        // Get next steps
        const nextSteps = getNextSteps({ hasDraft, hasPlan, hasExecution, state: storedState });

        // Determine status based on state.json first, then file existence
        let status = "idle";
        const planName = storedState?.planName || (hasDraft ? extractPlanName(readFileSync(draftPath, "utf-8").slice(0, 200)) : null);

        // Use stored phase if available, otherwise infer from files
        if (storedState && storedState.phase !== "idle") {
          status = storedState.phase;
        } else if (hasDraft && !hasPlan) {
          status = "design";
        } else if (hasPlan && !hasExecution) {
          status = "plan";
        } else if (hasExecution) {
          status = "execute";
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
              next_step: nextSteps.description,
              next_action: nextSteps.action,
              stored_phase: storedState?.phase,
            }),
          }],
          details: { status, hasDraft, hasPlan, hasExecution, taskCount, storedState, nextSteps },
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

  /**
   * fuxi_archive - Archive completed workflow to .sages/archive/
   */
  pi.registerTool({
    name: "fuxi_archive",
    label: "Archive Workflow",
    description: "Archive the completed workflow to .sages/archive/ for future reference",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const workspacePath = join(cwd, ".sages/workspace");
      const archivePath = join(cwd, ".sages/archive");
      const statePath = join(workspacePath, "state.json");

      try {
        // Ensure archive directory exists
        if (!existsSync(archivePath)) {
          mkdirSync(archivePath, { recursive: true });
        }

        // Load state
        let state: WorkflowState | null = null;
        if (existsSync(statePath)) {
          try {
            state = JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
          } catch { /* ignore */ }
        }

        if (!state) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              success: false,
              error: { message: "No workflow state found" }
            }) }],
            isError: true,
            details: { error: "No state.json found" },
          };
        }

        // Create archive directory for this workflow
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const workflowArchivePath = join(archivePath, state.planName, timestamp);
        mkdirSync(workflowArchivePath, { recursive: true });

        // Copy workspace files to archive
        const files = ["draft.md", "plan.md", "execution.yaml", "state.json", "audit.md"];
        const archivedFiles: string[] = [];

        for (const file of files) {
          const srcPath = join(workspacePath, file);
          if (existsSync(srcPath)) {
            const destPath = join(workflowArchivePath, file);
            // Read content instead of copy to avoid permission issues
            const content = readFileSync(srcPath, "utf-8");
            writeFileSync(destPath, content);
            archivedFiles.push(file);
          }
        }

        // Create summary.md
        const summary = `# Workflow Archive: ${state.planName}

## Workflow Details
- **ID**: ${state.id}
- **Plan Name**: ${state.planName}
- **Request**: ${state.request}
- **Phase**: ${state.phase}
- **Created**: ${state.createdAt}
- **Completed**: ${state.updatedAt}

## Archived Files
${archivedFiles.map(f => `- ${f}`).join("\n")}

---
*Archived by Four Sages Agents on ${new Date().toISOString()}*
`;
        writeFileSync(join(workflowArchivePath, "summary.md"), summary);

        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            archive_path: workflowArchivePath,
            archived_files: archivedFiles,
            message: `Workflow "${state.planName}" archived to ${workflowArchivePath}`,
          }) }],
          details: { archivePath: workflowArchivePath, files: archivedFiles },
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

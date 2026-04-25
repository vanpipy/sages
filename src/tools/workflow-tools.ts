/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Workflow Tools - State Management 🜄                                  ║
 * ║                                                                           ║
 * ║   Tools for workflow state management and user approval                   ║
 * ║   Handles the Four Divine Agents orchestration state machine              ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { tool } from "@opencode-ai/plugin";
import type { PluginContext, WorkflowState, SessionState } from "../types.js";
import {
  ensurePlanDir,
  success,
  existsSync,
  join,
  logSages,
} from "../utils.js";
import {
  createSession,
  getSession,
  updateSessionStatus,
  endSession,
} from "../hooks/session.js";

// =============================================================================
// Tool Definitions
// =============================================================================

export const sages_init = tool({
  description: "Initialize a new Four Divine Agents workflow session",
  args: {
    project_path: tool.schema.string().describe("Absolute path to the project"),
    agent_name: tool.schema.string().optional().describe("Custom agent name (default: fuxi)"),
    task_description: tool.schema.string().optional().describe("Initial task description"),
  },
  execute: async (args, ctx) => {
    const { project_path, agent_name, task_description } = args;

    try {
      // Ensure plan directory exists
      ensurePlanDir(project_path);

      // Create session
      const result = createSession(project_path, agent_name, task_description);

      if (!result.success) {
        return JSON.stringify(result);
      }

      logSages("workflow_initialized", {
        project_path,
        agent_name,
        session_id: result.data.id,
      });

      return JSON.stringify(success({
        session_id: result.data.id,
        project_path,
        agent_name: agent_name || "fuxi",
        initialized_at: result.data.initializedAt,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_get_workflow_state = tool({
  description: "Get current workflow state (draft, plan, execution status)",
  args: {
    plan_name: tool.schema.string().optional().describe("Plan name to query"),
  },
  execute: async (args, ctx) => {
    const { plan_name } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      if (plan_name) {
        const planPath = join(projectDir, ".plan", `${plan_name}.plan.md`);
        const draftPath = join(projectDir, ".plan", `${plan_name}.draft.md`);
        const executionPath = join(projectDir, ".plan", `${plan_name}.execution.yaml`);

        const hasDraft = existsSync(draftPath);
        const hasPlan = existsSync(planPath);
        const hasExecution = existsSync(executionPath);

        let status: WorkflowState["status"] = "idle";
        if (hasDraft && !hasPlan) status = "draft";
        if (hasPlan && !hasExecution) status = "plan";
        if (hasExecution) status = "execution";

        return JSON.stringify(
          success({
            plan_name,
            has_draft: hasDraft,
            has_plan: hasPlan,
            has_execution: hasExecution,
            status,
            completed_tasks: 0,
            total_tasks: 0,
          }),
        );
      }

      // No plan specified - list all plans
      return JSON.stringify(success({ active_plans: [], status: "idle" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_confirm_approval = tool({
  description: `Confirm user approval to proceed with execution.

Called after user reviews the Fuxi report and chooses APPROVE.

Returns execution confirmation status`,
  args: {
    plan_name: tool.schema.string().describe("Plan name approved"),
    confirmed: tool.schema.boolean().describe("User confirmed (true = proceed, false = stop)"),
  },
  execute: async (args, ctx) => {
    const { plan_name, confirmed } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      if (confirmed) {
        // Update session to mark plan as approved
        const session = getSession(projectDir);
        if (session.success && session.data) {
          updateSessionStatus(projectDir, {
            currentPlanName: plan_name,
            status: "plan_approved",
          });
        }

        logSages("workflow_approved", { plan_name });

        return JSON.stringify(
          success({
            plan_name,
            approved: true,
            message: "Execution approved. Ready to proceed.",
          }),
        );
      } else {
        // Stop execution
        endSession(projectDir);

        logSages("workflow_rejected", { plan_name });

        return JSON.stringify(
          success({
            plan_name,
            approved: false,
            message: "Execution stopped. Run /resume to continue later.",
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_get_session = tool({
  description: "Get current session information",
  args: {},
  execute: async (args, ctx) => {
    const projectDir = ctx.agent || process.cwd();

    try {
      const result = getSession(projectDir);
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_end_session = tool({
  description: "End the current workflow session",
  args: {},
  execute: async (args, ctx) => {
    const projectDir = ctx.agent || process.cwd();

    try {
      const result = endSession(projectDir);
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});
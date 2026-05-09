/**
 * Four Sages Agents - pi Extension
 * 
 * Registers chat commands that map to workflow tools:
 * - fuxi-* commands ( Design phase)
 * - qiaochui-* commands ( Review phase)
 * - luban-* commands ( Execute phase)
 * - gaoyao-* commands ( Audit phase)
 * 
 * The extension captures tool executors during registration and invokes them directly,
 * avoiding the non-existent pi.callTool() method.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { 
  registerFuxiTools, 
  registerQiaoChuiTools, 
  registerLuBanTools, 
  registerGaoYaoTools 
} from "../tools/index.js";

// Tool executor storage - populated during tool registration
const toolExecutors: Map<string, Function> = new Map();

/**
 * Call a tool executor directly by name.
 * This bypasses the non-existent pi.callTool() method.
 */
async function callToolDirect(
  toolName: string,
  params: Record<string, unknown>,
  cwd: string
): Promise<{ content: { type: string; text: string }[]; isError?: boolean; details?: unknown }> {
  const executor = toolExecutors.get(toolName);
  if (!executor) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: `Tool ${toolName} not found` }) }],
      isError: true,
    };
  }

  try {
    const result = await (executor as Function).call(null, 
      `cmd-${Date.now()}`,
      params,
      undefined,
      undefined,
      { cwd }
    );
    return result;
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: String(err) }) }],
      isError: true,
    };
  }
}

export default function (pi: ExtensionAPI) {
  // Intercept registerTool to capture executors before they are registered
  const originalRegisterTool = pi.registerTool.bind(pi);
  
  // @ts-ignore - We're augmenting the API temporarily
  pi.registerTool = function(tool: any) {
    // Capture the execute function before registration
    if (tool.name && tool.execute) {
      toolExecutors.set(tool.name, tool.execute);
    }
    // Also register via original method so the tool is available to the LLM
    return originalRegisterTool(tool);
  };

  // Register all tools (this captures the executors)
  registerFuxiTools(pi);
  registerQiaoChuiTools(pi);
  registerLuBanTools(pi);
  registerGaoYaoTools(pi);

  // Restore original registerTool
  // @ts-ignore
  pi.registerTool = originalRegisterTool;

  // ===========================================================================
  // FUXI Commands ( Design Phase)
  // ===========================================================================

  /**
   * fuxi-start - Start workflow, set design phase
   * Usage: /fuxi-start <plan-name> [request description]
   */
  pi.registerCommand("fuxi-start", {
    description: "Start workflow, set design phase in state.json",
    handler: async (args, ctx) => {
      const parts = (args || "").split(/\s+/);
      const planName = parts[0] || "new-plan";
      const request = parts.slice(1).join(" ") || "New feature request";

      const result = await callToolDirect("fuxi_start", {
        plan_name: planName,
        request: request,
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Failed to start workflow.", "error");
      } else {
        ctx.ui.notify(`🚀 Workflow started: ${planName}`, "info");
        ctx.ui.setStatus("sages", " Designing");
      }
    },
  });

  /**
   * fuxi-request - Create requirement draft
   * Usage: /fuxi-request [request description]
   */
  pi.registerCommand("fuxi-request", {
    description: "Create MDD design draft (draft.md) using Seven Planes analysis",
    handler: async (args, ctx) => {
      const request = args || "New feature request";

      const result = await callToolDirect("fuxi_request", {
        request: request,
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Failed to create draft.", "error");
      } else {
        ctx.ui.notify("📝 Draft created: .sages/workspace/draft.md", "info");
      }
    },
  });

  /**
   * fuxi-plan - Transition to plan phase (only if score > 80)
   * Usage: /fuxi-plan <score>
   */
  pi.registerCommand("fuxi-plan", {
    description: "Transition to plan phase - only if score > 80",
    handler: async (args, ctx) => {
      const score = parseInt(args) || 0;

      const result = await callToolDirect("fuxi_plan", {
        score: score,
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify(`Score ${score} <= 80. Plan can only start when score > 80.`, "warning");
      } else {
        ctx.ui.notify(`📋 Plan phase started (score: ${score})`, "info");
        ctx.ui.setStatus("sages", "📋 Planning");
      }
    },
  });

  /**
   * fuxi-recover - Recover workflow from state.json
   * Usage: /fuxi-recover
   */
  pi.registerCommand("fuxi-recover", {
    description: "Recover workflow from state.json",
    handler: async (args, ctx) => {
      const result = await callToolDirect("fuxi_recover", {}, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("No workflow state found. Use fuxi-start to start a new workflow.", "info");
      } else {
        ctx.ui.notify("♻️ Workflow recovered.", "info");
        ctx.ui.setStatus("sages", " Ready (recovered)");
      }
    },
  });

  /**
   * fuxi-end - End workflow, archive, and set end status
   * Usage: /fuxi-end
   */
  pi.registerCommand("fuxi-end", {
    description: "End workflow, archive, and set end status",
    handler: async (args, ctx) => {
      const result = await callToolDirect("fuxi_end", {}, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("No active workflow to end.", "warning");
      } else {
        ctx.ui.notify("✅ Workflow ended and archived.", "info");
        ctx.ui.setStatus("sages", "📦 Archived");
      }
    },
  });

  /**
   * fuxi-get-status - View current status
   * Usage: /fuxi-get-status
   */
  pi.registerCommand("fuxi-get-status", {
    description: "View current workflow status",
    handler: async (args, ctx) => {
      const result = await callToolDirect("fuxi_get_status", {}, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("No active workflow.", "info");
      } else {
        ctx.ui.notify("Status retrieved.", "info");
      }
    },
  });

  // ===========================================================================
  // QIAOCHUI Commands ( Review Phase)
  // ===========================================================================

  /**
   * qiaochui-review - Review draft, set score in state.json
   * Usage: /qiaochui-review [draft-path]
   */
  pi.registerCommand("qiaochui-review", {
    description: "Review draft for technical feasibility - analyzes MDD planes, calculates score (0-100)",
    handler: async (args, ctx) => {
      const draftPath = args || ".sages/workspace/draft.md";

      const result = await callToolDirect("qiaochui_review", {
        draft_path: draftPath,
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Draft not found or review failed.", "error");
      } else {
        ctx.ui.notify("✅ Draft reviewed.", "info");
        ctx.ui.setStatus("sages", " Reviewed");
      }
    },
  });

  /**
   * qiaochui-decompose - Create plan.md and execution.yaml
   * Usage: /qiaochui-decompose
   */
  pi.registerCommand("qiaochui-decompose", {
    description: "Decompose design into tasks - creates plan.md and execution.yaml",
    handler: async (args, ctx) => {
      const result = await callToolDirect("qiaochui_decompose", {}, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Failed to decompose tasks.", "error");
      } else {
        ctx.ui.notify("📋 Tasks created: .sages/workspace/execution.yaml", "info");
        ctx.ui.setStatus("sages", "📋 Tasks ready");
      }
    },
  });

  // ===========================================================================
  // LUBAN Commands ( Execute Phase)
  // ===========================================================================

  /**
   * luban-execute-task - Execute single task using TDD cycle
   * Usage: /luban-execute-task <task-id> [description]
   */
  pi.registerCommand("luban-execute-task", {
    description: "Execute single task using TDD: RED → GREEN → REFACTOR",
    handler: async (args, ctx) => {
      // Parse: "T1 description" or just use args as description
      const parts = (args || "").match(/^([A-Z]\d+)?\s*(.*)$/);
      const taskId = parts?.[1] || "T1";
      const description = parts?.[2] || "Implement feature";

      const result = await callToolDirect("luban_execute_task", {
        task_id: taskId,
        task_description: description,
        files: ["src/"],
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify(`Task ${taskId} failed.`, "error");
      } else {
        ctx.ui.notify(`✅ Task ${taskId} completed.`, "info");
      }
    },
  });

  /**
   * luban-execute-all - Execute all tasks from execution.yaml
   * Usage: /luban-execute-all
   */
  pi.registerCommand("luban-execute-all", {
    description: "Execute all tasks from execution.yaml with parallel TDD",
    handler: async (args, ctx) => {
      const result = await callToolDirect("luban_execute_all", {
        execution_yaml: ".sages/workspace/execution.yaml",
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Execution failed.", "error");
      } else {
        ctx.ui.notify("✅ All tasks executed.", "info");
        ctx.ui.setStatus("sages", " Execute complete");
      }
    },
  });

  /**
   * luban-get-status - Get TDD execution status
   * Usage: /luban-get-status [plan-name]
   */
  pi.registerCommand("luban-get-status", {
    description: "Get TDD execution status with task progress",
    handler: async (args, ctx) => {
      const planName = args || "workflow";

      const result = await callToolDirect("luban_get_status", {
        plan_name: planName,
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Failed to get status.", "info");
      } else {
        ctx.ui.notify("Status retrieved.", "info");
      }
    },
  });

  // ===========================================================================
  // GAOYAO Commands ( Audit Phase)
  // ===========================================================================

  /**
   * gaoyao-review - Quality audit, generate report
   * Usage: /gaoyao-review [full|quick]
   */
  pi.registerCommand("gaoyao-review", {
    description: "Quality audit using Xie Zhi methodology - generates report with verdict (PASS/NEEDS_CHANGES/REJECTED)",
    handler: async (args, ctx) => {
      const reviewMode = args || "full";

      const result = await callToolDirect("gaoyao_review", {
        plan_name: undefined,
        review_mode: reviewMode,
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Audit failed.", "error");
      } else {
        ctx.ui.notify("✅ Audit complete: .sages/workspace/audit.md", "info");
        ctx.ui.setStatus("sages", " Audited");
      }
    },
  });

  /**
   * gaoyao-check-security - Security scan
   * Usage: /gaoyao-check-security [files...]
   */
  pi.registerCommand("gaoyao-check-security", {
    description: "Security scan: SQL injection, XSS, auth, data exposure",
    handler: async (args, ctx) => {
      const files = (args || "src/").split(/\s+/);

      const result = await callToolDirect("gaoyao_check_security", {
        files: files,
      }, ctx.cwd);

      if (result?.isError) {
        ctx.ui.notify("Security scan failed.", "error");
      } else {
        ctx.ui.notify("🔒 Security scan complete.", "info");
      }
    },
  });

  // ===========================================================================
  // Session Events
  // ===========================================================================

  pi.on("session_start", async (_event, context) => {
    context.ui?.setStatus("sages", " Ready");
  });
}

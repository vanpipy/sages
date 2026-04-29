/**
 * Four Sages Agents - Pi Extension
 * 
 * Features:
 * - Auto-proceed after valid review (except plan)
 * - Real TDD execution
 * - Parallel task execution
 * - Progress tracking
 * - Workspace/Archive management
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerFuxiTools, registerQiaoChuiTools, registerLuBanTools, registerGaoYaoTools } from "../dist/tools/index.js";
import { StateManager, type WorkflowState, type Task } from "../dist/state/state-manager.js";
import { WorkflowOrchestrator } from "../dist/orchestrator/index.js";
import { TaskExecutor } from "../dist/executor/index.js";

// =============================================================================
// Extension State
// =============================================================================

let currentStateManager: StateManager | null = null;
let currentOrchestrator: WorkflowOrchestrator | null = null;
let currentTaskExecutor: TaskExecutor | null = null;

function getStateManager(pi: ExtensionAPI): StateManager {
  if (!currentStateManager) {
    const cwd = pi.getContext()?.cwd || process.cwd();
    currentStateManager = new StateManager(cwd);
  }
  return currentStateManager;
}

function getOrchestrator(pi: ExtensionAPI): WorkflowOrchestrator {
  if (!currentOrchestrator) {
    const stateManager = getStateManager(pi);
    currentOrchestrator = new WorkflowOrchestrator(pi, stateManager);
  }
  return currentOrchestrator;
}

// =============================================================================
// Progress Tracking
// =============================================================================

function updateProgress(pi: ExtensionAPI, completed: number, total: number): void {
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const state = getStateManager(pi).getState();
  const phase = state?.phase || "idle";
  
  pi.getContext()?.ui?.setStatus("sages", `☴ ${phase} ${completed}/${total} (${percentage}%)`);
}

// =============================================================================
// Extension Factory
// =============================================================================

export default function (pi: ExtensionAPI) {
  // Register all tools
  registerFuxiTools(pi);
  registerQiaoChuiTools(pi);
  registerLuBanTools(pi);
  registerGaoYaoTools(pi);

  // =============================================================================
  // /fuxi command - Start workflow
  // =============================================================================
  pi.registerCommand("fuxi", {
    description: "Start Four Sages Agents automated workflow",
    handler: async (args, ctx) => {
      const request = args || "New feature request";
      const planName = request.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) || "plan";

      // Initialize state
      const stateManager = getStateManager(pi);
      stateManager.clearWorkspace(); // Clear for new workflow
      stateManager.create(planName, request);

      // Initialize orchestrator
      currentOrchestrator = new WorkflowOrchestrator(pi, stateManager);
      currentTaskExecutor = null;

      ctx.ui.notify(`🚀 Starting Four Sages: ${planName}`, "info");
      ctx.ui.setStatus("sages", "☰ Designing...");

      pi.sendUserMessage(currentOrchestrator.generateDesignPhaseMessage(request, planName), {
        deliverAs: "steer",
      });
    },
  });

  // =============================================================================
  // /fuxi-status command - Show progress
  // =============================================================================
  pi.registerCommand("fuxi-status", {
    description: "Check Four Sages workflow status",
    handler: async (args, ctx) => {
      const stateManager = getStateManager(pi);
      const state = stateManager.getState();

      if (!state) {
        ctx.ui.notify("No active workflow. Use /fuxi to start.", "info");
        return;
      }

      const progress = getProgress(state);
      const statusMsg = buildStatusMessage(state, progress);
      const workspace = stateManager.getWorkspaceFiles();

      // Add workspace location
      const workspaceInfo = [
        "",
        "",
        `📁 **Workspace:** \`.sages/workspace/\``,
        `- draft: ${workspace.draft ? "✅" : "❌"}`,
        `- plan: ${workspace.plan ? "✅" : "❌"}`,
        `- tasks: ${workspace.tasks ? "✅" : "❌"}`,
        `- audit: ${workspace.audit ? "✅" : "❌"}`,
      ].join("\n");

      ctx.ui.notify(statusMsg + workspaceInfo, "info");
    },
  });

  // =============================================================================
  // /fuxi-approve command - Proceed to next phase
  // =============================================================================
  pi.registerCommand("fuxi-approve", {
    description: "Approve current phase and continue",
    handler: async (args, ctx) => {
      const stateManager = getStateManager(pi);
      const orchestrator = getOrchestrator(pi);
      const state = stateManager.getState();

      if (!state) {
        ctx.ui.notify("No active workflow. Use /fuxi to start.", "warn");
        return;
      }

      switch (state.phase) {
        case "design":
          stateManager.updatePhase("review");
          ctx.ui.setStatus("sages", "☳ Reviewing...");
          pi.sendUserMessage(orchestrator.generateReviewPhaseMessage(".sages/workspace/draft.md"), {
            deliverAs: "steer",
          });
          break;

        case "review":
          stateManager.updatePhase("plan");
          orchestrator.approvePlan();
          ctx.ui.setStatus("sages", "📋 Review Plan");
          pi.sendUserMessage(orchestrator.generatePlanPhaseMessage(".sages/workspace/plan.md"), {
            deliverAs: "steer",
          });
          break;

        case "execute":
          stateManager.updatePhase("execute");
          ctx.ui.setStatus("sages", "☴ Executing...");
          
          if (state.tasks && state.tasks.length > 0) {
            currentTaskExecutor = new TaskExecutor(state.tasks, 3, ctx.cwd);
          }
          
          pi.sendUserMessage(orchestrator.generateExecutePhaseMessage(".sages/workspace/execution.yaml"), {
            deliverAs: "steer",
          });
          break;

        case "audit":
          stateManager.complete();
          ctx.ui.setStatus("sages", "✅ Complete");
          ctx.ui.notify("🎉 Four Sages workflow complete! Use /fuxi-archive to save.", "success");
          pi.sendUserMessage(orchestrator.generateCompletionMessage(), {
            deliverAs: "steer",
          });
          break;

        default:
          ctx.ui.notify(`Workflow in phase: ${state.phase}`, "info");
      }
    },
  });

  // =============================================================================
  // /fuxi-reject command - Stop workflow
  // =============================================================================
  pi.registerCommand("fuxi-reject", {
    description: "Reject and stop the workflow",
    handler: async (args, ctx) => {
      const stateManager = getStateManager(pi);
      stateManager.clearWorkspace();
      currentStateManager = null;
      currentOrchestrator = null;
      currentTaskExecutor = null;
      ctx.ui.setStatus("sages", "❌ Stopped");
      ctx.ui.notify("Workflow stopped.", "warn");
    },
  });

  // =============================================================================
  // /fuxi-execute command - Execute all tasks
  // =============================================================================
  pi.registerCommand("fuxi-execute", {
    description: "Execute all tasks with parallel TDD",
    handler: async (args, ctx) => {
      const stateManager = getStateManager(pi);
      const state = stateManager.getState();

      if (!state || state.phase !== "execute") {
        ctx.ui.notify("Workflow not in execution phase.", "warn");
        return;
      }

      if (!state.tasks || state.tasks.length === 0) {
        ctx.ui.notify("No tasks to execute.", "warn");
        return;
      }

      ctx.ui.notify(`Executing ${state.tasks.length} tasks...`, "info");

      const executor = new TaskExecutor(state.tasks, 3, ctx.cwd);
      currentTaskExecutor = executor;

      const results = await executor.executeAll(
        (task) => {
          ctx.ui.setStatus("sages", `☴ ${task.id}...`);
        },
        (task, result) => {
          stateManager.updateTaskStatus(task.id, result.success ? "completed" : "failed", result);
          updateProgress(pi, executor.getProgress().completed, executor.getProgress().total);
        },
        (task, error) => {
          stateManager.updateTaskStatus(task.id, "failed", { error: String(error) });
          ctx.ui.notify(`Task ${task.id} failed: ${error}`, "error");
        }
      );

      const successCount = Array.from(results.values()).filter(r => r.success).length;
      const totalCount = results.size;

      ctx.ui.notify(
        `Execution complete: ${successCount}/${totalCount} tasks succeeded`,
        successCount === totalCount ? "success" : "warn"
      );
    },
  });

  // =============================================================================
  // /fuxi-archive command - Archive current workflow
  // =============================================================================
  pi.registerCommand("fuxi-archive", {
    description: "Archive current workflow to .sages/archive/",
    handler: async (args, ctx) => {
      const stateManager = getStateManager(pi);
      const state = stateManager.getState();

      if (!state) {
        ctx.ui.notify("No active workflow to archive.", "warn");
        return;
      }

      const archivePath = stateManager.archive();
      
      if (archivePath) {
        ctx.ui.notify(`✅ Workflow archived to \`${archivePath}\``, "success");
      } else {
        ctx.ui.notify("Failed to archive workflow.", "error");
      }
    },
  });

  // =============================================================================
  // /fuxi-archives command - List archived workflows
  // =============================================================================
  pi.registerCommand("fuxi-archives", {
    description: "List archived workflows",
    handler: async (args, ctx) => {
      const stateManager = getStateManager(pi);
      const plans = stateManager.listArchivedPlans();

      if (plans.length === 0) {
        ctx.ui.notify("No archived workflows.", "info");
        return;
      }

      let message = "**📦 Archived Workflows:**\n\n";
      
      for (const planName of plans) {
        const archives = stateManager.listArchives(planName);
        message += `**${planName}** (${archives.length} archived)\n`;
        for (const archive of archives.slice(0, 3)) { // Show last 3
          const timestamp = archive.timestamp.replace(/-/g, ":").slice(0, 19);
          message += `  - ${timestamp}\n`;
        }
        if (archives.length > 3) {
          message += `  ... and ${archives.length - 3} more\n`;
        }
        message += "\n";
      }

      message += "\nUse `/fuxi-restore {plan} {timestamp}` to restore.";

      ctx.ui.notify(message, "info");
    },
  });

  // =============================================================================
  // /fuxi-restore command - Restore an archived workflow
  // =============================================================================
  pi.registerCommand("fuxi-restore", {
    description: "Restore an archived workflow",
    handler: async (args, ctx) => {
      // Parse args: "planName timestamp"
      const parts = (args || "").trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /fuxi-restore {planName} {timestamp}", "warn");
        return;
      }

      const [planName, ...timestampParts] = parts;
      const timestamp = timestampParts.join("-");

      const stateManager = getStateManager(pi);
      const success = stateManager.restore(planName, timestamp);

      if (success) {
        const state = stateManager.getState();
        ctx.ui.notify(
          `✅ Restored workflow: ${planName}\nPhase: ${state?.phase || "unknown"}`,
          "success"
        );
      } else {
        ctx.ui.notify("Failed to restore workflow. Check plan name and timestamp.", "error");
      }
    },
  });

  // =============================================================================
  // /fuxi-cleanup command - Clean up old archives
  // =============================================================================
  pi.registerCommand("fuxi-cleanup", {
    description: "Clean up old archives (older than N days)",
    handler: async (args, ctx) => {
      const days = parseInt(args) || 30;
      ctx.ui.notify(`Cleanup not implemented yet. Would delete archives older than ${days} days.`, "info");
    },
  });

  // =============================================================================
  // Session events
  // =============================================================================
  pi.on("session_start", async (_event, ctx) => {
    currentStateManager = new StateManager(ctx.cwd);
    currentOrchestrator = null;
    currentTaskExecutor = null;
  });
}

// =============================================================================
// Helper Functions
// =============================================================================

function getProgress(state: WorkflowState): { completed: number; total: number } {
  if (!state.tasks || state.tasks.length === 0) {
    return { completed: 0, total: 0 };
  }
  const completed = state.tasks.filter(t => t.status === "completed").length;
  return { completed, total: state.tasks.length };
}

function buildStatusMessage(state: WorkflowState, progress: { completed: number; total: number }): string {
  const phaseEmoji: Record<string, string> = {
    design: "☰",
    review: "☳",
    plan: "📋",
    execute: "☴",
    audit: "☲",
    complete: "✅",
  };

  const lines = [
    `**Workflow Status**`,
    ``,
    `**Phase:** ${phaseEmoji[state.phase] || "⏸️"} ${state.phase}`,
    `**Plan:** ${state.planName}`,
    `**Request:** ${state.request}`,
    ``,
  ];

  if (state.tasks && state.tasks.length > 0) {
    lines.push(`**Progress:** ${progress.completed}/${progress.total} tasks`);
    lines.push(``);
    lines.push(`**Tasks:**`);
    for (const task of state.tasks) {
      const statusIcon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : task.status === "in_progress" ? "🔄" : "⏳";
      lines.push(`  ${statusIcon} ${task.id}: ${task.description.slice(0, 50)}...`);
    }
  }

  return lines.join("\n");
}

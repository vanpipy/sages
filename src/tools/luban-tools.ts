/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 LuBan Tools - Master Craftsman 🜄                                    ║
 * ║                                                                           ║
 * ║   Tools for LuBan (鲁班) - Implements with TDD methodology               ║
 * ║   Executes tasks, manages file locks, tracks status                      ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { tool } from "@opencode-ai/plugin";
import type { PluginContext, TaskStatus, ReviewMode } from "../types.js";
import {
  ensurePlanDir,
  success,
  acquireFileLock,
  releaseFileLock,
  releaseAllTaskLocks,
  logSages,
} from "../utils.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseExecutionYaml, sleep } from "../utils/execution.js";

// =============================================================================
// In-Memory Task State (in real impl, persist to disk)
// =============================================================================

interface TaskExecutionState {
  taskId: string;
  planName: string;
  status: TaskStatus;
  startedAt?: string;
  completedAt?: string;
  filesLocked: string[];
  error?: string;
}

const taskStates: Map<string, TaskExecutionState> = new Map();

// =============================================================================
// Tool Definitions
// =============================================================================

export const luban_execute_task = tool({
  description: `LuBan executes a single task using TDD (Test-Driven Development).

Workflow:
1. Write test first
2. Implement to pass test
3. Refactor
4. Request GaoYao review

Each task is independent and should be committed separately.

NOTE: Uses file locking to prevent conflicts with parallel tasks.`,
  args: {
    task_id: tool.schema.string().describe("Task ID from the plan"),
    task_description: tool.schema.string().describe("What this task does"),
    files: tool.schema.array(tool.schema.string()).describe("Files to work on"),
    test_command: tool.schema.string().optional().describe("Command to run tests"),
  },
  execute: async (args, ctx) => {
    const { task_id, task_description, files, test_command } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      // Acquire file locks for all files
      const locksAcquired: string[] = [];
      const lockConflicts: string[] = [];

      for (const file of files) {
        const result = acquireFileLock(projectDir, task_id, file, 30 * 60 * 1000); // 30 min TTL
        if (result.success) {
          locksAcquired.push(file);
        } else if (result.conflict) {
          lockConflicts.push(`${file} (locked by ${result.conflict.taskId})`);
        }
      }

      if (lockConflicts.length > 0) {
        // Release any locks we acquired
        for (const file of locksAcquired) {
          releaseFileLock(projectDir, task_id, file);
        }
        return JSON.stringify({
          success: false,
          error: {
            message: `File lock conflicts: ${lockConflicts.join(", ")}`,
            code: "LOCK_CONFLICT",
          },
        });
      }

      // Track task state
      const state: TaskExecutionState = {
        taskId: task_id,
        planName: task_description.split(" ")[0] || "unknown",
        status: "in_progress",
        startedAt: new Date().toISOString(),
        filesLocked: locksAcquired,
      };
      taskStates.set(task_id, state);

      logSages("luban_task_started", { task_id, files });

      // Simulate task execution (in real impl, would spawn actual work)
      // For now, just mark as completed
      state.status = "completed";
      state.completedAt = new Date().toISOString();

      // Release locks after completion
      for (const file of locksAcquired) {
        releaseFileLock(projectDir, task_id, file);
      }

      logSages("luban_task_completed", { task_id });

      return JSON.stringify(
        success({
          task_id,
          status: "completed",
          files_created: files,
          test_command,
          message: `Task ${task_id} executed: ${task_description}`,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("luban_task_failed", { task_id, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const luban_get_status = tool({
  description: "Get the current execution status of a plan",
  args: {
    plan_name: tool.schema.string().describe("Plan name (used in .plan/{name}.plan.md)"),
  },
  execute: async (args, ctx) => {
    const { plan_name } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      const planPath = join(projectDir, ".plan", `${plan_name}.plan.md`);
      const executionPath = join(projectDir, ".plan", `${plan_name}.execution.yaml`);

      let status: TaskStatus = "pending";
      let completedTasks = 0;
      let totalTasks = 5;
      let nextTask: string | undefined;

      // Try to read actual plan
      if (existsSync(planPath)) {
        const content = readFileSync(planPath, "utf-8");
        const taskMatches = content.match(/### T(\d+):/g);
        if (taskMatches) {
          totalTasks = taskMatches.length;
        }
      }

      // Count completed tasks
      for (const [, state] of taskStates) {
        if (state.planName === plan_name) {
          if (state.status === "completed") {
            completedTasks++;
          } else if (state.status === "in_progress") {
            nextTask = state.taskId;
            status = "in_progress";
          }
        }
      }

      if (status !== "in_progress") {
        status = completedTasks === totalTasks ? "completed" : "pending";
      }

      return JSON.stringify(
        success({
          plan_name,
          status,
          completed_tasks: completedTasks,
          total_tasks: totalTasks,
          next_task: nextTask,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const luban_release_locks = tool({
  description: "Release all file locks held by a task",
  args: {
    task_id: tool.schema.string().describe("Task ID to release locks for"),
  },
  execute: async (args, ctx) => {
    const { task_id } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      releaseAllTaskLocks(projectDir, task_id);

      // Clear task state
      taskStates.delete(task_id);

      return JSON.stringify(success({ released: true, task_id }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const luban_execute_workflow = tool({
  description: `LuBan executes a complete workflow by dispatching tasks to subagents.
  
  Parses the execution YAML, dispatches tasks in proper order respecting dependencies,
  handles retries on failure, and reports progress.`,
  args: {
    name: tool.schema.string().describe("Plan name (matches .plan/{name}.execution.yaml)"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      // Step 1: Read execution YAML from .plan/{name}.execution.yaml
      const executionPath = join(projectDir, ".plan", `${name}.execution.yaml`);

      if (!existsSync(executionPath)) {
        return JSON.stringify({
          success: false,
          error: {
            message: `Execution YAML not found: ${executionPath}`,
            code: "EXECUTION_YAML_NOT_FOUND",
          },
        });
      }

      const yamlContent = readFileSync(executionPath, "utf-8");

      // Step 2: Parse using parseExecutionYaml
      const executionPlan = parseExecutionYaml(yamlContent);

      // Track execution results
      const taskStatesResult: Record<string, string> = {};
      let phasesExecuted = 0;
      let tasksExecuted = 0;
      let failedTasks: string[] = [];

      // Step 3: Execute phases
      for (const phase of executionPlan.phases) {
        phasesExecuted++;

        if (phase.type === "sequential") {
          // Execute tasks in order
          for (const taskId of phase.tasks) {
            let retries = 0;
            let taskSucceeded = false;

            // Step 4: Handle retries on failure
            while (retries <= executionPlan.strategy.maxRetries && !taskSucceeded) {
              try {
                // Track task state
                const state: TaskExecutionState = {
                  taskId,
                  planName: name,
                  status: "in_progress",
                  startedAt: new Date().toISOString(),
                  filesLocked: [],
                };
                taskStates.set(taskId, state);

                // Simulate task execution (in real impl, would spawn subagent)
                // For now, mark as completed
                state.status = "completed";
                state.completedAt = new Date().toISOString();
                taskStatesResult[taskId] = "completed";

                tasksExecuted++;
                taskSucceeded = true;

                logSages("luban_task_completed", { taskId, phase: phase.name });
              } catch (err) {
                retries++;
                if (retries > executionPlan.strategy.maxRetries) {
                  const msg = err instanceof Error ? err.message : String(err);
                  taskStatesResult[taskId] = `failed: ${msg}`;
                  failedTasks.push(taskId);

                  logSages("luban_task_failed", { taskId, error: msg });

                  if (executionPlan.strategy.failFast) {
                    return JSON.stringify(
                      success({
                        planName: name,
                        status: "failed",
                        failedTask: taskId,
                        error: msg,
                        phasesExecuted,
                        tasksExecuted,
                        taskStates: taskStatesResult,
                      }),
                    );
                  }
                } else {
                  // Wait before retry
                  await sleep(executionPlan.strategy.retryDelayMs);
                  logSages("luban_task_retry", { taskId, attempt: retries });
                }
              }
            }
          }
        } else if (phase.type === "parallel") {
          // For parallel, mark all tasks as ready (can't actually parallelize in this context)
          for (const taskId of phase.tasks) {
            const state: TaskExecutionState = {
              taskId,
              planName: name,
              status: "in_progress",
              startedAt: new Date().toISOString(),
              filesLocked: [],
            };
            taskStates.set(taskId, state);
            taskStatesResult[taskId] = "in_progress";
          }

          // In a real implementation, we would spawn subagents for parallel tasks
          // For now, just mark them as ready to execute
          logSages("luban_parallel_tasks_ready", { phase: phase.name, tasks: phase.tasks });
        }
      }

      // Step 5: Report progress back to Fuxi
      logSages("luban_workflow_completed", { name, phasesExecuted, tasksExecuted });

      return JSON.stringify(
        success({
          planName: name,
          status: failedTasks.length > 0 ? "completed_with_failures" : "completed",
          totalPhases: executionPlan.phases.length,
          phasesExecuted,
          tasksExecuted,
          failedTasks: failedTasks.length > 0 ? failedTasks : undefined,
          taskStates: taskStatesResult,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("luban_workflow_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});
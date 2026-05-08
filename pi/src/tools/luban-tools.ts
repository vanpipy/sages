/**
 * LuBan Tools (鲁班) - Engineer 
 * 
 * TDD execution with Subagent support.
 * 
 * Implement Mode Rules:
 * - ✅ All files writeable
 * - ✅ Follow TDD cycle
 * - ❌ Must follow RED → GREEN → REFACTOR
 * 
 * TDD Cycle:
 * 1. RED: Write failing test, run test, confirm failure
 * 2. GREEN: Write minimal code, run test, confirm pass
 * 3. REFACTOR: Clean code structure, keep tests passing, commit
 * 
 * Prohibited:
 * - ❌ Skip RED phase
 * - ❌ Write code without tests
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TDDRunner, TaskExecutor, SubagentExecutor } from "../executor/index.js";
import type { Task, ExecutionResult } from "../executor/index.js";

const WORKSPACE_DIR = ".sages/workspace";

/**
 * Extended execution result with commit info
 */
interface CommitResult {
  taskId: string;
  success: boolean;
  duration: number;
  committed: boolean;
  commitHash?: string;
  filesCreated: string[];
  filesModified: string[];
  testResults: Record<string, "passed" | "failed">;
  phases: { name: string; status: "completed" | "failed" | "pending" }[];
  error?: string;
}

/**
 * Simple YAML parser for execution.yaml
 */
function parseSimpleYaml(content: string): { tasks: Task[]; settings: any } | null {
  const tasks: Task[] = [];
  const settings: any = {
    name: "workflow",
    maxParallel: 3,
    useSubagent: true,
    maxRetry: 1,
    autoCommit: true,
    subagentConfig: {
      model: "sonnet",
      skills: ["luban"],
      maxContext: 4000,
      timeout: 300,
    },
  };

  const lines = content.split("\n");
  let currentTask: Partial<Task> | null = null;
  let inSettings = false;
  let inSubagentConfig = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "settings:") {
      inSettings = true;
      continue;
    }
    if (inSettings && trimmed.startsWith("tasks:")) {
      inSettings = false;
    }
    if (inSettings && trimmed.startsWith("subagentConfig:")) {
      inSubagentConfig = true;
      continue;
    }
    if (inSubagentConfig && trimmed.startsWith("maxContext:")) {
      settings.subagentConfig.maxContext = parseInt(trimmed.split(":")[1].trim());
    }
    if (inSubagentConfig && trimmed.startsWith("timeout:")) {
      settings.subagentConfig.timeout = parseInt(trimmed.split(":")[1].trim());
    }
    if (inSubagentConfig && trimmed.startsWith("model:")) {
      settings.subagentConfig.model = trimmed.split(":")[1].trim();
    }
    if (inSubagentConfig && trimmed.startsWith("skills:")) {
      const skills = trimmed.split("[")[1]?.split("]")[0] || "";
      settings.subagentConfig.skills = skills.split(",").map(s => s.trim().replace(/"/g, "")).filter(Boolean);
    }
    if (trimmed.startsWith("maxParallel:")) {
      settings.maxParallel = parseInt(trimmed.split(":")[1].trim());
    }
    if (trimmed.startsWith("useSubagent:")) {
      settings.useSubagent = trimmed.includes("true");
    }
    if (trimmed.startsWith("maxRetry:")) {
      settings.maxRetry = parseInt(trimmed.split(":")[1].trim());
    }
    if (trimmed.startsWith("autoCommit:")) {
      settings.autoCommit = trimmed.includes("true");
    }

    // Parse tasks
    if (trimmed.startsWith("- id:")) {
      if (currentTask) {
        tasks.push(currentTask as Task);
      }
      currentTask = {
        id: trimmed.split(":")[1].trim(),
        description: "",
        status: "pending",
        priority: "medium",
        dependsOn: [],
        files: [],
      };
    }
    if (currentTask && trimmed.startsWith("description:")) {
      currentTask.description = trimmed.split('"')[1] || trimmed.split(":").slice(1).join(":").trim();
    }
    if (currentTask && trimmed.startsWith("plane:")) {
      (currentTask as any).plane = trimmed.split(":")[1].trim();
    }
    if (currentTask && trimmed.startsWith("priority:")) {
      const p = parseInt(trimmed.split(":")[1].trim());
      currentTask.priority = p === 1 ? "high" : p === 2 ? "medium" : "low";
    }
    if (currentTask && trimmed.startsWith("dependsOn:")) {
      const deps = trimmed.split("[")[1]?.split("]")[0] || "";
      currentTask.dependsOn = deps.split(",").map(d => d.trim().replace(/"/g, "")).filter(Boolean);
    }
    if (currentTask && trimmed.startsWith("files:")) {
      const files = trimmed.split("[")[1]?.split("]")[0] || "";
      currentTask.files = files.split(",").map(f => f.trim().replace(/"/g, "")).filter(Boolean);
    }
  }

  if (currentTask) {
    tasks.push(currentTask as Task);
  }

  return tasks.length > 0 ? { tasks, settings } : null;
}

export function registerLuBanTools(pi: ExtensionAPI): void {
  /**
   * luban_execute_task - Execute single task using TDD cycle
   * Implement Mode (Writeable): All files allowed
   * 
   * TDD Cycle: RED (write test) → GREEN (make pass) → REFACTOR (improve)
   * Auto-commits after successful execution
   */
  pi.registerTool({
    name: "luban_execute_task",
    label: "Execute Task (TDD)",
    description: "Execute single task using TDD: RED → GREEN → REFACTOR. Writes test first, then minimal code. Auto-commits after success.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID from execution.yaml (e.g., T1, T2)" }),
      task_description: Type.String({ description: "Task description from the plan" }),
      files: Type.Array(Type.String(), { description: "Source files to work on (e.g., [\"src/index.ts\"])" }),
      test_files: Type.Optional(Type.Array(Type.String(), { description: "Test files to create (auto-derived from files if not provided)" })),
      test_command: Type.Optional(Type.String({ description: "Test command to run (default: bun test)" })),
      commit: Type.Optional(Type.Boolean({ description: "Commit after successful execution (default: true)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { task_id, task_description, files, test_files, test_command, commit = true } = params;
      const cwd = ctx.cwd;

      try {
        const tddConfig = {
          taskId: task_id,
          taskDescription: task_description,
          sourceFiles: files,
          testFiles: test_files || files.map((f: string) => f.replace("/src/", "/test/").replace(".ts", ".test.ts")),
          testCommand: test_command || "bun test",
          cwd,
        };

        const runner = new TDDRunner(tddConfig);
        const result = await runner.run();

        // Build commit result
        const commitResult: CommitResult = {
          taskId: task_id,
          success: result.success,
          duration: result.duration,
          committed: false,
          filesCreated: result.filesCreated || [],
          filesModified: [],
          testResults: (result.testResults && typeof result.testResults === 'object') 
            ? Object.fromEntries(
                Object.entries(result.testResults).map(([k, v]) => {
                  const val = v as string | number | boolean;
                  return [k, (val === 0 || val === 'passed' || val === true) ? 'passed' : 'failed'];
                })
              ) 
            : {},
          phases: result.phases.map(p => ({ name: p.name, status: p.status as "completed" | "failed" | "pending" })),
        };

        // Auto commit if enabled and task succeeded
        if (commit && result.success) {
          const commitInfo = await performCommit(cwd, task_id, task_description);
          commitResult.committed = commitInfo.success;
          commitResult.commitHash = commitInfo.hash;
        }

        const phasesSummary = result.phases
          .map(p => `${p.name}: ${p.status === "completed" ? "✅" : p.status === "failed" ? "❌" : "⏳"}`)
          .join(" → ");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: commitResult.success,
              task_id,
              phases_summary: phasesSummary,
              phases: commitResult.phases,
              files_created: commitResult.filesCreated,
              files_modified: commitResult.filesModified,
              test_results: commitResult.testResults,
              committed: commitResult.committed,
              commit_hash: commitResult.commitHash,
              duration_ms: commitResult.duration,
            }),
          }],
          details: { 
            taskId: task_id, 
            success: commitResult.success, 
            committed: commitResult.committed,
            duration: commitResult.duration 
          },
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
   * luban_execute_all - Execute all tasks from execution.yaml
   * Sorts by dependencies, executes in parallel (max 3), auto-commits
   */
  pi.registerTool({
    name: "luban_execute_all",
    label: "Execute All Tasks",
    description: "Execute all tasks from execution.yaml with parallel TDD. Sorts by dependencies, max 3 parallel, auto-commits each task.",
    parameters: Type.Object({
      tasks: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ description: "Task ID (e.g., T1, T2)" }),
        description: Type.String({ description: "Task description" }),
        priority: Type.Optional(Type.String({ description: "Priority: high, medium, low" })),
        depends_on: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this depends on" })),
        files: Type.Optional(Type.Array(Type.String(), { description: "Files to work on" })),
      }))),
      execution_yaml: Type.Optional(Type.String({ description: "Path to execution.yaml (default: .sages/workspace/execution.yaml)" })),
      commit: Type.Optional(Type.Boolean({ description: "Commit each task after success (default: true)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const execution_yaml = params.execution_yaml || join(cwd, WORKSPACE_DIR, "execution.yaml");
      const shouldCommit = params.commit !== false;

      try {
        let tasks: Task[] = [];
        let settings = {
          name: "workflow",
          maxParallel: 3,
          useSubagent: true,
          maxRetry: 1,
          autoCommit: shouldCommit,
          subagentConfig: {
            model: "sonnet",
            skills: ["luban"],
            maxContext: 4000,
            timeout: 300,
          },
        };

        // Load from execution.yaml if exists
        if (existsSync(execution_yaml)) {
          const content = readFileSync(execution_yaml, "utf-8");
          const parsed = parseSimpleYaml(content);
          if (parsed) {
            tasks = parsed.tasks;
            settings = { ...settings, ...parsed.settings };
          }
        } else if (params.tasks) {
          tasks = params.tasks.map((t: { id: string; description: string; priority?: string; depends_on?: string[]; files?: string[] }) => ({
            id: t.id,
            description: t.description,
            status: "pending" as const,
            priority: (t.priority as Task["priority"]) || "medium",
            dependsOn: t.depends_on || [],
            files: t.files || [],
          }));
        } else {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: "No tasks provided and execution.yaml not found" } }) }],
            isError: true,
            details: { error: "missing_tasks" },
          };
        }

        if (settings.useSubagent) {
          // Use SubagentExecutor for isolated parallel execution
          const executor = new SubagentExecutor(tasks, settings, cwd);
          const results = await executor.executeAll();

          const progress = executor.getProgress();

          // Generate summary table with commit info
          let summary = `## Execution Complete\n\n`;
          summary += `| Task | Plane | Status | Duration | Committed |\n`;
          summary += `|------|-------|--------|----------|----------|\n`;
          
          for (const task of tasks) {
            const result = results.get(task.id);
            const status = result?.success ? "✅" : "❌";
            const duration = result?.duration ? `${Math.round(result.duration / 1000)}s` : "-";
            const plane = (task as any).plane || "-";
            const committed = result?.success && shouldCommit ? "✅" : "-";
            summary += `| ${task.id} | ${plane} | ${status} | ${duration} | ${committed} |\n`;
          }
          summary += `\n**Total:** ${progress.completed}/${progress.total} completed, ${progress.failed} failed`;

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: progress.failed === 0,
                total_tasks: tasks.length,
                completed: progress.completed,
                failed: progress.failed,
                auto_commit: shouldCommit,
                results: Object.fromEntries(results),
                summary,
              }),
            }],
            details: { total: tasks.length, completed: progress.completed, failed: progress.failed, autoCommit: shouldCommit },
          };
        } else {
          // Use TaskExecutor for shared-context execution
          const executor = new TaskExecutor(tasks, settings.maxParallel, cwd);
          const results = await executor.executeAll();

          const successCount = Array.from(results.values()).filter(r => r.success).length;
          const progress = executor.getProgress();

          // Perform commits for successful tasks if enabled
          if (shouldCommit) {
            for (const [taskId, result] of results) {
              if (result.success) {
                const task = tasks.find(t => t.id === taskId);
                if (task) {
                  await performCommit(cwd, taskId, task.description);
                }
              }
            }
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: successCount === tasks.length,
                total_tasks: tasks.length,
                successful: successCount,
                failed: tasks.length - successCount,
                auto_commit: shouldCommit,
                progress: `${progress.completed}/${progress.total}`,
              }),
            }],
            details: { total: tasks.length, success: successCount, autoCommit: shouldCommit },
          };
        }
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
   * luban_get_status - Get TDD execution status with task progress
   * Returns: status, total_tasks, tasks details
   */
  pi.registerTool({
    name: "luban_get_status",
    label: "Get Execution Status",
    description: "Get TDD execution status with task progress. Returns status, total_tasks, task details from execution.yaml.",
    parameters: Type.Object({
      plan_name: Type.String({ description: "Plan name" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { plan_name } = params;
      const workspacePath = join(cwd, WORKSPACE_DIR);

      try {
        const planPath = join(workspacePath, "plan.md");
        const executionPath = join(workspacePath, "execution.yaml");
        // tasks.json is deprecated - use execution.yaml as single source of truth

        let totalTasks = 0;
        let taskDetails: Array<{ id: string; plane?: string; status: string }> = [];

        // Try execution.yaml first (single source of truth)
        if (existsSync(executionPath)) {
          const content = readFileSync(executionPath, "utf-8");
          const taskMatches = content.match(/- id: (T\d+)/g) || [];
          totalTasks = taskMatches.length;
        } else if (existsSync(planPath)) {
          const content = readFileSync(planPath, "utf-8");
          const matches = content.match(/### (T\d+):/g) || [];
          totalTasks = matches.length;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              plan_name,
              status: totalTasks > 0 ? "ready" : "no_tasks",
              total_tasks: totalTasks,
              tasks: taskDetails,
            }),
          }],
          details: { planName: plan_name, totalTasks },
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

/**
 * Perform git commit for a completed task
 */
async function performCommit(cwd: string, taskId: string, description: string): Promise<{ success: boolean; hash?: string }> {
  try {
    const { execSync } = await import("node:child_process");
    
    // Stage all changes
    execSync("git add -A", { cwd, stdio: "pipe" });
    
    // Check if there are changes to commit
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    if (!status.trim()) {
      return { success: true }; // Nothing to commit
    }
    
    // Commit with task info
    const message = `[${taskId}] ${description}`;
    const hash = execSync(`git commit -m "${message}"`, { cwd, encoding: "utf-8" }).trim();
    
    return { success: true, hash };
  } catch (error) {
    return { success: false };
  }
}

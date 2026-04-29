/**
 * LuBan Tools - Real TDD execution
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TDDRunner, TaskExecutor } from "../executor/index.js";
import type { Task } from "../executor/index.js";

const WORKSPACE_DIR = ".sages/workspace";

export function registerLuBanTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "luban_execute_task",
    label: "Execute Task (TDD)",
    description: "LuBan executes a single task using TDD methodology (RED → GREEN → REFACTOR)",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID from the plan (e.g., T1, T2)" }),
      task_description: Type.String({ description: "What this task does" }),
      files: Type.Array(Type.String(), { description: "Source files to work on" }),
      test_files: Type.Optional(Type.Array(Type.String(), { description: "Test files" })),
      test_command: Type.Optional(Type.String({ description: "Command to run tests (default: bun test)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { task_id, task_description, files, test_files, test_command } = params;
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

        const phasesSummary = result.phases
          .map(p => `${p.name}: ${p.status === "completed" ? "✅" : p.status === "failed" ? "❌" : "⏳"}`)
          .join(" → ");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: result.success,
              task_id,
              phases: result.phases.map(p => ({ name: p.name, status: p.status })),
              phases_summary: phasesSummary,
              files_created: result.filesCreated,
              test_results: result.testResults,
              duration_ms: result.duration,
            }),
          }],
          details: { taskId: task_id, success: result.success, duration: result.duration },
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
    name: "luban_execute_all",
    label: "Execute All Tasks",
    description: "Execute all tasks from the plan with parallel execution and dependency management",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        id: Type.String(),
        description: Type.String(),
        priority: Type.Optional(Type.String()),
        depends_on: Type.Optional(Type.Array(Type.String())),
        files: Type.Optional(Type.Array(Type.String())),
      })),
      max_parallel: Type.Optional(Type.Number({ description: "Max parallel tasks (default: 3)" })),
      test_command: Type.Optional(Type.String({ description: "Test command" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { tasks, max_parallel = 3, test_command } = params;
      const cwd = ctx.cwd;

      try {
        const taskList: Task[] = tasks.map((t: { id: string; description: string; priority?: string; depends_on?: string[]; files?: string[] }) => ({
          id: t.id,
          description: t.description,
          status: "pending" as const,
          priority: (t.priority as Task["priority"]) || "medium",
          dependsOn: t.depends_on || [],
          files: t.files || [],
          testCommand: test_command,
        }));

        const executor = new TaskExecutor(taskList, max_parallel, cwd);
        const results = await executor.executeAll();

        const successCount = Array.from(results.values()).filter(r => r.success).length;
        const progress = executor.getProgress();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: successCount === tasks.length,
              total_tasks: tasks.length,
              successful: successCount,
              failed: tasks.length - successCount,
              progress: `${progress.completed}/${progress.total}`,
            }),
          }],
          details: { total: tasks.length, success: successCount },
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
    name: "luban_get_status",
    label: "Get Execution Status",
    description: "Get the current execution status of a plan",
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

        let totalTasks = 0;

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

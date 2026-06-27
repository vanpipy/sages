/**
 * LuBan Tools - TDD Task Execution
 *
 * Part of: src/tools/luban/
 * Purpose: Execute tasks with TDD methodology (RED → GREEN → REFACTOR)
 *
 * Architecture (post-batch-refactor):
 * - luban_execute_task: Single task execution (direct or subagent mode)
 * - luban_execute_batch: Execute a batch of tasks from execution.yaml
 *   with optimistic concurrency + automatic serial degrade on conflicts (KD-2).
 *
 * Notes:
 * - `luban_execute_all` was removed (KD-1: no alias for backward compat).
 * - The caller (qiaochui / agent) is responsible for batch composition;
 *   LuBan executes each batch as an atomic unit (KD-3 black-box contract).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { FileService } from "../../services/file-service.js";
import { parseExecutionYaml } from "./plan-parser.js";
import { runTask } from "./task-runner.js";
import { runBatch } from "./scheduler.js";
import type { Batch, BatchResult, TDDConfig, TaskResult } from "./types.js";

const WORKSPACE_DIR = ".sages/workspace";

interface ToolContext {
  cwd: string;
  fileService: FileService;
}

/**
 * Create tool context
 */
function createContext(cwd: string): ToolContext {
  return {
    cwd,
    fileService: new FileService(cwd, WORKSPACE_DIR),
  };
}

/**
 * Execute a single task with TDD
 */
async function executeTask(params: {
  task_id: string;
  task_description: string;
  files: string[];
  test_files?: string[];
  test_command?: string;
  subagent?: boolean;
}, ctx: ToolContext): Promise<{ success: boolean; result: TaskResult }> {
  const {
    task_id,
    task_description,
    files,
    test_files = files.map(f => f.replace(/(\.ts|\.js)$/, ".test.$1")),
    test_command = "bun test",
    subagent = false
  } = params;

  try {
    // Build TDD config
    const config: TDDConfig = {
      taskId: task_id,
      taskDescription: task_description,
      sourceFiles: files,
      testFiles: test_files,
      testCommand: test_command,
      cwd: ctx.cwd,
      subagent,
    };

    // Execute task
    const result = await runTask(config);
    
    return { success: result.success, result };
  } catch (error) {
    return {
      success: false,
      result: {
        taskId: task_id,
        success: false,
        duration: 0,
        phases: [{
          name: "RED",
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        }]
      }
    };
  }
}

/**
 * Execute a batch of tasks from execution.yaml.
 *
 * Reads `execution.yaml` (default: <workspace>/execution.yaml), parses it
 * into a Batch, and runs via scheduler.ts runBatch.
 *
 * Returns BatchResult (full structure) — the tool layer surfaces a summary
 * to the agent in content.text and the full result in details (KD-3).
 */
async function executeBatch(params: {
  execution_yaml?: string;
  max_parallel?: number;
  subagent?: boolean;
}, ctx: ToolContext): Promise<BatchResult> {
  const {
    execution_yaml,
    max_parallel = 3,
    subagent: _subagent = false,  // reserved; currently no-op
  } = params;

  try {
    const yamlPath = execution_yaml || ctx.fileService.getFilePath("execution.yaml");
    const content = ctx.fileService.read(yamlPath);

    const emptyResult = (): BatchResult => ({
      success: false,
      mode: "serial",
      degraded: false,
      results: [],
      completed: [],
      totalDuration: 0,
    });

    if (!content) return emptyResult();

    const plan = parseExecutionYaml(content);
    if (!plan) return emptyResult();

    const batch: Batch = {
      tasks: plan.tasks,
      maxParallel: max_parallel,
      testCommand: "bun test",
      cwd: ctx.cwd,
    };

    return await runBatch(batch);
  } catch (error) {
    return {
      success: false,
      mode: "serial",
      degraded: false,
      results: [],
      completed: [],
      totalDuration: 0,
    };
  }
}

/**
 * Get execution status
 */
async function getStatus(planName: string, ctx: ToolContext): Promise<{ 
  status: string; 
  total: number; 
  completed: string[];
  failed: string[];
}> {
  try {
    const workspacePath = ctx.fileService.getWorkspacePath();
    const executionPath = ctx.fileService.getFilePath("execution.yaml");
    
    if (!ctx.fileService.exists("plan.md") || !ctx.fileService.exists("execution.yaml")) {
      return { status: "no_workflow", total: 0, completed: [], failed: [] };
    }

    const content = ctx.fileService.read("execution.yaml");
    if (!content) {
      return { status: "invalid_plan", total: 0, completed: [], failed: [] };
    }
    
    const plan = parseExecutionYaml(content);
    
    if (!plan) {
      return { status: "invalid_plan", total: 0, completed: [], failed: [] };
    }

    return {
      status: "in_progress",
      total: plan.tasks.length,
      completed: [],
      failed: []
    };
  } catch {
    return { status: "error", total: 0, completed: [], failed: [] };
  }
}

/**
 * Register LuBan tools with pi extension
 */
export function registerLubanTools(pi: ExtensionAPI): void {

  /**
   * luban_execute_task - Execute a single task using TDD methodology
   */
  pi.registerTool({
    name: "luban_execute_task",
    label: "Execute Task (TDD)",
    description: "Execute a single task using TDD methodology (RED → GREEN → REFACTOR). Writes test first, then minimal code. Auto-commits after success.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID (e.g., T1, T2)" }),
      task_description: Type.String({ description: "Task description" }),
      files: Type.Array(Type.String(), { description: "Source files to work on" }),
      test_files: Type.Optional(Type.Array(Type.String(), { description: "Test files to create" })),
      test_command: Type.Optional(Type.String({ description: "Test command to run (default: bun test)" })),
      subagent: Type.Optional(Type.Boolean({ description: "Use subagent mode (default: false)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const context = createContext(ctx.cwd);
      
      const result = await executeTask({
        task_id: params.task_id,
        task_description: params.task_description,
        files: params.files,
        test_files: params.test_files,
        test_command: params.test_command,
        subagent: params.subagent,
      }, context);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: result.success,
            taskId: result.result.taskId,
            phases: result.result.phases,
            duration: result.result.duration,
          }),
        }],
        details: result.result,
      };
    },
  });

  /**
   * luban_execute_batch - Execute a batch of tasks atomically.
   *
   * Reads execution.yaml (default: <workspace>/execution.yaml), parses into
   * a Batch, and runs via runBatch with optimistic concurrency + auto-degrade
   * to serial on intra-batch file conflicts (KD-2).
   *
   * Black-box contract (KD-3): content.text carries summary
   * {success, mode, degraded, conflicts?, completed, totalDuration}; full
   * BatchResult with per-task phase details is in the `details` field for
   * GaoYao audit / debug — not surfaced to the agent.
   */
  pi.registerTool({
    name: "luban_execute_batch",
    label: "Execute Batch (TDD)",
    description: "Execute a batch of tasks from execution.yaml with optimistic concurrency and automatic serial degrade on file conflicts. Caller (qiaochui/agent) is responsible for batch composition. Returns BatchResult with mode (parallel|serial), degraded flag, and conflicts list.",
    parameters: Type.Object({
      execution_yaml: Type.Optional(Type.String({ description: "Path to execution.yaml (default: <workspace>/execution.yaml)" })),
      max_parallel: Type.Optional(Type.Number({ description: "Optimistic concurrency cap (default: 3). If intra-batch file conflicts are detected, batch auto-degrades to serial regardless." })),
      subagent: Type.Optional(Type.Boolean({ description: "Subagent mode flag (reserved, currently no-op)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const context = createContext(ctx.cwd);

      const result = await executeBatch({
        execution_yaml: params.execution_yaml,
        max_parallel: params.max_parallel,
        subagent: params.subagent,
      }, context);

      // KD-3: content.text = summary for the agent
      const summary = {
        success: result.success,
        mode: result.mode,
        degraded: result.degraded,
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
        completed: result.completed,
        totalDuration: result.totalDuration,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: result,  // Full BatchResult (including per-task phases) for GaoYao audit
      };
    },
  });

  /**
   * luban_get_status - Get current TDD execution status
   */
  pi.registerTool({
    name: "luban_get_status",
    label: "Get Execution Status",
    description: "Get current TDD execution status with task progress.",
    parameters: Type.Object({
      plan_name: Type.String({ description: "Plan name" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const context = createContext(ctx.cwd);
      
      const status = await getStatus(params.plan_name, context);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(status),
        }],
        details: status,
      };
    },
  });
}

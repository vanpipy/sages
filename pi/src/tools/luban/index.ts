/**
 * LuBan Tools - TDD Task Execution
 * 
 * Part of: src/tools/luban/
 * Purpose: Execute tasks with TDD methodology (RED → GREEN → REFACTOR)
 * 
 * Architecture:
 * - luban_execute_task: Single task execution (direct or subagent mode)
 * - luban_execute_all: Execute all tasks from execution.yaml
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { FileService } from "../../services/file-service.js";
import { parseExecutionYaml, sortByDependencies } from "./plan-parser.js";
import { runTask } from "./task-runner.js";
import type { TDDConfig, TaskResult } from "./types.js";

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
 * Execute all tasks from execution.yaml
 */
async function executeAll(params: {
  execution_yaml?: string;
  max_parallel?: number;
  subagent?: boolean;
}, ctx: ToolContext): Promise<{ success: boolean; results: TaskResult[]; completed: string[] }> {
  const {
    execution_yaml,
    max_parallel = 3,
    subagent = false
  } = params;

  try {
    // Default path if not specified
    const yamlPath = execution_yaml || ctx.fileService.getFilePath("execution.yaml");
    
    // Read and parse execution.yaml
    const content = ctx.fileService.read(yamlPath);
    
    if (!content) {
      return { success: false, results: [], completed: [] };
    }
    
    const plan = parseExecutionYaml(content);
    
    if (!plan) {
      return { success: false, results: [], completed: [] };
    }

    const results: TaskResult[] = [];
    const completed = new Set<string>();
    const sortedTasks = sortByDependencies(plan.tasks);

    // Execute tasks respecting dependencies and parallelism
    for (const task of sortedTasks) {
      // Wait for dependencies
      while (task.dependsOn.length > 0 && !task.dependsOn.every(dep => completed.has(dep))) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Execute task
      const result = await executeTask({
        task_id: task.id,
        task_description: task.description,
        files: task.files,
        subagent,
      }, ctx);

      results.push(result.result);
      if (result.success) {
        completed.add(task.id);
      }
    }

    return { 
      success: completed.size === plan.tasks.length,
      results,
      completed: Array.from(completed)
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      completed: []
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
   * luban_execute_all - Execute all tasks from execution.yaml
   */
  pi.registerTool({
    name: "luban_execute_all",
    label: "Execute All Tasks",
    description: "Execute all tasks from execution.yaml with parallel execution. Sorts by dependencies, max 3 parallel.",
    parameters: Type.Object({
      execution_yaml: Type.Optional(Type.String({ description: "Path to execution.yaml" })),
      max_parallel: Type.Optional(Type.Number({ description: "Maximum parallel tasks (default: 3)" })),
      subagent: Type.Optional(Type.Boolean({ description: "Use subagent mode (default: false)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const context = createContext(ctx.cwd);
      
      const result = await executeAll({
        execution_yaml: params.execution_yaml,
        max_parallel: params.max_parallel,
        subagent: params.subagent,
      }, context);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: result.success,
            completed: result.completed,
            totalCompleted: result.completed.length,
            totalTasks: result.results.length,
          }),
        }],
        details: { results: result.results, completed: result.completed },
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

/**
 * Task Executor - Handles parallel task execution with dependency management
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TDDRunner, type TDDConfig } from "./tdd-runner.js";

export interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  files: string[];
  testFiles?: string[];
  testCommand?: string;
  result?: ExecutionResult;
  error?: string;
}

export interface ExecutionResult {
  taskId: string;
  success: boolean;
  duration: number;
  error?: string;
  output?: string;
}

export class TaskExecutor {
  private tasks: Map<string, Task> = new Map();
  private completedTasks: Set<string> = new Set();
  private maxParallel: number;
  private cwd: string;

  constructor(tasks: Task[], maxParallel: number = 3, cwd: string) {
    this.maxParallel = maxParallel;
    this.cwd = cwd;

    // Initialize task map
    for (const task of tasks) {
      this.tasks.set(task.id, { ...task, status: "pending" });
    }
  }

  async executeAll(
    onTaskStart?: (task: Task) => void,
    onTaskComplete?: (task: Task, result: ExecutionResult) => void,
    onTaskError?: (task: Task, error: Error) => void
  ): Promise<Map<string, ExecutionResult>> {
    const results = new Map<string, ExecutionResult>();
    const runningTasks = new Set<string>();

    while (this.getPendingTasks().length > 0 || runningTasks.size > 0) {
      // Find tasks that can run (dependencies met, not blocked)
      const readyTasks = this.getReadyTasks();

      // Start as many tasks as we can (up to maxParallel)
      for (const task of readyTasks) {
        if (runningTasks.size >= this.maxParallel) break;
        if (runningTasks.has(task.id)) continue;

        runningTasks.add(task.id);
        task.status = "in_progress";
        onTaskStart?.(task);

        // Execute task asynchronously
        this.executeTask(task)
          .then((result) => {
            results.set(task.id, result);
            this.completedTasks.add(task.id);
            task.status = result.success ? "completed" : "failed";
            if (result.success) {
              task.result = result;
            } else {
              task.error = result.error;
            }
            onTaskComplete?.(task, result);
          })
          .catch((error) => {
            const result: ExecutionResult = {
              taskId: task.id,
              success: false,
              duration: 0,
              error: String(error),
            };
            results.set(task.id, result);
            this.completedTasks.add(task.id);
            task.status = "failed";
            task.error = String(error);
            onTaskError?.(task, error);
          })
          .finally(() => {
            runningTasks.delete(task.id);
          });
      }

      // Wait a bit before checking again
      await this.sleep(100);
    }

    return results;
  }

  async executeAllSequential(
    onTaskStart?: (task: Task) => void,
    onTaskComplete?: (task: Task, result: ExecutionResult) => void,
    onTaskError?: (task: Task, error: Error) => void
  ): Promise<Map<string, ExecutionResult>> {
    const results = new Map<string, ExecutionResult>();

    for (const task of this.getSortedTasks()) {
      if (task.status === "completed" || task.status === "failed") continue;

      task.status = "in_progress";
      onTaskStart?.(task);

      try {
        const result = await this.executeTask(task);
        results.set(task.id, result);
        task.status = result.success ? "completed" : "failed";
        if (result.success) {
          task.result = result;
        } else {
          task.error = result.error;
        }
        onTaskComplete?.(task, result);
      } catch (error) {
        const result: ExecutionResult = {
          taskId: task.id,
          success: false,
          duration: 0,
          error: String(error),
        };
        results.set(task.id, result);
        task.status = "failed";
        task.error = String(error);
        onTaskError?.(task, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return results;
  }

  private async executeTask(task: Task): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Parse execution file if exists
      const executionPath = join(this.cwd, ".sages", "plans", "execution.yaml");
      let testCommand = task.testCommand || "bun test";

      if (existsSync(executionPath)) {
        // Could parse YAML here for specific task config
      }

      // Create TDD config
      const tddConfig: TDDConfig = {
        taskId: task.id,
        taskDescription: task.description,
        sourceFiles: task.files.length > 0 ? task.files : this.inferSourceFiles(task),
        testFiles: task.testFiles || this.inferTestFiles(task),
        testCommand,
        cwd: this.cwd,
      };

      // Run TDD
      const runner = new TDDRunner(tddConfig);
      const result = await runner.run();

      return {
        taskId: task.id,
        success: result.success,
        duration: result.duration,
      };
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        duration: Date.now() - startTime,
        error: String(error),
      };
    }
  }

  private inferSourceFiles(task: Task): string[] {
    // Try to infer source files from task description
    const words = task.description.toLowerCase().split(/\s+/);
    const possibleNames = words.filter(w => w.length > 3 && !["implement", "add", "create", "update", "fix", "the", "and"].includes(w));
    
    if (possibleNames.length > 0) {
      return [`src/${possibleNames[0]}.ts`];
    }
    return [];
  }

  private inferTestFiles(task: Task): string[] {
    const sourceFiles = this.inferSourceFiles(task);
    return sourceFiles.map(f => f.replace("/src/", "/test/").replace(".ts", ".test.ts"));
  }

  private getPendingTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.status === "pending" || t.status === "in_progress");
  }

  private getReadyTasks(): Task[] {
    return Array.from(this.tasks.values())
      .filter(task => {
        if (task.status !== "pending") return false;
        // Check if all dependencies are completed
        return task.dependsOn.every(depId => this.completedTasks.has(depId));
      })
      .sort((a, b) => {
        // Sort by priority: high > medium > low
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  private getSortedTasks(): Task[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === "pending")
      .sort((a, b) => {
        // Topological sort by dependencies
        if (a.dependsOn.includes(b.id)) return 1;
        if (b.dependsOn.includes(a.id)) return -1;
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getTaskStatus(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getProgress(): { completed: number; total: number; percentage: number } {
    const tasks = Array.from(this.tasks.values());
    const completed = tasks.filter(t => t.status === "completed").length;
    const total = tasks.length;
    return {
      completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }
}

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
        if (this.completedTasks.has(task.id)) return false;  // Already completed
        // Check if all dependencies are completed
        return task.dependsOn.every(depId => this.completedTasks.has(depId));
      })
      .sort((a, b) => {
        // Sort by priority: high > medium > low
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  /**
   * Topological sort using Kahn's algorithm with priority ordering
   * - Tasks are sorted so dependencies come before dependents
   * - Among tasks with no remaining dependencies, high priority runs first
   * 
   * Note: This method is tested directly by unit tests despite being private.
   * TypeScript's private is compile-time only; tests access it at runtime.
   */
  private getSortedTasks(): Task[] {
    const pendingTasks = Array.from(this.tasks.values()).filter(t => t.status === "pending");
    if (pendingTasks.length === 0) return [];

    // Build adjacency list and in-degree count
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    const taskMap = new Map<string, Task>();

    // Initialize
    for (const task of pendingTasks) {
      taskMap.set(task.id, task);
      inDegree.set(task.id, 0);
      adjList.set(task.id, []);
    }

    // Build graph
    for (const task of pendingTasks) {
      for (const depId of task.dependsOn) {
        // Only include edges for tasks in our pending set
        if (taskMap.has(depId)) {
          adjList.get(depId)!.push(task.id);
          inDegree.set(task.id, inDegree.get(task.id)! + 1);
        }
      }
    }

    // Kahn's algorithm with priority queue
    const queue: string[] = [];
    const result: Task[] = [];
    const priorityOrder = { high: 0, medium: 1, low: 2 };

    // Start with tasks that have no dependencies (in-degree = 0)
    for (const [taskId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(taskId);
      }
    }

    // Sort initial queue by priority
    queue.sort((a, b) => priorityOrder[taskMap.get(a)!.priority] - priorityOrder[taskMap.get(b)!.priority]);

    while (queue.length > 0) {
      // Sort queue by priority before each pick (handles priority changes as deps complete)
      queue.sort((a, b) => priorityOrder[taskMap.get(a)!.priority] - priorityOrder[taskMap.get(b)!.priority]);

      const taskId = queue.shift()!;
      const task = taskMap.get(taskId)!;
      result.push(task);

      // Reduce in-degree for all dependents
      for (const dependentId of adjList.get(taskId)!) {
        const newDegree = inDegree.get(dependentId)! - 1;
        inDegree.set(dependentId, newDegree);
        if (newDegree === 0) {
          queue.push(dependentId);
        }
      }
    }

    // Handle cycles: tasks in a dependency cycle cannot be topologically sorted.
    // Kahn's algorithm leaves them out of result. We append them at the end
    // as a best-effort ordering. These tasks will likely fail at runtime
    // since their dependencies form a circular reference.
    for (const task of pendingTasks) {
      if (!result.includes(task)) {
        result.push(task);
      }
    }

    return result;
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

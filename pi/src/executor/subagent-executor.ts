/**
 * Subagent Executor - Spawns isolated LuBan subagents for parallel task execution
 * 
 * Uses child_process to spawn separate pi processes for true isolation
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Task, ExecutionResult } from "./task-executor.js";

export interface SubagentConfig {
  model?: string;
  skills?: string[];
  maxContext?: number;
  timeout?: number;
}

export interface ExecutionSettings {
  name: string;
  maxParallel: number;
  useSubagent: boolean;
  maxRetry?: number;
  subagentConfig?: SubagentConfig;
}

export interface ExecutionProgress {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  results: Map<string, ExecutionResult>;
}

/**
 * SubagentExecutor - Manages parallel LuBan subagent execution
 */
export class SubagentExecutor {
  private tasks: Task[];
  private settings: ExecutionSettings;
  private cwd: string;
  private completedTasks: Set<string> = new Set();
  private runningTasks: Map<string, AbortController> = new Map();
  private results: Map<string, ExecutionResult> = new Map();
  private progress: ExecutionProgress;

  constructor(
    tasks: Task[],
    settings: ExecutionSettings,
    cwd: string
  ) {
    this.tasks = tasks;
    this.settings = settings;
    this.cwd = cwd;
    this.progress = {
      total: tasks.length,
      completed: 0,
      failed: 0,
      running: 0,
      pending: tasks.length,
      results: this.results,
    };
  }

  getProgress(): ExecutionProgress {
    return { ...this.progress };
  }

  /**
   * Get tasks that are ready to execute (dependencies met)
   */
  private getReadyTasks(): Task[] {
    return this.tasks.filter(task => {
      if (task.status !== "pending") return false;
      if (this.completedTasks.has(task.id)) return false;
      if (this.runningTasks.has(task.id)) return false;
      return task.dependsOn.every(depId => this.completedTasks.has(depId));
    });
  }

  /**
   * Execute all tasks using subagents
   */
  async executeAll(
    onTaskStart?: (task: Task) => void,
    onTaskComplete?: (task: Task, result: ExecutionResult) => void,
    onTaskError?: (task: Task, error: Error) => void,
    onProgress?: (progress: ExecutionProgress) => void
  ): Promise<Map<string, ExecutionResult>> {
    const promises: Promise<void>[] = [];

    let maxIterations = this.tasks.length * 10;
    let iteration = 0;

    while (this.getPendingCount() > 0 && iteration < maxIterations) {
      iteration++;

      // Spawn ready tasks up to maxParallel
      const readyTasks = this.getReadyTasks();
      const toSpawn = readyTasks.slice(0, this.settings.maxParallel - this.runningTasks.size);

      for (const task of toSpawn) {
        const promise = this.spawnTask(task, onTaskStart, onTaskComplete, onTaskError);
        promises.push(promise);
      }

      // Wait a bit before checking again
      await this.sleep(500);
      this.updateProgress();
      onProgress?.(this.getProgress());
    }

    return this.results;
  }

  private async spawnTask(
    task: Task,
    onTaskStart?: (task: Task) => void,
    onTaskComplete?: (task: Task, result: ExecutionResult) => void,
    onTaskError?: (task: Task, error: Error) => void
  ): Promise<void> {
    task.status = "in_progress";
    this.runningTasks.set(task.id, new AbortController());
    this.progress.running++;
    this.progress.pending--;
    onTaskStart?.(task);

    const result = await this.executeSubagent(task);
    this.handleTaskComplete(task, result, onTaskComplete);
    this.runningTasks.delete(task.id);
  }

  private async executeSubagent(task: Task): Promise<ExecutionResult> {
    const startTime = Date.now();
    const config = this.settings.subagentConfig || {};
    const maxRetry = this.settings.maxRetry || 1;
    let retryCount = 0;

    while (retryCount <= maxRetry) {
      try {
        const result = await this.runSubagentProcess(task, config);
        const duration = Date.now() - startTime;

        if (result.success) {
          return { taskId: task.id, success: true, duration, output: result.output };
        } else {
          if (retryCount < maxRetry) {
            retryCount++;
            await this.sleep(1000);
            continue;
          }
          return { taskId: task.id, success: false, duration, error: result.error };
        }
      } catch (error) {
        if (retryCount < maxRetry) {
          retryCount++;
          await this.sleep(1000);
          continue;
        }
        return {
          taskId: task.id,
          success: false,
          duration: Date.now() - startTime,
          error: String(error),
        };
      }
    }

    return {
      taskId: task.id,
      success: false,
      duration: Date.now() - startTime,
      error: "Max retries exceeded",
    };
  }

  private runSubagentProcess(
    task: Task,
    config: SubagentConfig
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return new Promise((resolve) => {
      const prompt = this.buildTaskPrompt(task);
      const model = config.model || "sonnet";
      const timeout = (config.timeout || 300) * 1000;

      // Spawn pi process with the task prompt as input
      const child = spawn("pi", ["--model", model, "--no-gui"], {
        cwd: this.cwd,
        timeout,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({ success: false, error: stderr || `Exit code: ${code}` });
        }
      });

      child.on("error", (error) => {
        resolve({ success: false, error: String(error) });
      });

      // Send the prompt to the subagent
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }

  private buildTaskPrompt(task: Task): string {
    const model = this.settings.subagentConfig?.model || "sonnet";
    const skills = (this.settings.subagentConfig?.skills || ["luban"]).join(", ");

    return `You are a LuBan (鲁班) subagent - a skilled software engineer.

## Task
ID: ${task.id}
Description: ${task.description}
${task.files.length > 0 ? `Files to work on: ${task.files.join(", ")}` : ""}

## Instructions
1. Use TDD methodology: RED → GREEN → REFACTOR
2. Write tests first, then implement
3. Run tests to verify
4. Keep the code clean
5. Return results when complete

## Context
Working directory: ${this.cwd}
Plan: ${this.settings.name}
Skills: ${skills}
Model: ${model}

## Begin task execution
${task.description}

Return your results in JSON format:
{
  "success": true/false,
  "task_id": "${task.id}",
  "files_created": [...],
  "test_results": {...},
  "summary": "..."
}`;
  }

  private handleTaskComplete(
    task: Task,
    result: ExecutionResult,
    onTaskComplete?: (task: Task, result: ExecutionResult) => void
  ): void {
    this.results.set(task.id, result);
    this.completedTasks.add(task.id);

    if (result.success) {
      task.status = "completed";
      task.result = result;
      this.progress.completed++;
    } else {
      task.status = "failed";
      task.error = result.error;
      this.progress.failed++;
    }

    this.progress.running--;
    onTaskComplete?.(task, result);
  }

  private updateProgress(): void {
    this.progress.completed = this.tasks.filter(t => t.status === "completed").length;
    this.progress.failed = this.tasks.filter(t => t.status === "failed").length;
    this.progress.pending = this.tasks.filter(t => t.status === "pending").length;
  }

  private getPendingCount(): number {
    return this.tasks.filter(t => 
      t.status === "pending" || t.status === "in_progress"
    ).length;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

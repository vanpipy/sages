/**
 * StateManager - Workflow State Persistence and Crash Recovery
 *
 * Manages workflow state persistence across crashes, provides crash recovery
 * by loading last known state, manages session lifecycle (create, resume, delete),
 * and implements atomic writes to prevent corruption.
 *
 * Session Path Structure:
 * .sages-session.json          # Main session manifest
 * .sages-session.d/           # Session data directory
 *   {workflowId}/
 *     state.json              # WorkflowExecutionState
 *     locks.json              # Active file locks
 *     circuit.json            # Circuit breaker state
 */

import { promises as fs, constants } from "fs";
import { dirname, join } from "path";
import type { WorkflowExecutionState } from "./types.js";

/** Maximum number of checkpoints to keep */
const MAX_CHECKPOINTS = 3;

/**
 * StateManager handles workflow state persistence and crash recovery.
 * Provides atomic writes, checkpoint versioning, and session management.
 */
export class StateManager {
  private cachedState: WorkflowExecutionState | null = null;
  private sessionManifestPath: string;
  private sessionDataDir: string;

  /**
   * Creates a new StateManager instance.
   * @param sessionPath - Path to the session manifest file (default: .sages-session.json)
   */
  constructor(sessionPath: string = ".sages-session.json") {
    this.sessionManifestPath = sessionPath;
    this.sessionDataDir = sessionPath.replace(/\.json$/, ".d");
  }

  /**
   * Loads workflow execution state from storage.
   * @returns The loaded state or null if not found/corrupted
   */
  async loadState(): Promise<WorkflowExecutionState | null> {
    try {
      const content = await fs.readFile(this.sessionManifestPath, "utf-8");
      const state = JSON.parse(content) as WorkflowExecutionState;
      this.cachedState = state;
      return state;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      // Corrupted JSON - backup and return null
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "EBADMSG") {
        await this.backupCorruptedFile();
        return null;
      }
      throw error;
    }
  }

  /**
   * Saves workflow execution state to storage using atomic write.
   * @param state - The state to save
   */
  async saveState(state: WorkflowExecutionState): Promise<void> {
    const tempPath = this.sessionManifestPath + ".tmp";
    const dir = dirname(this.sessionManifestPath);

    try {
      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      // Atomic write: write to temp file, then rename
      await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf-8");
      await fs.rename(tempPath, this.sessionManifestPath);

      // Update cache
      this.cachedState = state;
    } catch (error: unknown) {
      // Clean up temp file if it exists
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw this.wrapError("saveState", error);
    }
  }

  /**
   * Clears the workflow state from storage.
   */
  async clearState(): Promise<void> {
    try {
      await fs.unlink(this.sessionManifestPath);
      this.cachedState = null;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw this.wrapError("clearState", error);
      }
      // File didn't exist, nothing to clear
    }
  }

  /**
   * Gets the current cached execution state without loading from disk.
   * @returns The cached state or null if not loaded
   */
  getExecutionState(): WorkflowExecutionState | null {
    return this.cachedState;
  }

  /**
   * Checks if a workflow is currently running or pending.
   * @param workflowId - The workflow ID to check
   * @returns True if workflow exists and status is 'running' or 'pending'
   */
  async isWorkflowRunning(workflowId: string): Promise<boolean> {
    const state = await this.loadState();
    if (!state || state.workflowId !== workflowId) {
      return false;
    }
    return state.status === "running" || state.status === "pending";
  }

  /**
   * Creates a checkpoint of the current state with timestamp.
   * Keeps the last 3 checkpoints using timestamp-based naming.
   * @param state - The state to checkpoint
   */
  async checkpoint(state: WorkflowExecutionState): Promise<void> {
    const workflowDir = join(this.sessionDataDir, state.workflowId);

    try {
      await fs.mkdir(workflowDir, { recursive: true });

      // Save state with timestamp using unique filename for each checkpoint
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const checkpointData = {
        ...state,
        checkpointedAt: new Date().toISOString(),
      };
      const statePath = join(workflowDir, `state.${timestamp}.json`);

      // Use atomic write for checkpoint
      const tempPath = statePath + ".tmp";
      await fs.writeFile(tempPath, JSON.stringify(checkpointData, null, 2), "utf-8");
      await fs.rename(tempPath, statePath);

      // Clean up old checkpoints (keep last MAX_CHECKPOINTS)
      await this.pruneCheckpoints(workflowDir);
    } catch (error: unknown) {
      throw this.wrapError("checkpoint", error);
    }
  }

  /**
   * Lists all workflow IDs in the session directory.
   * @returns Array of workflow IDs
   */
  async listSessions(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.sessionDataDir);
      // Filter to only directories (workflow IDs)
      const dirEntries: string[] = [];
      for (const entry of entries) {
        const fullPath = join(this.sessionDataDir, entry);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            dirEntries.push(entry);
          }
        } catch {
          // Skip entries we can't stat
        }
      }
      return dirEntries;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw this.wrapError("listSessions", error);
    }
  }

  /**
   * Deletes a session directory.
   * @param workflowId - The workflow ID to delete
   */
  async deleteSession(workflowId: string): Promise<void> {
    const sessionDir = join(this.sessionDataDir, workflowId);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw this.wrapError("deleteSession", error);
      }
      // Directory didn't exist, nothing to delete
    }
  }

  /**
   * Backs up a corrupted file before overwriting.
   */
  private async backupCorruptedFile(): Promise<void> {
    try {
      const backupPath = this.sessionManifestPath + ".backup";
      await fs.copyFile(this.sessionManifestPath, backupPath);
    } catch {
      // If backup fails, continue - we still want to return null
    }
  }

  /**
   * Removes old checkpoints, keeping only the most recent ones.
   * @param workflowDir - The workflow directory to prune
   */
  private async pruneCheckpoints(workflowDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(workflowDir);

      // Get checkpoint files with their modification times
      // Match pattern: state.{timestamp}.json
      const checkpoints: { name: string; mtime: Date }[] = [];
      for (const entry of entries) {
        if (entry.startsWith("state.") && entry.endsWith(".json")) {
          const fullPath = join(workflowDir, entry);
          const stat = await fs.stat(fullPath);
          checkpoints.push({ name: entry, mtime: stat.mtime });
        }
      }

      // Sort by modification time, newest first
      checkpoints.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Remove old checkpoints beyond MAX_CHECKPOINTS
      for (let i = MAX_CHECKPOINTS; i < checkpoints.length; i++) {
        await fs.unlink(join(workflowDir, checkpoints[i].name));
      }
    } catch {
      // Pruning is best-effort, don't throw
    }
  }

  /**
   * Wraps an error with context about the operation that failed.
   * @param operation - The operation name
   * @param error - The original error
   * @returns A wrapped error with context
   */
  private wrapError(operation: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`StateManager.${operation} failed: ${message}`);
    wrapped.cause = error;
    return wrapped;
  }
}

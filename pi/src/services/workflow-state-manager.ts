/**
 * WorkflowStateManager - Unified state and workspace management
 * 
 * Purpose:
 * - Single source of truth for workflow state
 * - Consolidates StateManager and WorkspaceManager functionality
 * - No duplication between managers
 * 
 * Merged from:
 * - StateManager (workflow sessions, task tracking)
 * - WorkspaceManager (workspace files, archive/restore)
 * 
 * Usage:
 * ```typescript
 * const manager = new WorkflowStateManager(cwd);
 * const state = manager.create("my-plan", "user request");
 * manager.save(state);
 * manager.writeDraft("# Draft content");
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileService } from "./file-service.js";

// ============================================================================
// Types
// ============================================================================

export type FuxiPhase = "idle" | "design" | "plan" | "implement" | "review" | "audit" | "complete";

export interface WorkflowState {
  id: string;
  phase: FuxiPhase;
  planName: string;
  request: string;
  createdAt: string;
  updatedAt: string;
  score?: number;
  auditVerdict?: string | null;
  auditScore?: number;
  auditAttempts?: number;
  tasks?: Task[];
  currentTaskIndex?: number;
}

export interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  files: string[];
  result?: unknown;
}

export interface AuditResult {
  verdict: "PASS" | "NEEDS_CHANGES" | "REJECTED";
  qualityScore: number;
  checks: Record<string, boolean>;
  timestamp: string;
}

export interface ArchiveInfo {
  timestamp: string;
  path: string;
}

// ============================================================================
// WorkflowStateManager
// ============================================================================

export class WorkflowStateManager {
  private readonly cwd: string;
  private readonly fileService: FileService;
  private readonly sessionsDir: string;
  private readonly archiveDir: string;
  private currentState: WorkflowState | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.fileService = new FileService(cwd);
    this.sessionsDir = join(cwd, ".sages/sessions");
    this.archiveDir = join(cwd, ".sages/archive");

    this.ensureDirs();
  }

  /**
   * Ensure all required directories exist
   */
  private ensureDirs(): void {
    const dirs = [
      this.fileService.getWorkspacePath(),
      this.sessionsDir,
      this.archiveDir,
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Get the path to a session file
   */
  private getSessionPath(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }

  // ===========================================================================
  // State CRUD Operations
  // ===========================================================================

  /**
   * Create a new workflow
   */
  create(planName: string, request: string): WorkflowState {
    const now = new Date().toISOString();
    const state: WorkflowState = {
      id: `sages-${Date.now()}`,
      phase: "design",
      planName,
      request,
      createdAt: now,
      updatedAt: now,
    };

    this.save(state);
    return state;
  }

  /**
   * Save state to session file and workspace
   */
  save(state: WorkflowState): void {
    state.updatedAt = new Date().toISOString();

    // Save to session file
    const sessionPath = this.getSessionPath(state.id);
    writeFileSync(sessionPath, JSON.stringify(state, null, 2));

    // Save to workspace for easy access
    this.fileService.writeJson("state.json", state);

    this.currentState = state;
  }

  /**
   * Load state by ID
   */
  load(id: string): WorkflowState | null {
    const path = this.getSessionPath(id);
    if (!existsSync(path)) {
      return null;
    }

    try {
      const content = readFileSync(path, "utf-8");
      this.currentState = JSON.parse(content) as WorkflowState;
      return this.currentState;
    } catch {
      return null;
    }
  }

  /**
   * Load latest state from workspace
   */
  loadLatest(): WorkflowState | null {
    return this.fileService.readJson<WorkflowState>("state.json");
  }

  /**
   * Delete a session
   */
  delete(id: string): void {
    const path = this.getSessionPath(id);
    if (existsSync(path)) {
      rmSync(path);
    }

    if (this.currentState?.id === id) {
      this.currentState = null;
    }
  }

  /**
   * Get current state
   */
  getState(): WorkflowState | null {
    return this.currentState;
  }

  // ===========================================================================
  // Workflow Operations
  // ===========================================================================

  /**
   * Update the current phase
   */
  setPhase(phase: FuxiPhase): void {
    if (!this.currentState) return;
    this.currentState.phase = phase;
    this.save(this.currentState);
  }

  /**
   * Get current phase
   */
  getPhase(): FuxiPhase {
    return this.currentState?.phase || "idle";
  }

  /**
   * Set tasks for current workflow
   */
  setTasks(tasks: Task[]): void {
    if (!this.currentState) return;
    this.currentState.tasks = tasks;
    this.currentState.currentTaskIndex = 0;
    this.save(this.currentState);
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: Task["status"], result?: unknown): void {
    if (!this.currentState?.tasks) return;

    const task = this.currentState.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = status;
      if (result) task.result = result;
      this.save(this.currentState);
    }
  }

  /**
   * Get current task
   */
  getCurrentTask(): Task | null {
    if (!this.currentState?.tasks || this.currentState.currentTaskIndex === undefined) {
      return null;
    }
    return this.currentState.tasks[this.currentState.currentTaskIndex] || null;
  }

  /**
   * Advance to next task
   */
  advanceTask(): void {
    if (!this.currentState) return;
    if (this.currentState.currentTaskIndex !== undefined) {
      this.currentState.currentTaskIndex++;
      this.save(this.currentState);
    }
  }

  /**
   * Set audit result
   */
  setAuditResult(result: AuditResult): void {
    if (!this.currentState) return;
    this.currentState.auditVerdict = result.verdict;
    this.currentState.auditScore = result.qualityScore;
    this.save(this.currentState);
  }

  /**
   * Complete the workflow
   */
  complete(): void {
    if (!this.currentState) return;
    this.currentState.phase = "complete";
    this.save(this.currentState);
  }

  // ===========================================================================
  // Workspace File Operations
  // ===========================================================================

  /**
   * Read draft content
   */
  readDraft(): string | null {
    return this.fileService.read("draft.md");
  }

  /**
   * Write draft content
   */
  writeDraft(content: string): string | null {
    return this.fileService.write("draft.md", content);
  }

  /**
   * Read plan content
   */
  readPlan(): string | null {
    return this.fileService.read("plan.md");
  }

  /**
   * Write plan content
   */
  writePlan(content: string): string | null {
    return this.fileService.write("plan.md", content);
  }

  /**
   * Read execution config
   */
  readExecution(): string | null {
    return this.fileService.read("execution.yaml");
  }

  /**
   * Write execution config
   */
  writeExecution(content: string): string | null {
    return this.fileService.write("execution.yaml", content);
  }

  /**
   * Read audit report
   */
  readAudit(): string | null {
    return this.fileService.read("audit.md");
  }

  /**
   * Write audit report
   */
  writeAudit(content: string): string | null {
    return this.fileService.write("audit.md", content);
  }

  /**
   * Read tasks from execution.yaml
   */
  readTasks(): Task[] | null {
    const content = this.fileService.read("execution.yaml");
    if (!content) return null;

    // Simple YAML parsing for tasks section
    const tasks: Task[] = [];
    const lines = content.split("\n");
    let currentTask: Partial<Task> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("- id:")) {
        if (currentTask?.id) {
          tasks.push(currentTask as Task);
        }
        currentTask = { id: trimmed.split(":")[1].trim(), dependsOn: [], files: [] };
      } else if (currentTask && trimmed.startsWith("description:")) {
        currentTask.description = trimmed.split(":")[1].trim().replace(/^"/, "").replace(/"$/, "");
      } else if (currentTask && trimmed.startsWith("priority:")) {
        currentTask.priority = trimmed.split(":")[1].trim() as Task["priority"];
      } else if (currentTask && trimmed.startsWith("dependsOn:")) {
        const deps = trimmed.split(":")[1].trim();
        if (deps && deps !== "[]") {
          currentTask.dependsOn = deps.split(",").map(d => d.trim().replace(/"/g, ""));
        }
      }
    }

    if (currentTask?.id) {
      tasks.push(currentTask as Task);
    }

    return tasks.length > 0 ? tasks : null;
  }

  // ===========================================================================
  // Archive Operations
  // ===========================================================================

  /**
   * Archive current workspace to .sages/archive/{planName}/{timestamp}/
   */
  archive(): string | null {
    if (!this.currentState) return null;

    const { planName } = this.currentState;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(this.archiveDir, planName, timestamp);

    // Create archive directory
    if (!existsSync(archivePath)) {
      mkdirSync(archivePath, { recursive: true });
    }

    // Files to archive
    const files = ["draft.md", "plan.md", "execution.yaml", "state.json", "audit.md"];

    // Copy files to archive
    for (const file of files) {
      const src = this.fileService.getFilePath(file);
      const dest = join(archivePath, file);

      if (existsSync(src)) {
        cpSync(src, dest);
      }
    }

    // Generate and save summary
    const summary = this.generateSummary();
    writeFileSync(join(archivePath, "summary.md"), summary);

    // Delete session file
    this.delete(this.currentState.id);

    // Clear workspace
    this.clearWorkspace();

    // Clear current state
    this.currentState = null;

    return archivePath;
  }

  /**
   * Generate summary for archive
   */
  private generateSummary(): string {
    const state = this.currentState;
    if (!state) return "";

    const files = ["draft.md", "plan.md", "execution.yaml", "audit.md"];

    let summary = `# Workflow Archive: ${state.planName}

**Archived:** ${new Date().toISOString()}
**Request:** ${state.request}
**Final Phase:** ${state.phase}
**Quality Score:** ${state.auditScore || "N/A"}

## Files

`;

    for (const file of files) {
      const exists = this.fileService.exists(file);
      summary += `- ${exists ? "✅" : "❌"} ${file}\n`;
    }

    if (state.tasks && state.tasks.length > 0) {
      summary += `\n## Tasks\n\n`;
      for (const task of state.tasks) {
        const icon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : "⏳";
        summary += `${icon} ${task.id}: ${task.description}\n`;
      }
    }

    summary += `\n---\n*Archived by Four Sages Agents*`;

    return summary;
  }

  /**
   * Clear workspace for new workflow
   */
  clearWorkspace(): void {
    const files = this.fileService.listFiles();
    for (const file of files) {
      this.fileService.delete(file);
    }
  }

  /**
   * List archives for a plan
   */
  listArchives(planName: string): ArchiveInfo[] {
    const archiveDir = join(this.archiveDir, planName);
    if (!existsSync(archiveDir)) return [];

    try {
      return readdirSync(archiveDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => ({
          timestamp: entry.name,
          path: join(archiveDir, entry.name),
        }))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      return [];
    }
  }

  /**
   * List all archived plans
   */
  listArchivedPlans(): string[] {
    if (!existsSync(this.archiveDir)) return [];

    try {
      return readdirSync(this.archiveDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * Restore an archive to workspace
   */
  restore(planName: string, timestamp: string): boolean {
    const archiveDir = join(this.archiveDir, planName, timestamp);
    if (!existsSync(archiveDir)) return false;

    // Clear current workspace
    this.clearWorkspace();

    // Copy files from archive to workspace
    const files = ["draft.md", "plan.md", "execution.yaml", "state.json", "audit.md"];

    for (const file of files) {
      const src = join(archiveDir, file);
      const dest = this.fileService.getFilePath(file);

      if (existsSync(src)) {
        cpSync(src, dest);
      }
    }

    // Load state from restored workspace
    this.currentState = this.loadLatest();

    return true;
  }

  /**
   * Get workspace path
   */
  getWorkspacePath(): string {
    return this.fileService.getWorkspacePath();
  }

  /**
   * Check if workspace has any content
   */
  isWorkspaceEmpty(): boolean {
    return this.fileService.listFiles().length === 0;
  }
}

// Export singleton factory
export const createWorkflowStateManager = (cwd: string) => new WorkflowStateManager(cwd);

/**
 * State Manager for Four Sages workflow
 * Handles persistence, recovery, and workspace management
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowState {
  id: string;
  phase: "idle" | "design" | "review" | "plan" | "execute" | "audit" | "complete";
  planName: string;
  request: string;
  createdAt: string;
  updatedAt: string;
  tasks?: Task[];
  currentTaskIndex?: number;
  auditResult?: AuditResult;
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

const WORKSPACE_DIR = ".sages/workspace";
const ARCHIVE_DIR = ".sages/archive";
const SESSIONS_DIR = ".sages/sessions";

export class StateManager {
  private cwd: string;
  private workspacePath: string;
  private archivePath: string;
  private currentState: WorkflowState | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.workspacePath = join(cwd, WORKSPACE_DIR);
    this.archivePath = join(cwd, ARCHIVE_DIR);
    this.ensureDirs();
  }

  private ensureDirs(): void {
    try {
      if (!existsSync(this.workspacePath)) {
        mkdirSync(this.workspacePath, { recursive: true });
      }
      if (!existsSync(join(this.cwd, SESSIONS_DIR))) {
        mkdirSync(join(this.cwd, SESSIONS_DIR), { recursive: true });
      }
      if (!existsSync(this.archivePath)) {
        mkdirSync(this.archivePath, { recursive: true });
      }
    } catch {
      // Ignore errors - dirs may already exist or permissions issue
    }
  }

  private getStatePath(id: string): string {
    return join(this.cwd, SESSIONS_DIR, `${id}.json`);
  }

  // ===========================================================================
  // State Persistence
  // ===========================================================================

  save(state: WorkflowState): void {
    // Ensure dirs exist before saving
    this.ensureDirs();
    state.updatedAt = new Date().toISOString();
    const path = this.getStatePath(state.id);
    writeFileSync(path, JSON.stringify(state, null, 2));
    this.currentState = state;
    this.saveToWorkspace(state);
  }

  load(id: string): WorkflowState | null {
    // Ensure dirs exist (in case they were accidentally deleted)
    this.ensureDirs();
    
    const path = this.getStatePath(id);
    if (!existsSync(path)) return null;
    
    try {
      const content = readFileSync(path, "utf-8");
      this.currentState = JSON.parse(content) as WorkflowState;
      return this.currentState;
    } catch {
      return null;
    }
  }

  loadLatest(): WorkflowState | null {
    return this.currentState;
  }

  delete(id: string): void {
    const path = this.getStatePath(id);
    if (existsSync(path)) {
      rmSync(path);
    }
    if (this.currentState?.id === id) {
      this.currentState = null;
    }
  }

  // ===========================================================================
  // Workflow Operations
  // ===========================================================================

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

  updatePhase(phase: WorkflowState["phase"]): void {
    if (!this.currentState) return;
    this.currentState.phase = phase;
    this.save(this.currentState);
  }

  setTasks(tasks: Task[]): void {
    if (!this.currentState) return;
    this.currentState.tasks = tasks;
    this.currentState.currentTaskIndex = 0;
    this.save(this.currentState);
  }

  updateTaskStatus(taskId: string, status: Task["status"], result?: unknown): void {
    if (!this.currentState?.tasks) return;
    const task = this.currentState.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = status;
      if (result) task.result = result;
    }
    this.save(this.currentState);
  }

  getCurrentTask(): Task | null {
    if (!this.currentState?.tasks || this.currentState.currentTaskIndex === undefined) return null;
    return this.currentState.tasks[this.currentState.currentTaskIndex] || null;
  }

  advanceTask(): void {
    if (!this.currentState) return;
    if (this.currentState.currentTaskIndex !== undefined) {
      this.currentState.currentTaskIndex++;
    }
    this.save(this.currentState);
  }

  setAuditResult(result: AuditResult): void {
    if (!this.currentState) return;
    this.currentState.auditResult = result;
    this.save(this.currentState);
  }

  getState(): WorkflowState | null {
    return this.currentState;
  }

  complete(): void {
    if (!this.currentState) return;
    this.currentState.phase = "complete";
    this.save(this.currentState);
  }

  // ===========================================================================
  // Workspace Operations
  // ===========================================================================

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  saveToWorkspace(state: WorkflowState): void {
    // Save state to workspace for easy access
    writeFileSync(join(this.workspacePath, "state.json"), JSON.stringify(state, null, 2));
  }

  loadFromWorkspace(): WorkflowState | null {
    const path = join(this.workspacePath, "state.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as WorkflowState;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Archive Operations
  // ===========================================================================

  /**
   * Archive the complete workflow to .sages/archive/{planName}/{timestamp}/
   */
  archive(): string | null {
    if (!this.currentState) return null;

    const { planName, id } = this.currentState;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveDir = join(this.archivePath, planName, timestamp);

    // Create archive directory
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true });
    }

    // Files to archive
    const files = [
      { src: join(this.workspacePath, "draft.md"), dest: "draft.md" },
      { src: join(this.workspacePath, "plan.md"), dest: "plan.md" },
      { src: join(this.workspacePath, "execution.yaml"), dest: "execution.yaml" },
      { src: join(this.workspacePath, "tasks.json"), dest: "tasks.json" },
      { src: join(this.workspacePath, "state.json"), dest: "state.json" },
      { src: join(this.workspacePath, "audit.md"), dest: "audit.md" },
    ];

    // Copy files
    for (const { src, dest } of files) {
      if (existsSync(src)) {
        cpSync(src, join(archiveDir, dest));
      }
    }

    // Generate and save summary
    const summary = this.generateSummary();
    writeFileSync(join(archiveDir, "summary.md"), summary);

    // Delete session file (no longer needed)
    this.delete(id);

    // Clear workspace
    this.clearWorkspace();

    // Clear current state
    this.currentState = null;

    return archiveDir;
  }

  /**
   * Generate summary for archive
   */
  private generateSummary(): string {
    const state = this.currentState;
    if (!state) return "";

    let summary = `# Workflow Archive: ${state.planName}

**Archived:** ${new Date().toISOString()}
**Request:** ${state.request}
**Final Phase:** ${state.phase}
**Quality Score:** ${state.auditResult?.qualityScore || "N/A"}

## Files

- ${existsSync(join(this.workspacePath, "draft.md")) ? "✅" : "❌"} draft.md (Fuxi's design)
- ${existsSync(join(this.workspacePath, "plan.md")) ? "✅" : "❌"} plan.md (Task plan)
- ${existsSync(join(this.workspacePath, "execution.yaml")) ? "✅" : "❌"} execution.yaml
- ${existsSync(join(this.workspacePath, "tasks.json")) ? "✅" : "❌"} tasks.json
- ${existsSync(join(this.workspacePath, "audit.md")) ? "✅" : "❌"} audit.md

`;

    if (state.tasks && state.tasks.length > 0) {
      summary += `## Tasks\n\n`;
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
    try {
      const files = readdirSync(this.workspacePath);
      for (const file of files) {
        unlinkSync(join(this.workspacePath, file));
      }
    } catch {
      // Directory might be empty
    }
  }

  /**
   * List all archives for a plan
   */
  listArchives(planName: string): Array<{ timestamp: string; path: string }> {
    const archiveDir = join(this.archivePath, planName);
    if (!existsSync(archiveDir)) return [];

    try {
      return readdirSync(archiveDir, { withFileTypes: true })
        .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
        .map((entry: { name: string }) => ({
          timestamp: entry.name,
          path: join(archiveDir, entry.name),
        }))
        .sort((a: { timestamp: string }, b: { timestamp: string }) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      return [];
    }
  }

  /**
   * List all archived plans
   */
  listArchivedPlans(): string[] {
    if (!existsSync(this.archivePath)) return [];

    try {
      return readdirSync(this.archivePath, { withFileTypes: true })
        .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
        .map((entry: { name: string }) => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * Restore an archive to workspace
   */
  restore(planName: string, timestamp: string): boolean {
    const archiveDir = join(this.archivePath, planName, timestamp);
    if (!existsSync(archiveDir)) return false;

    // Clear current workspace
    this.clearWorkspace();

    // Copy files from archive
    const files = ["draft.md", "plan.md", "execution.yaml", "tasks.json", "state.json", "audit.md"];
    for (const file of files) {
      const src = join(archiveDir, file);
      if (existsSync(src)) {
        cpSync(src, join(this.workspacePath, file));
      }
    }

    // Load state from restored workspace
    this.currentState = this.loadFromWorkspace();

    return true;
  }

  /**
   * Get workspace file paths
   */
  getWorkspaceFiles(): { draft?: string; plan?: string; execution?: string; tasks?: string; audit?: string } {
    const files: Record<string, string | undefined> = {};
    const fileMap: Record<string, string> = {
      draft: "draft.md",
      plan: "plan.md",
      execution: "execution.yaml",
      tasks: "tasks.json",
      audit: "audit.md",
    };

    for (const [key, filename] of Object.entries(fileMap)) {
      const path = join(this.workspacePath, filename);
      if (existsSync(path)) {
        files[key] = path;
      }
    }

    return files;
  }
}

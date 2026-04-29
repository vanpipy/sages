/**
 * Workspace Manager - Handles current workflow workspace
 * Files live in .sages/workspace/ during active workflow
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface WorkspaceFiles {
  draft?: string;
  plan?: string;
  execution?: string;
  state?: string;
  tasks?: string;
  audit?: string;
}

const WORKSPACE_DIR = ".sages/workspace";
const ARCHIVE_DIR = ".sages/archive";

export class WorkspaceManager {
  private cwd: string;
  private workspacePath: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.workspacePath = join(cwd, WORKSPACE_DIR);
    this.ensureWorkspace();
  }

  private ensureWorkspace(): void {
    if (!existsSync(this.workspacePath)) {
      mkdirSync(this.workspacePath, { recursive: true });
    }
  }

  // ===========================================================================
  // Workspace File Operations
  // ===========================================================================

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Save draft to workspace
   */
  saveDraft(content: string): string {
    const path = join(this.workspacePath, "draft.md");
    writeFileSync(path, content);
    return path;
  }

  /**
   * Save plan to workspace
   */
  savePlan(content: string): string {
    const path = join(this.workspacePath, "plan.md");
    writeFileSync(path, content);
    return path;
  }

  /**
   * Save execution config to workspace
   */
  saveExecution(content: string): string {
    const path = join(this.workspacePath, "execution.yaml");
    writeFileSync(path, content);
    return path;
  }

  /**
   * Save tasks to workspace
   */
  saveTasks(tasks: unknown): string {
    const path = join(this.workspacePath, "tasks.json");
    writeFileSync(path, JSON.stringify(tasks, null, 2));
    return path;
  }

  /**
   * Save workflow state to workspace
   */
  saveState(state: unknown): string {
    const path = join(this.workspacePath, "state.json");
    writeFileSync(path, JSON.stringify(state, null, 2));
    return path;
  }

  /**
   * Save audit report to workspace
   */
  saveAudit(content: string): string {
    const path = join(this.workspacePath, "audit.md");
    writeFileSync(path, content);
    return path;
  }

  /**
   * Save summary to workspace
   */
  saveSummary(content: string): string {
    const path = join(this.workspacePath, "summary.md");
    writeFileSync(path, content);
    return path;
  }

  // ===========================================================================
  // Read Operations
  // ===========================================================================

  readDraft(): string | null {
    const path = join(this.workspacePath, "draft.md");
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }

  readPlan(): string | null {
    const path = join(this.workspacePath, "plan.md");
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }

  readExecution(): string | null {
    const path = join(this.workspacePath, "execution.yaml");
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }

  readTasks(): unknown | null {
    const path = join(this.workspacePath, "tasks.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  readState(): unknown | null {
    const path = join(this.workspacePath, "state.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  readAudit(): string | null {
    const path = join(this.workspacePath, "audit.md");
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }

  // ===========================================================================
  // File Existence Checks
  // ===========================================================================

  hasDraft(): boolean {
    return existsSync(join(this.workspacePath, "draft.md"));
  }

  hasPlan(): boolean {
    return existsSync(join(this.workspacePath, "plan.md"));
  }

  hasExecution(): boolean {
    return existsSync(join(this.workspacePath, "execution.yaml"));
  }

  hasTasks(): boolean {
    return existsSync(join(this.workspacePath, "tasks.json"));
  }

  hasAudit(): boolean {
    return existsSync(join(this.workspacePath, "audit.md"));
  }

  /**
   * Check if workspace has any content
   */
  isEmpty(): boolean {
    return !this.hasDraft() && !this.hasPlan() && !this.hasTasks();
  }

  // ===========================================================================
  // Archive Operations
  // ===========================================================================

  /**
   * Archive current workspace to .sages/archive/{planName}/{timestamp}/
   */
  archive(planName: string, summary?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(this.cwd, ARCHIVE_DIR, planName, timestamp);

    // Create archive directory
    if (!existsSync(archivePath)) {
      mkdirSync(archivePath, { recursive: true });
    }

    // Copy all workspace files to archive
    const files: WorkspaceFiles = {
      draft: this.readDraft() ?? undefined,
      plan: this.readPlan() ?? undefined,
      execution: this.readExecution() ?? undefined,
      tasks: this.readTasks() ? JSON.stringify(this.readTasks(), null, 2) : undefined,
      state: this.readState() ? JSON.stringify(this.readState(), null, 2) : undefined,
      audit: this.readAudit() ?? undefined,
    };

    // Write files to archive
    if (files.draft) writeFileSync(join(archivePath, "draft.md"), files.draft);
    if (files.plan) writeFileSync(join(archivePath, "plan.md"), files.plan);
    if (files.execution) writeFileSync(join(archivePath, "execution.yaml"), files.execution);
    if (files.tasks) writeFileSync(join(archivePath, "tasks.json"), files.tasks);
    if (files.state) writeFileSync(join(archivePath, "state.json"), files.state);
    if (files.audit) writeFileSync(join(archivePath, "audit.md"), files.audit);

    // Write summary
    const summaryContent = summary || this.generateSummary(planName, timestamp);
    writeFileSync(join(archivePath, "summary.md"), summaryContent);

    return archivePath;
  }

  /**
   * Generate summary for archived workflow
   */
  private generateSummary(planName: string, timestamp: string): string {
    const tasks = this.readTasks() as Array<{ id: string; description: string; status: string }> | null;
    const state = this.readState() as { phase?: string; request?: string } | null;

    let summary = `# Workflow Archive: ${planName}

**Archived:** ${new Date(timestamp.replace(/-/g, ":").slice(0, 19)).toISOString()}
**Request:** ${state?.request || "N/A"}
**Final Phase:** ${state?.phase || "N/A"}

## Files

`;

    if (this.hasDraft()) summary += "- ✅ draft.md (Fuxi's design)\n";
    if (this.hasPlan()) summary += "- ✅ plan.md (Task plan)\n";
    if (this.hasExecution()) summary += "- ✅ execution.yaml (Execution config)\n";
    if (this.hasTasks()) summary += "- ✅ tasks.json (Task definitions)\n";
    if (this.hasAudit()) summary += "- ✅ audit.md (Audit report)\n";

    if (tasks && tasks.length > 0) {
      summary += `\n## Tasks\n\n`;
      for (const task of tasks) {
        const icon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : "⏳";
        summary += `${icon} ${task.id}: ${task.description}\n`;
      }
    }

    summary += `\n---\n*Archived by Four Sages Agents*`;

    return summary;
  }

  /**
   * List all archives for a plan
   */
  listArchives(planName: string): Array<{ timestamp: string; path: string }> {
    const archiveDir = join(this.cwd, ARCHIVE_DIR, planName);
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
    const archiveDir = join(this.cwd, ARCHIVE_DIR);
    if (!existsSync(archiveDir)) return [];

    try {
      return readdirSync(archiveDir, { withFileTypes: true })
        .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
        .map((entry: { name: string }) => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * Restore an archived workflow to workspace
   */
  restore(planName: string, timestamp: string): boolean {
    const archivePath = join(this.cwd, ARCHIVE_DIR, planName, timestamp);
    if (!existsSync(archivePath)) return false;

    // Clear current workspace
    this.clear();

    // Copy files from archive to workspace
    const files = ["draft.md", "plan.md", "execution.yaml", "tasks.json", "state.json", "audit.md"];
    for (const file of files) {
      const src = join(archivePath, file);
      if (existsSync(src)) {
        cpSync(src, join(this.workspacePath, file));
      }
    }

    return true;
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Clear workspace for new workflow
   */
  clear(): void {
    
    try {
      const files = readdirSync(this.workspacePath);
      for (const file of files) {
        unlinkSync(join(this.workspacePath, file));
      }
    } catch {
      // Directory might be empty or not exist
    }
  }

  /**
   * Delete workspace entirely
   */
  delete(): void {
    if (existsSync(this.workspacePath)) {
      rmSync(this.workspacePath, { recursive: true, force: true });
    }
  }
}

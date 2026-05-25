/**
 * FileService - Centralized file operations with security validation
 * 
 * Purpose:
 * - Wraps node:fs operations with path validation
 * - Prevents path traversal attacks
 * - Sanitizes regex patterns
 * - Provides consistent error handling
 * 
 * Usage:
 * ```typescript
 * const fileService = new FileService(cwd);
 * const content = fileService.read("draft.md");
 * fileService.write("output.md", "content");
 * ```
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";

export class FileService {
  private readonly cwd: string;
  private readonly workspaceDir: string;
  private readonly allowedDir: string;

  constructor(cwd: string, workspaceDir: string = ".sages/workspace") {
    this.cwd = cwd;
    this.workspaceDir = workspaceDir;
    this.allowedDir = resolve(cwd, workspaceDir);
    this.ensureWorkspace();
  }

  /**
   * Get the workspace path for this service
   */
  getWorkspacePath(): string {
    return this.allowedDir;
  }

  /**
   * Get the full path to a workspace file
   * Validates the path is within workspace
   */
  getFilePath(filename: string): string {
    return join(this.allowedDir, filename);
  }

  /**
   * Validate that a filename doesn't contain path traversal
   * Returns true if safe, false if traversal detected
   */
  validatePath(filename: string): boolean {
    // Reject absolute paths
    if (isAbsolute(filename)) {
      return false;
    }

    // Reject paths with traversal attempts
    if (filename.includes("..") || filename.includes("~")) {
      return false;
    }

    // Reject paths with null bytes
    if (filename.includes("\0")) {
      return false;
    }

    // Resolve the path and verify it's within allowedDir
    const fullPath = resolve(this.allowedDir, filename);
    return fullPath.startsWith(this.allowedDir);
  }

  /**
   * Sanitize a pattern for safe regex use
   * Escapes all regex special characters including *
   */
  sanitizeRegex(pattern: string): string {
    return pattern.replace(/[.+*^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Check if a file exists in workspace
   */
  exists(filename: string): boolean {
    if (!this.validatePath(filename)) {
      return false;
    }
    return existsSync(this.getFilePath(filename));
  }

  /**
   * Read a file from workspace
   * Returns null if file doesn't exist or path is invalid
   */
  read(filename: string): string | null {
    if (!this.validatePath(filename)) {
      console.warn(`[FileService] Path validation failed: ${filename}`);
      return null;
    }

    const fullPath = this.getFilePath(filename);

    if (!existsSync(fullPath)) {
      return null;
    }

    try {
      return readFileSync(fullPath, "utf-8");
    } catch (err) {
      console.error(`[FileService] Failed to read ${filename}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Write content to a file in workspace
   * Creates parent directories if needed
   * Returns the full path on success, null on failure
   */
  write(filename: string, content: string): string | null {
    if (!this.validatePath(filename)) {
      console.warn(`[FileService] Path validation failed: ${filename}`);
      return null;
    }

    const fullPath = this.getFilePath(filename);

    try {
      // Ensure directory exists
      const dir = join(fullPath, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, content, "utf-8");
      return fullPath;
    } catch (err) {
      console.error(`[FileService] Failed to write ${filename}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Read and parse JSON file
   * Returns null if invalid JSON or file doesn't exist
   */
  readJson<T>(filename: string): T | null {
    const content = this.read(filename);
    if (!content) {
      return null;
    }

    try {
      return JSON.parse(content) as T;
    } catch (err) {
      console.error(`[FileService] Failed to parse JSON from ${filename}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Write JSON to file with formatting
   */
  writeJson(filename: string, data: unknown): string | null {
    try {
      const content = JSON.stringify(data, null, 2);
      return this.write(filename, content);
    } catch (err) {
      console.error(`[FileService] Failed to stringify JSON for ${filename}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Delete a file from workspace
   */
  delete(filename: string): boolean {
    if (!this.validatePath(filename)) {
      console.warn(`[FileService] Path validation failed for delete: ${filename}`);
      return false;
    }

    const fullPath = this.getFilePath(filename);

    if (!existsSync(fullPath)) {
      return false;
    }

    try {
      unlinkSync(fullPath);
      return true;
    } catch (err) {
      console.error(`[FileService] Failed to delete ${filename}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * List files in workspace directory
   */
  listFiles(): string[] {
    try {
      if (!existsSync(this.allowedDir)) {
        return [];
      }
      return readdirSync(this.allowedDir);
    } catch {
      return [];
    }
  }

  /**
   * Ensure workspace directory exists
   */
  ensureWorkspace(): void {
    if (!existsSync(this.allowedDir)) {
      mkdirSync(this.allowedDir, { recursive: true });
    }
  }

  /**
   * Read audit verdict from audit.md
   * Parses verdict and score from markdown content
   */
  readAuditVerdict(): { verdict: string | null; score: number | undefined } {
    const content = this.read("audit.md");
    if (!content) {
      return { verdict: null, score: undefined };
    }

    // Extract verdict - match **Verdict**: PASS or Verdict: PASS
    const verdictMatch = content.match(/\*\*Verdict\*\*:\s*([A-Z_]+)/i) ||
                        content.match(/Verdict:\s*([A-Z_]+)/i);
    const verdict = verdictMatch?.[1] || null;

    // Extract score - match **Score**: 95 or Score: 95 or (95%)
    const scoreMatch = content.match(/\*\*Score\*\*:\s*(\d+)/i) ||
                      content.match(/Score:\s*(\d+)/i) ||
                      content.match(/\(\s*(\d+)\s*%\)/);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : undefined;

    return { verdict, score };
  }
}

// Singleton instance for convenience
export const createFileService = (cwd: string) => new FileService(cwd);

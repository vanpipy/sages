/**
 * Conflict Detector — Pure function for detecting file conflicts across tasks
 *
 * Part of: src/tools/luban/
 * Purpose: S6 contract — pure, no I/O, deterministic
 *
 * Used by scheduler.ts to decide whether a batch can run in parallel
 * or must auto-degrade to serial (KD-2).
 */

import type { ConflictReport, LubanTask } from "./types.js";

/**
 * Normalize a file path for conflict comparison.
 *
 * Rules:
 * - Convert backslashes to forward slashes (Windows compat).
 * - Strip trailing slashes.
 * - Strip leading "./" (relative prefix).
 * - Lowercase (case-insensitive filesystems).
 *
 * This matches qiaochui's `normalizeFilePath` (qiaochui/decompose-service.ts) so
 * that conflict detection stays consistent with task decomposition. Sharing the
 * helper avoids the drift seen in earlier revisions.
 */
export function normalizeFilePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^\.\//, "")
    .toLowerCase();
}

/**
 * Derive test file paths from source files. Used as fallback when
 * `LubanTask.testFiles` is not explicitly provided.
 *
 * Rule: `*.ts → *.test.ts`, `*.js → *.test.js`, others unchanged.
 * Centralized to avoid DRY violations across index.ts / scheduler.ts.
 */
export function deriveTestFiles(sourceFiles: string[]): string[] {
  // \.(ts|js)$ captures the extension WITHOUT the leading dot;
  // replacement adds both the leading "." and "test." prefix.
  return sourceFiles.map((f) => f.replace(/\.(ts|js)$/, ".test.$1"));
}

/**
 * Scan a list of tasks and report files that appear in more than one task.
 *
 * Conflict surface = task.files ∪ task.testFiles (when testFiles is provided).
 * Empty/whitespace-only inputs return an empty report.
 *
 * @param tasks - Tasks to scan. Empty array returns {conflicts: [], owners: new Map()}.
 * @returns ConflictReport with `conflicts` (sorted by first-seen order) and
 *          `owners` (file → list of task IDs that reference it).
 *
 * @example
 * detectFileConflicts([
 *   { id: 'T1', files: ['a.ts'], ... },
 *   { id: 'T2', files: ['a.ts', 'b.ts'], ... },
 * ])
 * // → { conflicts: ['a.ts'], owners: Map { 'a.ts' => ['T1','T2'], 'b.ts' => ['T2'] } }
 */
export function detectFileConflicts(tasks: LubanTask[]): ConflictReport {
  const owners = new Map<string, string[]>();

  for (const task of tasks) {
    // Surface = sourceFiles ∪ testFiles (S5: tests count as conflict surface)
    // Normalize paths so "./src/a.ts" === "src/a.ts" (consistent with qiaochui).
    const surface: string[] = [...task.files, ...(task.testFiles ?? [])].map(normalizeFilePath);

    for (const file of surface) {
      const existing = owners.get(file);
      if (existing) {
        existing.push(task.id);
      } else {
        owners.set(file, [task.id]);
      }
    }
  }

  // conflicts = files with more than one owner
  const conflicts: string[] = [];
  for (const [file, ids] of owners.entries()) {
    if (ids.length > 1) {
      conflicts.push(file);
    }
  }

  return { conflicts, owners };
}
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
    const surface: string[] = [...task.files];
    if (task.testFiles) {
      surface.push(...task.testFiles);
    }

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
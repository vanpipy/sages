/**
 * Conflict Detector — Path helpers for luban_execute_task
 *
 * Part of: src/tools/luban/
 * Purpose: shared helpers used by luban_execute_task for file path
 * normalization and test-file derivation.
 *
 * Batch-level conflict detection (detectFileConflicts) was removed when
 * luban_run_batch was deleted — the LLM now reads execution.yaml directly
 * via semantic tools and iterates per task, so batch scheduling is no
 * longer performed by the tool runtime.
 */

/**
 * Normalize a file path for comparison.
 *
 * Rules:
 * - Convert backslashes to forward slashes (Windows compat).
 * - Strip trailing slashes.
 * - Strip leading "./" (relative prefix).
 * - Lowercase (case-insensitive filesystems).
 *
 * This matches qiaochui's `normalizeFilePath` (qiaochui/decompose-service.ts) so
 * that path handling stays consistent across roles. Sharing the helper avoids
 * drift between decomposition and execution.
 */
export function normalizeFilePath(filePath: string): string {
	return filePath
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.replace(/^\.\//, "")
		.toLowerCase();
}

/**
 * Derive test file paths from source files. Used as the default when
 * `LubanTask.testFiles` is not explicitly provided to luban_execute_task.
 *
 * Rule: `*.ts → *.test.ts`, `*.js → *.test.js`, others unchanged.
 */
export function deriveTestFiles(sourceFiles: string[]): string[] {
	// \.(ts|js)$ captures the extension WITHOUT the leading dot;
	// replacement adds both the leading "." and "test." prefix.
	return sourceFiles.map((f) => f.replace(/\.(ts|js)$/, ".test.$1"));
}
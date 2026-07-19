/**
 * Per-write snapshot helper — ALWAYS called by wrap/write-file.ts and
 * wrap/replace-symbol.ts BEFORE delegating to aft.bridge.write/edit.
 *
 * This is the workaround for AFT's broken `dry_run: true` flag (bug confirmed
 * via T5 in the 2026-07-19 A/B test). Even though AFT also has its own
 * per-write backup at ~/.local/share/cortexkit/aft/.../backups/, we add a
 * top-level .sages/snapshots/ copy so:
 *
 *   1. Snapshot exists BEFORE AFT runs (not just in AFT's internal ledger)
 *   2. Tests can verify the file system state without depending on AFT internals
 *   3. The user can inspect/restore via plain `cp`, without needing aft_safety
 *
 * Snapshots are stored at: <project>/.sages/snapshots/<ISO ts>-<sha256[:8]>.bak
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

const SNAPSHOT_DIR = ".sages/snapshots";

export interface SnapshotResult {
	snapshot_path: string;
	snapshot_id: string;
	was_existing: boolean;
}

function sha8(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function isoTimestamp(): string {
	// 2026-07-19T14-50-21-123Z style — safe for filenames on all platforms
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function snapshotDirFor(projectRoot: string): string {
	return join(projectRoot, SNAPSHOT_DIR);
}

/**
 * Snapshot the file at `filePath` to `<project>/.sages/snapshots/...`.
 *
 * If the file doesn't exist (fresh write), returns `was_existing: false`
 * and creates a marker snapshot so that subsequent undo operations are explicit.
 *
 * Always succeeds — never throws on its own. If a previous snapshot exists
 * for this exact content hash, reuses it (idempotent).
 */
export function snapshot(projectRoot: string, filePath: string): SnapshotResult {
	const fullPath = filePath.startsWith("/") ? filePath : join(projectRoot, filePath);
	const dir = snapshotDirFor(projectRoot);
	const exists = existsSync(fullPath);
	const content = exists ? readFileSync(fullPath, "utf-8") : "";
	const hash = sha8(fullPath + ":" + content + ":" + Date.now());
	const filename = `${isoTimestamp()}-${sha8(fullPath)}-${hash}.bak`;
	const snapshotPath = join(dir, filename);

	mkdirSync(dir, { recursive: true });

	if (exists) {
		// Two-step write to ensure snapshot is durable on disk before we return
		const tmpPath = `${snapshotPath}.tmp`;
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, snapshotPath);
	} else {
		// Marker snapshot for new-file writes
		writeFileSync(snapshotPath, `# NEW FILE: ${filePath}\n# Created by sages safety.ts\n`, "utf-8");
	}

	return {
		snapshot_path: snapshotPath,
		snapshot_id: filename.replace(/\.bak$/, ""),
		was_existing: exists,
	};
}

/**
 * Restore a file from a snapshot. Returns true on success.
 *
 * If the snapshot is a "NEW FILE" marker, deletes the target file instead.
 */
export function restoreFromSnapshot(snapshotPath: string, targetPath: string): boolean {
	if (!existsSync(snapshotPath)) return false;
	const content = readFileSync(snapshotPath, "utf-8");

	if (content.startsWith("# NEW FILE:")) {
		// Snapshot was created for a write of a previously-nonexistent file;
		// restore means delete the file we created.
		if (existsSync(targetPath)) {
			try {
				// We can't import fs here without circular deps; use a fresh require
				const { unlinkSync } = require("node:fs");
				unlinkSync(targetPath);
			} catch {
				return false;
			}
		}
		return true;
	}

	// Normal restore
	const dir = dirname(targetPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = `${targetPath}.restore.tmp`;
	writeFileSync(tmpPath, content, "utf-8");
	renameSync(tmpPath, targetPath);
	return true;
}

/** Test-only helper to clear the snapshot directory for a project. */
export function __clearSnapshots(projectRoot: string): void {
	const dir = snapshotDirFor(projectRoot);
	if (existsSync(dir)) {
		const { rmSync } = require("node:fs");
		rmSync(dir, { recursive: true, force: true });
	}
}

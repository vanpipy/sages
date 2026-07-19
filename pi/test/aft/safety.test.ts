/**
 * Tests for aft/safety.ts — snapshot creation and restoration.
 *
 * Acceptance:
 *   - snapshot creates the .bak file before returning
 *   - .sages/snapshots/ auto-created if missing
 *   - Returns stable snapshot_id per file path
 *   - Restoration: snapshot of existing file restores exact content
 *   - Restoration: marker snapshot deletes target
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { snapshot, restoreFromSnapshot } from "../../src/tools/aft/safety.js";

function touch(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

describe("aft/safety.ts", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "aft-safety-test-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("creates .sages/snapshots/ and writes a backup for an existing file", () => {
		const target = join(projectRoot, "src/example.ts");
		touch(target, "ORIGINAL CONTENT\n");

		const result = snapshot(projectRoot, target);

		expect(result.was_existing).toBe(true);
		expect(existsSync(result.snapshot_path)).toBe(true);
		expect(readFileSync(result.snapshot_path, "utf-8")).toBe("ORIGINAL CONTENT\n");
		expect(result.snapshot_id).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}-[a-f0-9]{8}$/);
	});

	test("creates a marker snapshot for a nonexistent file", () => {
		const target = join(projectRoot, "src/newfile.ts");

		const result = snapshot(projectRoot, target);

		expect(result.was_existing).toBe(false);
		expect(existsSync(result.snapshot_path)).toBe(true);
		const content = readFileSync(result.snapshot_path, "utf-8");
		expect(content.startsWith("# NEW FILE:")).toBe(true);
	});

	test("auto-creates .sages/snapshots/ if missing", () => {
		const target = join(projectRoot, "src/auto.ts");
		touch(target, "x");

		expect(existsSync(join(projectRoot, ".sages/snapshots"))).toBe(false);

		snapshot(projectRoot, target);

		expect(existsSync(join(projectRoot, ".sages/snapshots"))).toBe(true);
	});

	test("restoreFromSnapshot restores exact content", () => {
		const target = join(projectRoot, "src/restore.ts");
		touch(target, "ORIGINAL");

		const snap = snapshot(projectRoot, target);
		touch(target, "MODIFIED");

		const ok = restoreFromSnapshot(snap.snapshot_path, target);
		expect(ok).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe("ORIGINAL");
	});

	test("restoreFromSnapshot of marker deletes the target", () => {
		const target = join(projectRoot, "src/newfile.ts");
		touch(target, "fresh content");

		const snap = snapshot(projectRoot, target);
		// Manually rewrite the snapshot as a marker so restore deletes
		writeFileSync(snap.snapshot_path, "# NEW FILE: tests\n", "utf-8");
		touch(target, "now exists");

		const ok = restoreFromSnapshot(snap.snapshot_path, target);
		expect(ok).toBe(true);
		expect(existsSync(target)).toBe(false);
	});
});

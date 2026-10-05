/**
 * state-persistence.test.ts — GC-2026-097 P3 regression tests.
 *
 * After the audit, the existing atomic write had two TOCTOU windows:
 *   1. The `lstatSync(target).isFile()` check (state-persistence.ts:132)
 *      runs BEFORE the lock-then-rename, and `isFile()` is true for a
 *      symlink-to-regular-file (lstat returns the link metadata, so a
 *      plain symlink IS a "link", not a "file"). Wait — actually a
 *      bare symlink IS "not a file" under lstat, so the existing check
 *      DOES catch it. But there's a window between the check (line 132)
 *      and the rename (line 140) where an attacker could plant a
 *      symlink pointing outside .pi/orchestrator/. The rename would
 *      then write through the symlink to a sensitive location.
 *   2. The directory walk in resolveContainedPath (mkdirSync loop) runs
 *      BEFORE acquireLock. An attacker could swap a directory component
 *      for a symlink between mkdir and lock acquisition.
 *
 * P3 fix: re-run lstatSync(target).isSymbolicLink() INSIDE the lock,
 * immediately before renameSync. Throw on hit.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteOrchestratorFile } from "../src/state-persistence.js";

const VALIDATOR = (v: unknown): v is { id: string; title: string } =>
	typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";

const VALID_GOAL = "id: GC-2026-097-p3-test\ntitle: 'p3 symlink swap regression'\n";

describe("state-persistence TOCTOU window (GC-2026-097 P3)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "sages-state-persistence-p3-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("P3-1: writing through a pre-planted symlink target throws", () => {
		// Pre-plant a symlink at the target path pointing outside .pi/orchestrator/.
		// After the lock is acquired, re-check lstat and reject.
		const targetDir = join(cwd, ".pi", "orchestrator");
		// First write creates the directory.
		atomicWriteOrchestratorFile(cwd, "goal-GC-T1.yaml", VALID_GOAL, {
			owner: "orchestrator",
			validate: VALIDATOR,
		});
		// Replace the file with a symlink to /tmp/pwn.
		const target = join(targetDir, "goal-GC-T1.yaml");
		rmSync(target);
		symlinkSync("/tmp/pwn-should-not-receive-write", target);

		expect(() =>
			atomicWriteOrchestratorFile(cwd, "goal-GC-T1.yaml", VALID_GOAL, {
				owner: "orchestrator",
				validate: VALIDATOR,
			}),
		).toThrow(/symlink|Symlink state target rejected/i);
	});

	it("P3-2: writing a brand-new file in a non-symlink directory still succeeds", () => {
		// Sanity: the new check must not break the common case.
		const result = atomicWriteOrchestratorFile(
			cwd,
			"goal-GC-T2.yaml",
			VALID_GOAL,
			{ owner: "orchestrator", validate: VALIDATOR },
		);
		expect(existsSync(result)).toBe(true);
	});

	it("P3-3: writing through a parent-directory symlink (e.g. handoff/) throws", () => {
		// Simulate an attacker planting a symlink at the handoff/ parent
		// directory. The pre-lock walk would have created it as a normal
		// dir, but if the attacker swaps it for a symlink between the
		// walk and the lock, the lock-internal re-check catches it.
		const targetDir = join(cwd, ".pi", "orchestrator");
		atomicWriteOrchestratorFile(cwd, "goal-GC-T3.yaml", VALID_GOAL, {
			owner: "orchestrator",
			validate: VALIDATOR,
		});
		const handoff = join(targetDir, "handoff");
		// Create the handoff/ dir first by writing a dummy handoff file
		// (pattern requires <task_id>-handoff.md basename).
		atomicWriteOrchestratorFile(cwd, "handoff/foo-task/foo-task-handoff.md", "noop", {
			owner: "developer",
			validate: (v): v is { id: string } => true,
		});
		// Now swap handoff/ for a symlink pointing outside.
		rmSync(handoff, { recursive: true, force: true });
		symlinkSync("/tmp/pwn-via-handoff-symlink", handoff);

		expect(() =>
			atomicWriteOrchestratorFile(cwd, "handoff/bar-task/bar-task-handoff.md", "noop", {
				owner: "developer",
				validate: (v): v is { id: string } => true,
			}),
		).toThrow(/symlink|Symlink/i);
	});
});

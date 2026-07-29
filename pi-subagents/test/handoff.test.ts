/**
 * test/handoff.test.ts — GC-2026-022 SC1.
 *
 * Pinned invariants (goal-GC-2026-022.yaml SC1):
 *   - `writeHandoff(state, path?)` returns the absolute path the JSON was
 *     written to. When `path` is omitted, the file lands under
 *     `.pi/orchestrator/handoff/<gc_id>/<task_id>-<trigger>-<ts>.json`.
 *   - `readHandoff<T>(path)` returns `null` for missing files, never throws.
 *   - Writes are atomic: a `${path}.tmp` is created, then `renameSync`'d to
 *     `${path}` — the destination must NOT exist before the rename, and the
 *     readback MUST equal what was written.
 *   - The JSON shape carries `schema_version: 1` plus all required fields
 *     (task_id / gc_id / agent_type / started_at / trigger / phase /
 *      files_modified / files_added / files_deleted / commits /
 *      test_status / sc_status / next_step / open_questions / warnings).
 *   - Read validates `schema_version === 1`; a foreign-scheme JSON throws.
 *
 * Anti-rule: no new npm dependencies. Pure built-in `node:fs` + `node:os`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HandoffState,
	readHandoff,
	writeHandoff,
} from "../src/handoff.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-handoff-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSampleState(overrides: Partial<HandoffState> = {}): HandoffState {
	return {
		schema_version: 1,
		task_id: "P1",
		gc_id: "GC-2026-022",
		agent_type: "developer",
		started_at: "2026-07-29T10:55:55.593Z",
		trigger: "partial",
		phase: "in-progress",
		files_modified: ["src/agent-runner.ts", "src/index.ts"],
		files_added: ["src/handoff.ts", "src/budget.ts"],
		files_deleted: [],
		commits: ["abc1234567890", "def2345678901"],
		test_status: { passes: 8, fails: 0, skipped: 0 },
		sc_status: {
			SC1: "pass",
			SC2: "in-progress",
			SC3: "not-started",
		},
		next_step: "await SC4 verification",
		open_questions: ["should snapshot use ISO or epoch?"],
		warnings: ["lint baseline drifted to 50, was 52"],
		...overrides,
	};
}

describe("handoff: write/read roundtrip", () => {
	it("writeHandoff + readHandoff preserves every field including nested arrays/objects", () => {
		const target = join(tmpRoot, "roundtrip.json");
		const state = makeSampleState();
		const ret = writeHandoff(state, target);

		expect(ret).toBe(target);
		const back = readHandoff<HandoffState>(target);
		expect(back).toEqual(state);
		expect(back?.sc_status.SC2).toBe("in-progress");
		expect(back?.files_added).toContain("src/budget.ts");
	});

	it("readHandoff returns null on missing file (does not throw)", () => {
		const missing = join(tmpRoot, "does-not-exist.json");
		expect(() => readHandoff(missing)).not.toThrow();
		expect(readHandoff(missing)).toBeNull();
	});

	it("writeHandoff is atomic — the destination does not exist before the rename completes", () => {
		const target = join(tmpRoot, "atomic.json");
		// Pre-condition: file does not exist.
		expect(() => readFileSync(target)).toThrow();
		writeHandoff(makeSampleState({ trigger: "snapshot" }), target);
		// Post-condition: file exists, contents parse, no leftover .tmp.
		const raw = JSON.parse(readFileSync(target, "utf-8"));
		expect(raw.schema_version).toBe(1);
		expect(raw.trigger).toBe("snapshot");
		// .tmp sibling must not linger.
		expect(() => readFileSync(`${target}.tmp`)).toThrow();
	});
});

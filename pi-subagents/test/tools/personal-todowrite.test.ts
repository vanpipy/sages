/**
 * Tests for pi-subagents/src/tools/personal-todowrite.ts (storage layer).
 *
 * GC-2026-coupon-nonhit-block follow-up (Path A): per-subagent personal
 * todowrite storage, keyed by cwd. Storage is at
 * `~/.cache/pi-subagents-todos/<cwd-hash>.json`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	loadTodos,
	saveTodos,
	setTodos,
	summarize,
	type PersonalTodoInput,
} from "../../src/tools/personal-todowrite.js";

let cwd: string;
let homeBackup: string | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-personal-todo-"));
	// Redirect HOME to a temp dir so the storage layer writes into a sandbox
	// and we can clean up between tests.
	homeBackup = process.env.HOME;
	process.env.HOME = cwd;
});

afterEach(() => {
	if (homeBackup !== undefined) process.env.HOME = homeBackup;
	else delete process.env.HOME;
	rmSync(cwd, { recursive: true, force: true });
});

function inputItems(): PersonalTodoInput[] {
	return [
		{ content: "Read AGENTS.md", status: "completed" },
		{ content: "Discover codebase patterns", status: "in_progress" },
		{ content: "Write RED test", status: "pending" },
		{ content: "Write GREEN impl" },
	];
}

describe("personal-todowrite storage", () => {
	describe("loadTodos", () => {
		it("returns [] for a never-used cwd", () => {
			const items = loadTodos(cwd);
			expect(items).toEqual([]);
		});

		it("tolerates corrupted JSON (returns [])", () => {
			// Manually write garbage to the resolved file
			saveTodos(cwd, inputItems() as never); // ensure dir exists
			const hashPath = (() => {
				const { createHash } = require("node:crypto") as typeof import("node:crypto");
				const h = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
				return join(require("node:os").homedir(), ".cache", "pi-subagents-todos", `${h}.json`);
			})();
			require("node:fs").writeFileSync(hashPath, "{not valid json", "utf-8");
			const items = loadTodos(cwd);
			expect(items).toEqual([]);
		});

		it("filters out items missing required fields", () => {
			const items = [
				{ id: "ok", content: "ok", status: "pending", created_at: "", updated_at: "" },
				{ id: "no-content", status: "pending" }, // missing content
				{ id: "no-status", content: "x" }, // missing status
			] as never;
			saveTodos(cwd, items);
			const back = loadTodos(cwd);
			expect(back.map((i) => i.id)).toEqual(["ok"]);
		});
	});

	describe("setTodos", () => {
		it("replaces the list and assigns server-side ids to new items", () => {
			const back = setTodos(cwd, inputItems());
			expect(back).toHaveLength(4);
			expect(back.map((i) => i.id)).toEqual(["todo-1", "todo-2", "todo-3", "todo-4"]);
			expect(back.map((i) => i.content)).toEqual([
				"Read AGENTS.md",
				"Discover codebase patterns",
				"Write RED test",
				"Write GREEN impl",
			]);
			// New items default to 'pending' if status omitted
			expect(back[3].status).toBe("pending");
		});

		it("preserves prior status when an item with the same id has no status in the new list", () => {
			setTodos(cwd, [
				{ id: "t1", content: "foo", status: "in_progress" },
			]);
			const back = setTodos(cwd, [
				{ id: "t1", content: "foo" }, // no status — should retain
			]);
			expect(back[0].status).toBe("in_progress");
		});

		it("accepts an explicit override on a re-set", () => {
			setTodos(cwd, [{ id: "t1", content: "foo", status: "in_progress" }]);
			const back = setTodos(cwd, [
				{ id: "t1", content: "foo", status: "completed" },
			]);
			expect(back[0].status).toBe("completed");
		});

		it("clears the list when items is []", () => {
			setTodos(cwd, inputItems());
			setTodos(cwd, []);
			expect(loadTodos(cwd)).toEqual([]);
		});

		it("persists across save/load", () => {
			setTodos(cwd, inputItems());
			// Compute the same hash the storage layer uses
			const { createHash } = require("node:crypto") as typeof import("node:crypto");
			const h = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
			const onDiskPath = join(
				require("node:os").homedir(),
				".cache",
				"pi-subagents-todos",
				`${h}.json`,
			);
			expect(existsSync(onDiskPath)).toBe(true);
			const raw = JSON.parse(readFileSync(onDiskPath, "utf-8"));
			expect(raw).toHaveLength(4);
		});
	});

	describe("summarize", () => {
		it("counts items by status and identifies the in-progress id", () => {
			setTodos(cwd, [
				{ content: "a", status: "completed" },
				{ content: "b", status: "completed" },
				{ content: "c", status: "in_progress" },
				{ content: "d", status: "pending" },
				{ content: "e", status: "failed" },
			]);
			const s = summarize(cwd);
			expect(s.total).toBe(5);
			expect(s.byStatus).toEqual({
				completed: 2,
				failed: 1,
				in_progress: 1,
				pending: 1,
				skipped: 0,
			});
			expect(s.inProgressId).toBe("todo-3");
		});

		it("returns inProgressId=null when nothing is in progress", () => {
			setTodos(cwd, [
				{ content: "a", status: "pending" },
				{ content: "b", status: "completed" },
			]);
			const s = summarize(cwd);
			expect(s.inProgressId).toBeNull();
		});
	});

	describe("isolation", () => {
		it("two different cwds have independent lists", () => {
			const cwdA = cwd;
			const cwdB = mkdtempSync(join(tmpdir(), "pi-personal-todo-B-"));
			try {
				setTodos(cwdA, [{ content: "A1", status: "pending" }]);
				setTodos(cwdB, [
					{ content: "B1", status: "completed" },
					{ content: "B2", status: "in_progress" },
				]);
				expect(loadTodos(cwdA)).toHaveLength(1);
				expect(loadTodos(cwdB)).toHaveLength(2);
				// Setting A again does not touch B
				setTodos(cwdA, []);
				expect(loadTodos(cwdA)).toEqual([]);
				expect(loadTodos(cwdB)).toHaveLength(2);
			} finally {
				rmSync(cwdB, { recursive: true, force: true });
			}
		});
	});
});

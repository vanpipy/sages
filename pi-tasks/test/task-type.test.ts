/**
 * task-type.test.ts — Unit tests for the Task.type field (first-class
 * intent/plan type).
 *
 * The type lives on the Task interface as a required `type: TaskType`
 * field (`"intent" | "plan"`). Missing type defaults to `"plan"` at
 * deserialization for backward compatibility with legacy on-disk files
 * written before the type distinction existed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";
import type { TaskType } from "../src/types.js";

describe("TaskType", () => {
	it("is the union 'intent' | 'plan'", () => {
		// Compile-time: the type itself accepts only those two literals.
		const intent: TaskType = "intent";
		const plan: TaskType = "plan";
		expect(intent).toBe("intent");
		expect(plan).toBe("plan");
	});
});

describe("Task.type defaults", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-tasks-type-"));
		mkdirSync(scratch, { recursive: true });
	});

	void rmSync;

	it("store.create returns a task with type='plan' by default", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create("plan task", "...");
		expect(t.type).toBe("plan");
	});

	it("store.create with type='intent' marks the task as an intent", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create("intent task", "...", undefined, undefined, "intent");
		expect(t.type).toBe("intent");
	});

	it("a task created with type='plan' explicitly has type='plan'", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create("explicit plan", "...", undefined, undefined, "plan");
		expect(t.type).toBe("plan");
	});
});

describe("normalizeTask (missing type, legacy on-disk)", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-tasks-legacy-type-"));
		mkdirSync(scratch, { recursive: true });
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("a legacy task file with no `type` field round-trips to type='plan'", () => {
		const filePath = join(scratch, "tasks.json");
		// Legacy on-disk file — pre-Type-distinction, no `type` field anywhere.
		writeFileSync(filePath, JSON.stringify({
			nextId: 2,
			tasks: [{
				id: "1",
				subject: "Legacy task",
				description: "From an older version",
				status: "pending",
				metadata: {},
				blocks: [],
				blockedBy: [],
				createdAt: 1,
				updatedAt: 1,
			}],
		}));

		const store = new TaskStore(filePath);
		const task = store.get("1")!;
		expect(task.type).toBe("plan");
	});

	it("a legacy task file with `type` missing in metadata round-trips to type='plan'", () => {
		const filePath = join(scratch, "tasks.json");
		// Even more degraded — no metadata, no type, just the bare task shape.
		writeFileSync(filePath, JSON.stringify({
			nextId: 1,
			tasks: [{
				id: "1",
				subject: "Bare legacy",
				description: "...",
				status: "pending",
			}],
		}));

		const store = new TaskStore(filePath);
		const task = store.get("1")!;
		expect(task.type).toBe("plan");
	});

	it("a task file with type='intent' round-trips intact", () => {
		const filePath = join(scratch, "tasks.json");
		writeFileSync(filePath, JSON.stringify({
			nextId: 1,
			tasks: [{
				id: "1",
				type: "intent",
				subject: "User-facing intent",
				description: "...",
				status: "pending",
				metadata: {},
				blocks: [],
				blockedBy: [],
				createdAt: 1,
				updatedAt: 1,
			}],
		}));

		const store = new TaskStore(filePath);
		const task = store.get("1")!;
		expect(task.type).toBe("intent");
	});

	it("a re-saved task preserves its type field on disk", () => {
		const filePath = join(scratch, "tasks.json");
		const store = new TaskStore(filePath);
		const t = store.create("Intent", "...", undefined, undefined, "intent");
		// Re-load from a fresh store and verify the type round-trips.
		const reloaded = new TaskStore(filePath).get(t.id)!;
		expect(reloaded.type).toBe("intent");
	});
});

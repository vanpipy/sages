/**
 * task-kind.test.ts — Unit tests for the intent/plan type system.
 *
 * The kind lives in `metadata.kind`. Missing kind defaults to "plan"
 * for backward compat with tasks created before the kind distinction
 * existed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TASK_KIND,
	TASK_KINDS,
	isIntentKind,
	isIntentTask,
	isPlanKind,
	isPlanTask,
	taskKindOf,
} from "../src/task-kind.js";
import { TaskStore } from "../src/task-store.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TaskKind constants", () => {
	it("TASK_KINDS lists both kinds", () => {
		expect(TASK_KINDS).toEqual(["intent", "plan"]);
	});

	it("DEFAULT_TASK_KIND is 'plan'", () => {
		expect(DEFAULT_TASK_KIND).toBe("plan");
	});
});

describe("isPlanKind / isIntentKind", () => {
	it("isPlanKind returns true for 'plan'", () => {
		expect(isPlanKind("plan")).toBe(true);
	});

	it("isPlanKind returns true for undefined (backward compat)", () => {
		expect(isPlanKind(undefined)).toBe(true);
	});

	it("isPlanKind returns false for 'intent'", () => {
		expect(isPlanKind("intent")).toBe(false);
	});

	it("isIntentKind returns true only for 'intent'", () => {
		expect(isIntentKind("intent")).toBe(true);
		expect(isIntentKind("plan")).toBe(false);
		expect(isIntentKind(undefined)).toBe(false);
	});
});

describe("taskKindOf", () => {
	it("returns 'plan' for legacy tasks (no kind)", () => {
		expect(taskKindOf({ metadata: {} } as never)).toBe("plan");
	});

	it("returns 'intent' for intent tasks", () => {
		expect(taskKindOf({ metadata: { kind: "intent" } } as never)).toBe("intent");
	});

	it("returns 'plan' for plan tasks", () => {
		expect(taskKindOf({ metadata: { kind: "plan" } } as never)).toBe("plan");
	});
});

describe("isPlanTask / isIntentTask against a real TaskStore", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-tasks-kind-"));
		mkdirSync(scratch, { recursive: true });
	});

	// Clean up scratch dirs at the end of each test — bun/vitest runs
	// in a single process so explicit cleanup isn't required for
	// correctness, just tidiness.
	void rmSync;

	it("isPlanTask recognises kind=plan; isIntentTask rejects it", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create("plan task", "...");

		store.update(t.id, { metadata: { kind: "plan" } });
		const updated = store.get(t.id)!;
		expect(isPlanTask(updated)).toBe(true);
		expect(isIntentTask(updated)).toBe(false);
	});

	it("isIntentTask recognises kind=intent; isPlanTask rejects it", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create("intent task", "...");

		store.update(t.id, { metadata: { kind: "intent" } });
		const updated = store.get(t.id)!;
		expect(isIntentTask(updated)).toBe(true);
		expect(isPlanTask(updated)).toBe(false);
	});

	it("legacy tasks (no kind) are plan tasks (backward compat)", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create("legacy task", "...");

		// No metadata.kind set.
		const fresh = store.get(t.id)!;
		expect(isPlanTask(fresh)).toBe(true);
		expect(isIntentTask(fresh)).toBe(false);
	});
});
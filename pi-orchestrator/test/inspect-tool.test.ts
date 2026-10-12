/**
 * inspect-tool.test.ts — Unit tests for the task_inspect orchestrator tool.
 *
 * `task_inspect(task_id)` is the LLM's first call on every task. It
 * returns the routing-relevant fields (kind, status, agentType,
 * hasResult) so the LLM can pick the right follow-up tool:
 *
 *   - kind='intent'                       → task_convert_intent
 *   - kind='plan' + status='pending'      → TaskExecute
 *   - kind='plan' + status='in_progress'  → TaskOutput(block=true)
 *   - kind='plan' + status='completed'    → task_consume
 *
 * Lighter than TaskGet (returns the full raw task); this returns only
 * the routing-relevant fields.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";
import { taskInspect, TaskInspectError } from "../src/orchestrator-tool.js";

describe("task_inspect", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-inspect-"));
	});

	it("returns the routing-relevant fields for a completed plan task", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const t = store.create("Implement", "...", undefined, {
			kind: "plan",
			agentType: "Developer",
		});
		store.update(t.id, {
			status: "completed",
			metadata: { result: "Done" },
		});

		const out = await taskInspect(
			"call-1",
			{ task_id: t.id },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		expect(out.details?.id).toBe(t.id);
		expect(out.details?.subject).toBe("Implement");
		expect(out.details?.kind).toBe("plan");
		expect(out.details?.status).toBe("completed");
		expect(out.details?.agentType).toBe("Developer");
		expect(out.details?.hasResult).toBe(true);
	});

	it("returns kind='intent' for an intent task (no agentType)", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const t = store.create("Add /login", "User asked via /tasks", undefined, {
			kind: "intent",
		});

		const out = await taskInspect(
			"call-1",
			{ task_id: t.id },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		expect(out.details?.kind).toBe("intent");
		expect(out.details?.agentType).toBeUndefined();
		expect(out.details?.hasResult).toBe(false);
	});

	it("defaults missing kind to 'plan' (backward compat with legacy tasks)", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const t = store.create("Legacy", "...");

		const out = await taskInspect(
			"call-1",
			{ task_id: t.id },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		expect(out.details?.kind).toBe("plan");
	});

	it("throws TaskInspectError('not_found') for an unknown task id", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));

		try {
			await taskInspect(
				"call-1",
				{ task_id: "999" },
				undefined,
				undefined,
				{ cwd: scratch },
			);
			expect.unreachable("taskInspect should have thrown on an unknown task id");
		} catch (err) {
			expect(err).toBeInstanceOf(TaskInspectError);
			expect((err as TaskInspectError).kind).toBe("not_found");
		}
	});

	it("returns hasResult=false while the plan task is still pending", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const t = store.create(
			"Implement",
			"...",
			undefined,
			{ kind: "plan", agentType: "Developer" },
		);

		const out = await taskInspect(
			"call-1",
			{ task_id: t.id },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		expect(out.details?.kind).toBe("plan");
		expect(out.details?.status).toBe("pending");
		expect(out.details?.hasResult).toBe(false);
	});
});
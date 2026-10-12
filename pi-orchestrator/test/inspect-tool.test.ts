/**
 * inspect-tool.test.ts — Unit tests for the task_inspect orchestrator tool.
 *
 * `task_inspect(task_id)` is the LLM's first call on every task. It
 * returns the routing-relevant fields (type, status, agentType,
 * hasResult) so the LLM can pick the right follow-up tool:
 *
 *   - type='intent'                       → task_convert_intent
 *   - type='plan' + status='pending'      → TaskExecute
 *   - type='plan' + status='in_progress'  → TaskOutput(block=true)
 *   - type='plan' + status='completed'    → task_consume
 *
 * Lighter than TaskGet (returns the full raw task); this returns only
 * the routing-relevant fields.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
		const t = store.create(
			"Implement",
			"...",
			undefined,
			{ agentType: "Developer" },
			"plan",
		);
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
		expect(out.details?.type).toBe("plan");
		expect(out.details?.status).toBe("completed");
		expect(out.details?.agentType).toBe("Developer");
		expect(out.details?.hasResult).toBe(true);
	});

	it("returns type='intent' for an intent task (no agentType)", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const t = store.create(
			"Add /login",
			"User asked via /tasks",
			undefined,
			undefined,
			"intent",
		);

		const out = await taskInspect(
			"call-1",
			{ task_id: t.id },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		expect(out.details?.type).toBe("intent");
		expect(out.details?.agentType).toBeUndefined();
		expect(out.details?.hasResult).toBe(false);
	});

	it("defaults missing type to 'plan' (backward compat with legacy tasks)", async () => {
		// Legacy task file: no `type` field anywhere on the Task. The
		// loader normalizes missing type to "plan"; taskInspect must
		// surface that as type='plan' (not throw on undefined).
		const legacyFile = orchestratorProjectTaskFile(scratch);
		mkdirSync(dirname(legacyFile), { recursive: true });
		writeFileSync(
			legacyFile,
			JSON.stringify({
				nextId: 2,
				tasks: [
					{
						id: "1",
						subject: "Legacy",
						description: "...",
						status: "pending",
						metadata: {},
						blocks: [],
						blockedBy: [],
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		);
		const store = new TaskStore(legacyFile);

		const out = await taskInspect(
			"call-1",
			{ task_id: "1" },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		expect(out.details?.type).toBe("plan");
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
			{ agentType: "Developer" },
			"plan",
		);

		const out = await taskInspect(
			"call-1",
			{ task_id: t.id },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		expect(out.details?.type).toBe("plan");
		expect(out.details?.status).toBe("pending");
		expect(out.details?.hasResult).toBe(false);
	});
});
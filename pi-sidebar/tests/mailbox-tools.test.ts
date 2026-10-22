/**
 * mailbox-tools.test.ts — the five LLM-facing mailbox tools.
 *
 * These replace the 13 task tools the main agent uses today, so they
 * carry the whole intake path: claim an intent, break it down, track
 * each step, close it. Every test drives `registerMailboxTools` against
 * a fake `pi` (same shape as the one in `sidebar.test.ts`) and a real
 * `MailboxStore` over a temp directory, so the lock discipline and the
 * read-modify-write path are exercised for real.
 *
 * The precondition rules are the point of the file: a breakdown on an
 * unclaimed intent, a completion with an open child, and a losing claim
 * race must all refuse WITHOUT touching the store.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxStore } from "../extensions/sidebar/mailbox/store.js";
import { registerMailboxTools } from "../extensions/sidebar/mailbox/tools.js";
import { parseTasksJson } from "../extensions/sidebar/tasks.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CapturedTool = {
	name: string;
	label?: string;
	description?: string;
	parameters?: Record<string, unknown>;
	execute?: (
		toolCallId: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

/**
 * Fake `pi` that captures every registered tool by name. The real
 * `registerTool` type-checks the full `ToolDefinition`; this stub only
 * needs the two members the registrar touches.
 */
function makeFakePi() {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-sidebar-mailbox-tools-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

function setup(sessionId = "sess-abc") {
	const store = new MailboxStore(path.join(tmpRoot, "mailbox", "tasks.json"));
	const fake = makeFakePi();
	registerMailboxTools(fake.pi, store, { getSessionId: () => sessionId });
	const call = async (name: string, params: unknown) => {
		const tool = fake.tools.get(name);
		if (!tool?.execute) throw new Error(`tool ${name} not registered`);
		return tool.execute("call-1", params, undefined, undefined, {});
	};
	return { store, fake, call, sessionId };
}

interface SeedTask {
	id: string;
	type?: "intent" | "plan";
	subject?: string;
	status?: "pending" | "in_progress" | "completed";
	owner?: string;
	sourceIntent?: string;
	createdAt?: number;
	blockedBy?: string[];
	blocks?: string[];
}

function seedTasks(store: MailboxStore, tasks: SeedTask[]): void {
	store.mutate((current) => ({
		ok: true,
		tasks: [
			...current,
			...tasks.map((t) => ({
				id: t.id,
				type: t.type ?? "plan",
				subject: t.subject ?? `subject ${t.id}`,
				description: "",
				status: t.status ?? "pending",
				...(t.owner ? { owner: t.owner } : {}),
				metadata: t.sourceIntent ? { sourceIntent: t.sourceIntent } : {},
				blocks: t.blocks ?? [],
				blockedBy: t.blockedBy ?? [],
				createdAt: t.createdAt ?? 0,
				updatedAt: 0,
			})),
		],
		value: 1,
	}));
}

describe("mailbox tool registration", () => {
	it("registers exactly the five documented tools", () => {
		const { fake } = setup();
		expect([...fake.tools.keys()].sort()).toEqual([
			"mailbox_breakdown",
			"mailbox_claim",
			"mailbox_complete",
			"mailbox_list",
			"mailbox_update",
		]);
	});

	it("gives every tool a label, a description, and a TypeBox schema", () => {
		const { fake } = setup();
		for (const [name, tool] of fake.tools) {
			expect(typeof tool.description, name).toBe("string");
			expect((tool.description ?? "").length, name).toBeGreaterThan(20);
			expect(typeof tool.label, name).toBe("string");
			expect(tool.parameters, name).toMatchObject({ type: "object" });
			expect(typeof tool.execute, name).toBe("function");
		}
	});

	it("exposes the documented parameters per tool", () => {
		const { fake } = setup();
		const props = (name: string) =>
			Object.keys(
				(fake.tools.get(name)?.parameters as { properties?: object })?.properties ?? {},
			);
		expect(props("mailbox_list")).toEqual(
			expect.arrayContaining(["type", "unclaimed", "limit"]),
		);
		expect(props("mailbox_claim")).toEqual(["id"]);
		expect(props("mailbox_breakdown")).toEqual(["intentId", "tasks"]);
		expect(props("mailbox_update")).toEqual(["taskId", "status", "result"]);
		expect(props("mailbox_complete")).toEqual(["intentId", "summary"]);
	});
});

describe("mailbox_list", () => {
	it("lists unclaimed intents before plan tasks", async () => {
		const { store, call } = setup();
		seedTasks(store, [
			{ id: "m-1", type: "intent", createdAt: 10 },
			{ id: "1", createdAt: 1 },
			{ id: "m-2", type: "intent", owner: "sess-x", status: "in_progress" },
		]);
		const res = await call("mailbox_list", {});
		const text = res.content[0].text;
		expect(text.indexOf("m-1")).toBeLessThan(text.indexOf("subject 1"));
		expect(text).toContain("m-2");
	});

	it("filters to unclaimed intents only", async () => {
		const { store, call } = setup();
		seedTasks(store, [
			{ id: "m-1", type: "intent" },
			{ id: "m-2", type: "intent", owner: "sess-x", status: "in_progress" },
		]);
		const res = await call("mailbox_list", { unclaimed: true });
		expect(res.content[0].text).toContain("m-1");
		expect(res.content[0].text).not.toContain("m-2");
	});

	it("honors the limit", async () => {
		const { store, call } = setup();
		seedTasks(store, [
			{ id: "m-1", type: "intent", createdAt: 1 },
			{ id: "m-2", type: "intent", createdAt: 2 },
			{ id: "m-3", type: "intent", createdAt: 3 },
		]);
		const res = await call("mailbox_list", { limit: 2 });
		expect(res.content[0].text).not.toContain("m-3");
	});

	it("never mutates the store", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "m-1", type: "intent" }]);
		const before = readFileSync(store.path, "utf8");
		await call("mailbox_list", {});
		expect(readFileSync(store.path, "utf8")).toBe(before);
	});

	it("returns an empty-but-valid envelope on a missing store", async () => {
		const { call } = setup();
		const res = await call("mailbox_list", {});
		expect(res.content[0].type).toBe("text");
		expect(res.content[0].text).toContain("0");
	});
});

describe("mailbox_claim", () => {
	it("claims a pending intent for the calling session", async () => {
		const { store, call, sessionId } = setup();
		seedTasks(store, [{ id: "m-1", type: "intent" }]);
		const res = await call("mailbox_claim", { id: "m-1" });
		expect(res.content[0].text).toContain("m-1");
		const task = store.read().find((t) => t.id === "m-1")!;
		expect(task.status).toBe("in_progress");
		expect(task.owner).toBe(sessionId);
	});

	it("refuses an already-claimed intent and leaves the store alone (acceptance 5)", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "m-1", type: "intent", owner: "sess-other", status: "in_progress" }]);
		const before = readFileSync(store.path, "utf8");
		const res = await call("mailbox_claim", { id: "m-1" });
		expect(res.content[0].text).toContain("already claimed by sess-other");
		expect((res.details as { ok: boolean }).ok).toBe(false);
		expect(readFileSync(store.path, "utf8")).toBe(before);
	});

	it("refuses an unknown id", async () => {
		const { call } = setup();
		const res = await call("mailbox_claim", { id: "nope" });
		expect(res.content[0].text).toContain("nope");
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});

	it("refuses to claim a plan task", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "1" }]);
		const res = await call("mailbox_claim", { id: "1" });
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});

	it("refuses a completed intent", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "m-1", type: "intent", status: "completed" }]);
		const res = await call("mailbox_claim", { id: "m-1" });
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});
});

describe("mailbox_breakdown", () => {
	it("writes plan tasks linked by metadata.sourceIntent and marks the intent in progress", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "m-1", type: "intent", owner: "sess-abc", status: "in_progress" }]);
		const res = await call("mailbox_breakdown", {
			intentId: "m-1",
			tasks: [
				{ subject: "Write the failing test", description: "RED" },
				{
					subject: "Make it pass",
					description: "GREEN",
					blockedByIndex: [0],
					blocksIndex: [0],
				},
			],
		});
		expect((res.details as { ok: boolean }).ok).toBe(true);

		const tasks = parseTasksJson(readFileSync(store.path, "utf8"))!;
		const intent = tasks.find((t) => t.id === "m-1")!;
		expect(intent.status).toBe("in_progress");

		const children = tasks.filter((t) => t.metadata.sourceIntent === "m-1");
		expect(children).toHaveLength(2);
		expect(children.every((t) => t.type === "plan")).toBe(true);
		expect(children.map((t) => t.subject)).toEqual([
			"Write the failing test",
			"Make it pass",
		]);

		const second = children[1];
		expect(second.blockedBy).toEqual([children[0].id]);
		expect(children[0].blocks).toEqual([second.id]);
	});

	it("refuses unless the intent is claimed", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "m-1", type: "intent" }]);
		const before = readFileSync(store.path, "utf8");
		const res = await call("mailbox_breakdown", {
			intentId: "m-1",
			tasks: [{ subject: "Step", description: "d" }],
		});
		expect((res.details as { ok: boolean }).ok).toBe(false);
		expect(res.content[0].text).toMatch(/claim/i);
		expect(readFileSync(store.path, "utf8")).toBe(before);
	});

	it("refuses an unknown intent", async () => {
		const { call } = setup();
		const res = await call("mailbox_breakdown", {
			intentId: "nope",
			tasks: [{ subject: "Step", description: "d" }],
		});
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});

	it("refuses an empty task list", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "m-1", type: "intent", owner: "sess-abc", status: "in_progress" }]);
		const res = await call("mailbox_breakdown", { intentId: "m-1", tasks: [] });
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});
});

describe("mailbox_update", () => {
	it("stores progress on a plan task", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "1", sourceIntent: "m-1" }]);
		const res = await call("mailbox_update", {
			taskId: "1",
			status: "in_progress",
			result: "halfway",
		});
		expect((res.details as { ok: boolean }).ok).toBe(true);
		const task = store.read().find((t) => t.id === "1")!;
		expect(task.status).toBe("in_progress");
		expect(task.metadata.result).toBe("halfway");
		// The sourceIntent linkage must survive an update, or
		// mailbox_complete's all-children-done gate silently passes.
		expect(task.metadata.sourceIntent).toBe("m-1");
	});

	it("refuses an unknown task id", async () => {
		const { call } = setup();
		const res = await call("mailbox_update", { taskId: "nope", status: "completed" });
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});

	it("refuses a status outside the three-value vocabulary", async () => {
		const { store, call } = setup();
		seedTasks(store, [{ id: "1" }]);
		const res = await call("mailbox_update", { taskId: "1", status: "cancelled" });
		expect((res.details as { ok: boolean }).ok).toBe(false);
		expect(store.read().find((t) => t.id === "1")!.status).toBe("pending");
	});
});

describe("mailbox_complete", () => {
	it("closes an intent whose children are all completed", async () => {
		const { store, call } = setup();
		seedTasks(store, [
			{ id: "m-1", type: "intent", owner: "sess-abc", status: "in_progress" },
			{ id: "1", sourceIntent: "m-1", status: "completed" },
			{ id: "2", sourceIntent: "m-1", status: "completed" },
		]);
		const res = await call("mailbox_complete", { intentId: "m-1", summary: "shipped" });
		expect((res.details as { ok: boolean }).ok).toBe(true);
		const intent = store.read().find((t) => t.id === "m-1")!;
		expect(intent.status).toBe("completed");
		expect(intent.metadata.summary).toBe("shipped");
	});

	it("refuses while any child is open (acceptance 6)", async () => {
		const { store, call } = setup();
		seedTasks(store, [
			{ id: "m-1", type: "intent", owner: "sess-abc", status: "in_progress" },
			{ id: "1", sourceIntent: "m-1", status: "completed" },
			{ id: "2", sourceIntent: "m-1", status: "pending" },
		]);
		const before = readFileSync(store.path, "utf8");
		const res = await call("mailbox_complete", { intentId: "m-1", summary: "shipped" });
		expect((res.details as { ok: boolean }).ok).toBe(false);
		expect(res.content[0].text).toContain("2");
		expect(readFileSync(store.path, "utf8")).toBe(before);
	});

	it("refuses while a child is merely in progress, not just pending", async () => {
		const { store, call } = setup();
		seedTasks(store, [
			{ id: "m-1", type: "intent", owner: "sess-abc", status: "in_progress" },
			{ id: "1", sourceIntent: "m-1", status: "in_progress" },
		]);
		const res = await call("mailbox_complete", { intentId: "m-1", summary: "x" });
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});

	it("does not count another intent's children", async () => {
		const { store, call } = setup();
		seedTasks(store, [
			{ id: "m-1", type: "intent", owner: "sess-abc", status: "in_progress" },
			{ id: "9", sourceIntent: "m-other", status: "pending" },
		]);
		const res = await call("mailbox_complete", { intentId: "m-1", summary: "x" });
		expect((res.details as { ok: boolean }).ok).toBe(true);
	});

	it("refuses an unknown intent", async () => {
		const { call } = setup();
		const res = await call("mailbox_complete", { intentId: "nope", summary: "x" });
		expect((res.details as { ok: boolean }).ok).toBe(false);
	});
});

describe("mailbox error envelopes", () => {
	it("never throws — every failure is an ok:false envelope", async () => {
		const { call } = setup();
		for (const [name, params] of [
			["mailbox_claim", { id: "nope" }],
			["mailbox_breakdown", { intentId: "nope", tasks: [{ subject: "s", description: "d" }] }],
			["mailbox_update", { taskId: "nope", status: "completed" }],
			["mailbox_complete", { intentId: "nope", summary: "x" }],
		] as const) {
			const res = await call(name, params);
			expect((res.details as { ok: boolean }).ok, name).toBe(false);
			expect(res.content[0].type, name).toBe("text");
			expect(res.content[0].text.length, name).toBeGreaterThan(0);
		}
	});
});
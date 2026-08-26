/**
 * subagent-control.test.ts — GC-2026-073.
 *
 * Verifies the 4 LLM-facing subagent control tools reach the live
 * AgentManager singleton (published by pi-subagents under the
 * Symbol.for("pi-subagents:manager") globalThis key) without leaking
 * mutable state across the tool boundary.
 *
 * Strategy: each test seeds the globalThis registry with a hand-rolled
 * fake SubagentRegistry that mimics AgentManager's surface enough for
 * the tools to exercise their return-value branches.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentRecord } from "../../../../pi-subagents/src/types.js";
import {
	executeSubagentStatus,
	executeSubagentSteer,
	executeSubagentAbort,
	executeSubagentResume,
	registerSubagentControlTools,
} from "@/subagent-control.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager") as unknown as symbol;

type GlobalWithRegistry = {
	[key: symbol]: unknown;
};

// ───────────────────────────────────────────────────────────────────────
// Fake registry — implements the shape the tools need without spinning
// up real pi or real AgentManager instances.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface SteerCall { id: string; message: string }
interface AbortCall { id: string; reason?: unknown }
interface ResumeCall { id: string; prompt: string }

function makeFakeRegistry(initialRecords: AgentRecord[]) {
	const records = new Map<string, AgentRecord>();
	for (const r of initialRecords) records.set(r.id, { ...r });

	const steerCalls: SteerCall[] = [];
	const abortCalls: AbortCall[] = [];
	const resumeCalls: ResumeCall[] = [];

	const registry = {
		waitForAll: async () => {},
		hasRunning: () => [...records.values()].some((r) => r.status === "running" || r.status === "queued"),
		spawn: () => {
			throw new Error("spawn not used in tests");
		},
		getRecord: (id: string) => records.get(id),
		steer: (id: string, message: string) => {
			const r = records.get(id);
			if (!r) return false;
			if (r.status !== "running" && r.status !== "queued") return false;
			steerCalls.push({ id, message });
			if (r.session) {
				void r.session.steer(message).catch(() => {});
				return true;
			}
			if (!r.pendingSteers) r.pendingSteers = [];
			r.pendingSteers.push(message);
			return true;
		},
		abort: (id: string, reason?: unknown) => {
			const r = records.get(id);
			if (!r) return false;
			if (r.status === "queued" || r.status === "running") {
				abortCalls.push({ id, reason });
				r.status = "stopped";
				r.error = reason !== undefined ? String(reason) : undefined;
				r.completedAt = Date.now();
				return true;
			}
			return false;
		},
		resume: async (id: string, prompt: string) => {
			resumeCalls.push({ id, prompt });
			const r = records.get(id);
			if (!r) return undefined;
			r.status = "running";
			r.startedAt = Date.now();
			r.completedAt = undefined;
			return r;
		},
		listAgents: () =>
			[...records.values()].sort((a, b) => b.startedAt - a.startedAt),
	};
	return { registry, records, steerCalls, abortCalls, resumeCalls };
}

function setRegistry(reg: unknown): void {
	(globalThis as unknown as GlobalWithRegistry)[MANAGER_KEY] = reg;
}

function clearRegistry(): void {
	delete (globalThis as unknown as GlobalWithRegistry)[MANAGER_KEY];
}

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

function fakeRecord(overrides: Partial<AgentRecord>): AgentRecord {
	return {
		id: "test-id",
		type: "developer",
		description: "test agent",
		status: "running",
		toolUses: 0,
		startedAt: 1_700_000_000_000,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		compactionCount: 0,
		...overrides,
	} as AgentRecord;
}

// ───────────────────────────────────────────────────────────────────────
// Setup / teardown
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

afterEach(() => clearRegistry());

// ───────────────────────────────────────────────────────────────────────
// subagent_status
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("subagent-control: subagent_status", () => {
	it("returns a summary array sorted by startedAt desc and excludes the live record", () => {
		const r1 = fakeRecord({ id: "a", startedAt: 100, status: "completed" });
		const r2 = fakeRecord({ id: "b", startedAt: 200, status: "running" });
		const { registry } = makeFakeRegistry([r1, r2]);
		setRegistry(registry);

		const out = executeSubagentStatus({});
		expect(out.ok).toBe(true);
		expect(out.total).toBe(2);
		expect(out.agents).toHaveLength(2);
		// Sorted desc by startedAt
		expect(out.agents[0].id).toBe("b");
		expect(out.agents[1].id).toBe("a");
		// Plain-object copy, not the live record
		expect(out.agents[0]).not.toBe(r2);
		expect(out.agents[0].status).toBe("running");
	});

	it("filters by status and type", () => {
		const r1 = fakeRecord({ id: "a", type: "developer", status: "completed" });
		const r2 = fakeRecord({ id: "b", type: "developer", status: "running" });
		const r3 = fakeRecord({ id: "c", type: "auditor", status: "running" });
		const { registry } = makeFakeRegistry([r1, r2, r3]);
		setRegistry(registry);

		const onlyDev = executeSubagentStatus({ type: "developer" });
		expect(onlyDev.agents.map((a) => a.id).sort()).toEqual(["a", "b"]);

		const onlyRunning = executeSubagentStatus({ status: "running" });
		expect(onlyRunning.agents.map((a) => a.id).sort()).toEqual(["b", "c"]);

		const combined = executeSubagentStatus({ status: "running", type: "developer" });
		expect(combined.agents.map((a) => a.id)).toEqual(["b"]);
	});

	it("includes verbose fields only when verbose=true", () => {
		const r = fakeRecord({
			id: "v",
			lifetimeUsage: { input: 1, output: 2, cacheWrite: 3 },
			toolUses: 7,
			compactionCount: 2,
		});
		const { registry } = makeFakeRegistry([r]);
		setRegistry(registry);

		const compact = executeSubagentStatus({});
		expect(compact.agents[0].lifetimeUsage).toBeUndefined();
		expect(compact.agents[0].toolUses).toBeUndefined();
		expect(compact.agents[0].compactionCount).toBeUndefined();

		const verbose = executeSubagentStatus({ verbose: true });
		expect(verbose.agents[0].lifetimeUsage).toEqual({ input: 1, output: 2, cacheWrite: 3 });
		expect(verbose.agents[0].toolUses).toBe(7);
		expect(verbose.agents[0].compactionCount).toBe(2);
	});

	it("applies limit and tracks by_status counts", () => {
		const records = Array.from({ length: 5 }, (_, i) =>
			fakeRecord({ id: `r${i}`, status: i % 2 === 0 ? "running" : "completed" }),
		);
		const { registry } = makeFakeRegistry(records);
		setRegistry(registry);

		const out = executeSubagentStatus({ limit: 2 });
		expect(out.total).toBe(5);
		expect(out.filtered).toBe(5);
		expect(out.agents).toHaveLength(2);
		expect(out.by_status.running).toBe(3);
		expect(out.by_status.completed).toBe(2);
	});
});

// ───────────────────────────────────────────────────────────────────────
// subagent_steer
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("subagent-control: subagent_steer", () => {
	it("delivers when session is ready", () => {
		const fakeSession = { steer: () => Promise.resolve() };
		const r = fakeRecord({ id: "s", session: fakeSession as never });
		const { registry, steerCalls } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = executeSubagentSteer({ agent_id: "s", message: "hello" });
		expect(out.delivered).toBe(true);
		expect(out.queued).toBe(false);
		expect(out.agent_status).toBe("running");
		expect(steerCalls).toHaveLength(1);
		expect(steerCalls[0]).toEqual({ id: "s", message: "hello" });
	});

	it("queues when session is not yet ready", () => {
		const r = fakeRecord({ id: "q", status: "queued", pendingSteers: [] });
		const { registry, steerCalls } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = executeSubagentSteer({ agent_id: "q", message: "wake up" });
		expect(out.delivered).toBe(false);
		expect(out.queued).toBe(true);
		expect(steerCalls).toHaveLength(1);
	});

	it("returns ok:false for unknown id", () => {
		const { registry } = makeFakeRegistry([]);
		setRegistry(registry);

		const out = executeSubagentSteer({ agent_id: "nope", message: "x" });
		expect(out.ok).toBe(false);
		expect(out.delivered).toBe(false);
		expect(out.agent_status).toBe("unknown");
	});
});

// ───────────────────────────────────────────────────────────────────────
// subagent_abort
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("subagent-control: subagent_abort", () => {
	it("aborts a running agent and reports the new status", () => {
		const r = fakeRecord({ id: "a", status: "running", isBackground: true });
		const { registry, abortCalls } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = executeSubagentAbort({ agent_id: "a", reason: "deadline exceeded" });
		expect(out.stopped).toBe(true);
		expect(out.final_status).toBe("stopped");
		expect(out.reason).toBe("deadline exceeded");
		expect(out.warning).toBeUndefined();
		expect(abortCalls).toHaveLength(1);
		expect(abortCalls[0]).toEqual({ id: "a", reason: "deadline exceeded" });
	});

	it("warns when aborting a foreground agent", () => {
		const r = fakeRecord({ id: "fg", status: "running", isBackground: false });
		const { registry } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = executeSubagentAbort({ agent_id: "fg" });
		expect(out.stopped).toBe(true);
		expect(out.warning).toMatch(/foreground agent/);
	});

	it("returns stopped:false for already-terminal agents", () => {
		const r = fakeRecord({ id: "done", status: "completed" });
		const { registry, abortCalls } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = executeSubagentAbort({ agent_id: "done" });
		expect(out.stopped).toBe(false);
		expect(out.final_status).toBe("completed");
		expect(out.reason).toMatch(/already in terminal state/);
		expect(abortCalls).toHaveLength(0);
	});

	it("returns stopped:false for unknown id", () => {
		const { registry } = makeFakeRegistry([]);
		setRegistry(registry);

		const out = executeSubagentAbort({ agent_id: "ghost" });
		expect(out.ok).toBe(false);
		expect(out.stopped).toBe(false);
	});
});

// ───────────────────────────────────────────────────────────────────────
// subagent_resume
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("subagent-control: subagent_resume", () => {
	it("resumes a terminal agent with a fresh prompt loop", async () => {
		const fakeSession = { steer: () => Promise.resolve() };
		const r = fakeRecord({ id: "x", status: "completed", session: fakeSession as never });
		const { registry, resumeCalls } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = await executeSubagentResume({ agent_id: "x", prompt: "continue" });
		expect(out.resumed).toBe(true);
		expect(out.status).toBe("running");
		expect(out.previous_status).toBe("completed");
		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0]).toEqual({ id: "x", prompt: "continue" });
	});

	it("refuses when the agent is currently running", async () => {
		const r = fakeRecord({ id: "x", status: "running" });
		const { registry, resumeCalls } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = await executeSubagentResume({ agent_id: "x", prompt: "go" });
		expect(out.resumed).toBe(false);
		expect(out.reason).toMatch(/still running/);
		expect(resumeCalls).toHaveLength(0);
	});

	it("refuses when the agent has no live session", async () => {
		const r = fakeRecord({ id: "x", status: "completed" });
		// No session
		const { registry } = makeFakeRegistry([r]);
		setRegistry(registry);

		const out = await executeSubagentResume({ agent_id: "x", prompt: "go" });
		expect(out.resumed).toBe(false);
		expect(out.reason).toMatch(/no live session/);
	});

	it("returns ok:false for unknown id", async () => {
		const { registry } = makeFakeRegistry([]);
		setRegistry(registry);

		const out = await executeSubagentResume({ agent_id: "ghost", prompt: "go" });
		expect(out.ok).toBe(false);
		expect(out.resumed).toBe(false);
	});
});

// ───────────────────────────────────────────────────────────────────────
// registerSubagentControlTools — smoke test (does not depend on pi)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("subagent-control: registerSubagentControlTools", () => {
	it("registers all four tools with name/label/description/parameters/execute", () => {
		const registered: { name: string; label: string }[] = [];
		const fakePi = {
			registerTool: (tool: { name: string; label: string }) => {
				registered.push({ name: tool.name, label: tool.label });
			},
		};
		registerSubagentControlTools(fakePi);
		const names = registered.map((r) => r.name);
		expect(names).toEqual(["subagent_status", "subagent_steer", "subagent_abort", "subagent_resume"]);
	});
});
/**
 * Per-type background concurrency — AgentManager.
 *
 * The Sages-wide policy (set in default-agents.ts and propagated here):
 *   - developer: 2, auditor: 2, Explore: 4, Plan: 2, merger: 1, git-expert: 1
 *   - Global ceiling: 6 (max_concurrent in settings).
 *
 * These tests pin the resolution order at spawn time:
 *   AgentConfig.maxConcurrent → settings.maxConcurrentByType[type] → global
 * and the queue behavior when a per-type cap is saturated.
 *
 * They do NOT spawn real agents — the public surface (get/set + queue mechanics)
 * is exercised with the AgentManager's internal state pre-set via reflection.
 * The real spawn-then-startAgent path is covered by the existing
 * agent-manager-unknown-type.test.ts + the integration suites.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";

describe("AgentManager per-type concurrency", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("getMaxConcurrentByType returns a by-copy snapshot", () => {
		const manager = new AgentManager();
		manager.setMaxConcurrentByType({ developer: 2, auditor: 3 });
		const snap = manager.getMaxConcurrentByType();
		expect(snap).toEqual({ developer: 2, auditor: 3 });
		// Mutating the returned snapshot must not affect internal state.
		snap.developer = 99;
		expect(manager.getMaxConcurrentByType().developer).toBe(2);
		manager.dispose();
	});

	it("setMaxConcurrentByType drops invalid entries silently", () => {
		const manager = new AgentManager();
		manager.setMaxConcurrentByType({
			developer: 2, // valid
			auditor: 0, // < 1 -> dropped
			planner: 1.5, // non-integer -> dropped
			bad: "x", // wrong type -> dropped
		} as unknown as Record<string, number>);
		expect(manager.getMaxConcurrentByType()).toEqual({ developer: 2 });
		manager.dispose();
	});

	it("setMaxConcurrentByType with undefined clears all overrides", () => {
		const manager = new AgentManager();
		manager.setMaxConcurrentByType({ developer: 2 });
		manager.setMaxConcurrentByType(undefined);
		expect(manager.getMaxConcurrentByType()).toEqual({});
		manager.dispose();
	});

	it("effectiveMaxFor prefers AgentConfig.maxConcurrent over settings", () => {
		// Hook returns 2 for developer (the AgentConfig layer); settings says 5.
		// AgentConfig wins, per the documented resolution order.
		const manager = new AgentManager(
			undefined,
			6,
			undefined,
			undefined,
			(type) => (type === "developer" ? 2 : undefined),
		);
		manager.setMaxConcurrentByType({ developer: 5 });
		expect((manager as any).effectiveMaxFor("developer")).toBe(2);
		manager.dispose();
	});

	it("effectiveMaxFor falls through settings when AgentConfig absent", () => {
		const manager = new AgentManager(
			undefined,
			6,
			undefined,
			undefined,
			() => undefined,
		);
		manager.setMaxConcurrentByType({ developer: 3 });
		expect((manager as any).effectiveMaxFor("developer")).toBe(3);
		manager.dispose();
	});

	it("effectiveMaxFor falls through to global cap when neither set", () => {
		const manager = new AgentManager(undefined, 6);
		expect((manager as any).effectiveMaxFor("any-type")).toBe(6);
		manager.dispose();
	});

	it("getRunningBackgroundByType returns current per-type counts", () => {
		const manager = new AgentManager();
		(manager as any).runningBackgroundByType.set("developer", 2);
		(manager as any).runningBackgroundByType.set("auditor", 1);
		expect(manager.getRunningBackgroundByType()).toEqual({
			developer: 2,
			auditor: 1,
		});
		manager.dispose();
	});

	it("spawn queues when per-type cap is saturated even if global has room", () => {
		// Global cap is 6 but developer cap is 2; pre-saturate developer so a
		// 3rd developer queues (without calling startAgent).
		const manager = new AgentManager(
			undefined,
			6,
			undefined,
			undefined,
			(type) => (type === "developer" ? 2 : undefined),
		);
		(manager as any).runningBackground = 2;
		(manager as any).runningBackgroundByType.set("developer", 2);

		const id = manager.spawn(
			{} as never,
			{ cwd: process.cwd() } as never,
			"developer",
			"third developer",
			{ description: "queued", isBackground: true, isolation: "current-workspace" } as never,
		);
		expect(id).toBeTruthy();
		const queued = manager
			.listAgents()
			.filter((a: any) => a.status === "queued");
		expect(queued.length).toBe(1);
		expect((manager as any).runningBackgroundByType.get("developer")).toBe(2);
		expect((manager as any).runningBackground).toBe(2);
		manager.dispose();
	});

	it("spawn queues when global cap is saturated even if per-type has room", () => {
		// Global cap = 2; developer cap is 4 (lots of room); but global is full,
		// so a 3rd of ANY type queues.
		const manager = new AgentManager(
			undefined,
			2,
			undefined,
			undefined,
			(type) => (type === "developer" ? 4 : undefined),
		);
		(manager as any).runningBackground = 2;
		(manager as any).runningBackgroundByType.set("developer", 2);

		const id = manager.spawn(
			{} as never,
			{ cwd: process.cwd() } as never,
			"developer",
			"third developer (global cap full)",
			{ description: "queued", isBackground: true, isolation: "current-workspace" } as never,
		);
		expect(id).toBeTruthy();
		expect(
			manager.listAgents().filter((a: any) => a.status === "queued").length,
		).toBe(1);
		manager.dispose();
	});

	it("bypassQueue skips the per-type check (scheduler / RPC path)", () => {
		// Pre-saturate and call spawn with bypassQueue: true. The agent is added
		// to the record map but the global/per-type check is skipped — startAgent
		// will run immediately (and may throw downstream, but bypassQueue should
		// at least let the spawn call proceed past the queue branch).
		const manager = new AgentManager(
			undefined,
			6,
			undefined,
			undefined,
			(type) => (type === "developer" ? 1 : undefined),
		);
		(manager as any).runningBackground = 1;
		(manager as any).runningBackgroundByType.set("developer", 1);

		// bypassQueue=true means the cap check is skipped entirely. startAgent
		// is then invoked; pi is {} so the downstream runAgent will fail, and
		// spawn rethrows. The point of this test is to confirm the queue
		// branch is NOT taken — the throw comes from startAgent, not from the
		// "no worktree / unmanaged" path. We assert on the absence of a
		// queued record rather than the throw.
		try {
			manager.spawn(
				{} as never,
				{ cwd: process.cwd() } as never,
				"developer",
				"bypass",
				{
					description: "bypass",
					isBackground: true,
					bypassQueue: true,
					isolation: "current-workspace",
				} as never,
			);
		} catch {
			// Expected: startAgent -> runAgent -> fail with dummy pi.
		}
		expect(
			manager.listAgents().filter((a: any) => a.status === "queued").length,
		).toBe(0);
		manager.dispose();
	});
});

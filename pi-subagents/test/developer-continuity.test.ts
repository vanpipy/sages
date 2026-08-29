/**
 * developer-continuity.test.ts — Background / steer / get_subagent_result
 * continuity for the canonical `developer` agent.
 *
 * Pins the lifecycle invariant for the canonical `developer` agent:
 *
 *   1. After spawn(), `record.managedWorktree` carries the full handoff
 *      set — path, branch, baseSha, baseRef, head, dirty, reused,
 *      leaseToken, dag_id, task_id, worktree_id, repoRoot.
 *   2. A subsequent `steer_subagent` call leaves the handoff unchanged
 *      (deep equality). Steering is a control-plane operation that
 *      must not mutate the worktree identity.
 *   3. A subsequent `get_subagent_result` returns the same record
 *      (same id, same handoff). Background queueing preserves identity.
 *   4. A subsequent `resume` carries the handoff through (the record's
 *      `managedWorktree` is preserved).
 *   5. Mode `reuse` against an existing worktree updates `reused` to
 *      `true` and the lease token is fresh; the path / branch /
 *      identity remain stable.
 *
 * The test stubs `runAgent` via `vi.mock` so the LLM child never runs;
 * we exercise the manager's spawn / steer / getRecord / resume paths
 * directly against a real git repo fixture.
 *
 * GC-2026-014: alias-metadata fields (`aliasUsed`, `requestedName`)
 * were dropped from `AgentRecord`; the canonical-name-only invariant
 * is pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub runAgent — the manager's spawn path calls runAgent after
// provisioning the managed worktree. We don't want the LLM child to
// execute; we just want to assert the spawn wiring.
vi.mock("../src/agent-runner.js", () => ({
	runAgent: vi.fn(
		async (_ctx: any, _type: any, _prompt: any, _options: any) => {
			// Drive the same completion handshake as the real runner so the
			// agent transitions through "running" → "completed" cleanly.
			return {
				responseText: "stub-result",
				session: {
					steer: async () => undefined,
					dispose: () => undefined,
					messages: [],
					subscribe: () => () => undefined,
					prompt: async () => undefined,
				},
				aborted: false,
				steered: false,
				failure: undefined,
			};
		},
	),
	resumeAgent: vi.fn(async () => ({ text: "stub-resume", failure: undefined })),
	steerAgent: vi.fn(async () => undefined),
	getAgentConversation: vi.fn(() => ""),
	SUBAGENT_TOOL_NAMES: {
		AGENT: "Agent",
		GET_RESULT: "get_subagent_result",
		STEER: "steer_subagent",
	},
	getDefaultMaxTurns: () => 30,
	setDefaultMaxTurns: () => undefined,
	getGraceTurns: () => 5,
	setGraceTurns: () => undefined,
	normalizeMaxTurns: (n?: number) => (n == null ? undefined : Math.max(0, n)),
}));

import { AgentManager } from "../src/agent-manager.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { makeRepoFixture, type RepoFixture } from "./_fixture.js";

const CANONICAL = "Developer";

describe("developer-continuity: spawn populates the handoff end-to-end", () => {
	let fx: RepoFixture | undefined;
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
		fx = makeRepoFixture("developer-continuity");
	});
	afterEach(() => {
		fx?.dispose();
		fx = undefined;
	});

	it("spawn attaches the full handoff set on `record.managedWorktree` (canonical developer)", () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			{} as any,
			{ cwd: fx!.root } as any,
			CANONICAL,
			"implement the thing",
			{
				description: "spawn under test",
				isBackground: false,
				managedWorktree: {
					dag_id: "DAG-2026-014",
					task_id: "P2",
					mode: "create",
				},
			} as any,
		);
		const record = manager.getRecord(id);
		expect(record).toBeDefined();
		expect(record!.type).toBe(CANONICAL);
		// GC-2026-014: `aliasUsed` / `requestedName` were removed from
		// `AgentRecord`. The canonical name is all that survives.
		expect((record as any).aliasUsed).toBeUndefined();
		expect((record as any).requestedName).toBeUndefined();

		const handoff = record!.managedWorktree;
		expect(handoff).toBeDefined();
		expect(handoff!.dag_id).toBe("DAG-2026-014");
		expect(handoff!.task_id).toBe("P2");
		expect(handoff!.worktree_id).toBe("P2");
		expect(handoff!.branch).toMatch(/^sages\/DAG-2026-014\/P2$/);
		expect(handoff!.baseRef).toBe("origin/main");
		expect(typeof handoff!.path).toBe("string");
		expect(handoff!.path.length).toBeGreaterThan(0);
		expect(typeof handoff!.baseSha).toBe("string");
		expect(typeof handoff!.head).toBe("string");
		expect(typeof handoff!.leaseToken).toBe("string");
		expect(handoff!.leaseToken.length).toBeGreaterThan(0);
		expect(handoff!.reused).toBe(false);
		expect(typeof handoff!.repoRoot).toBe("string");
		expect(handoff!.repoRoot).toBe(fx!.root);

		// Stop the agent so we don't leak the lease.
		manager.abort(id);
	});

	it("mode=reuse against an existing worktree updates reused:true and keeps identity", async () => {
		const manager = new AgentManager();
		// First spawn creates the worktree.
		const id1 = manager.spawn(
			{} as any,
			{ cwd: fx!.root } as any,
			CANONICAL,
			"first",
			{
				description: "create",
				isBackground: false,
				managedWorktree: {
					dag_id: "DAG-2026-014",
					task_id: "P2",
					mode: "create",
				},
			} as any,
		);
		const h1 = manager.getRecord(id1)!.managedWorktree;
		expect(h1!.reused).toBe(false);

		// Wait for the first agent to settle so the lease is released —
		// abort() is a control-plane signal; the lease drops on promise
		// resolution, which is what unblocks the second spawn.
		await manager.getRecord(id1)!.promise;
		manager.abort(id1);

		// Second spawn reuses the worktree.
		const id2 = manager.spawn(
			{} as any,
			{ cwd: fx!.root } as any,
			CANONICAL,
			"second",
			{
				description: "reuse",
				isBackground: false,
				managedWorktree: {
					dag_id: "DAG-2026-014",
					task_id: "P2",
					mode: "reuse",
				},
			} as any,
		);
		const h2 = manager.getRecord(id2)!.managedWorktree;
		expect(h2!.reused).toBe(true);
		// Identity (path / branch / dag / task) is preserved across reuse.
		expect(h2!.path).toBe(h1!.path);
		expect(h2!.branch).toBe(h1!.branch);
		expect(h2!.dag_id).toBe(h1!.dag_id);
		expect(h2!.task_id).toBe(h1!.task_id);

		manager.abort(id2);
	});
});

describe("developer-continuity: steer / getRecord / resume preserve the handoff", () => {
	let fx: RepoFixture | undefined;
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
		fx = makeRepoFixture("developer-continuity-steer");
	});
	afterEach(() => {
		fx?.dispose();
		fx = undefined;
	});

	it("steer_subagent leaves the handoff deep-equal (control-plane operation)", async () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			{} as any,
			{ cwd: fx!.root } as any,
			CANONICAL,
			"implement",
			{
				description: "steer target",
				isBackground: false,
				managedWorktree: {
					dag_id: "DAG-2026-014",
					task_id: "P2",
					mode: "create",
				},
			} as any,
		);
		const before = JSON.parse(
			JSON.stringify(manager.getRecord(id)!.managedWorktree),
		);

		// No-op steer — the agent may be in any state; the handoff must
		// be deep-equal before and after.
		const ok = manager.steer(id, "noop");
		expect(ok).toBe(true);

		const after = manager.getRecord(id)!.managedWorktree;
		expect(JSON.parse(JSON.stringify(after))).toEqual(before);

		manager.abort(id);
	});

	it("getRecord returns the same id and the same handoff (background queueing identity)", () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			{} as any,
			{ cwd: fx!.root } as any,
			CANONICAL,
			"implement",
			{
				description: "background target",
				isBackground: true,
				managedWorktree: {
					dag_id: "DAG-2026-014",
					task_id: "P2",
					mode: "create",
				},
			} as any,
		);
		const r1 = manager.getRecord(id);
		const r2 = manager.getRecord(id);
		expect(r1).toBe(r2);
		expect(r1!.managedWorktree).toEqual(r2!.managedWorktree);

		manager.abort(id);
	});

	it("resume preserves the handoff end-to-end", async () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			{} as any,
			{ cwd: fx!.root } as any,
			CANONICAL,
			"implement",
			{
				description: "resume target",
				isBackground: false,
				managedWorktree: {
					dag_id: "DAG-2026-014",
					task_id: "P2",
					mode: "create",
				},
			} as any,
		);
		const handoff = manager.getRecord(id)!.managedWorktree;
		expect(handoff).toBeDefined();

		// resume() — stubbed runAgent is replaced by stubbed resumeAgent
		// (via vi.mock at the top of this file). The handoff identity
		// must persist on the record.
		await manager.resume(id, "follow-up");
		const resumed = manager.getRecord(id);
		expect(resumed).toBeDefined();
		expect(resumed!.managedWorktree).toBeDefined();
		expect(resumed!.managedWorktree!.dag_id).toBe(handoff!.dag_id);
		expect(resumed!.managedWorktree!.task_id).toBe(handoff!.task_id);
		expect(resumed!.managedWorktree!.path).toBe(handoff!.path);
		expect(resumed!.managedWorktree!.branch).toBe(handoff!.branch);

		manager.abort(id);
	});
});

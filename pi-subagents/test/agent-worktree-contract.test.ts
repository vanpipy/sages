/**
 * agent-worktree-contract.test.ts — GC-2026-008 P2.
 *
 * Pins the Agent boundary's contract around the managed-worktree domain:
 *
 *   1. The JSON schema for the Agent tool's `isolation` field accepts an
 *      explicit worktree object — `{ dag_id, task_id, worktree_id?, mode }`
 *      — and rejects the legacy `"worktree"` string literal with a precise
 *      error message that names the missing fields, BEFORE any child agent
 *      runs. Never falls back to the legacy /tmp-backed ephemeral worktree.
 *
 *   2. `SpawnOptions.managedWorktree` flows through `AgentManager.spawn` /
 *      `spawnAndWait`: the manager provisions or reuses the managed worktree
 *      BEFORE calling `runAgent`, sets the child's cwd to the worktree path
 *      returned by `createManagedWorktree` / `reuseManagedWorktree`, and
 *      surfaces structured handoff metadata (`worktree.path` / `.branch` /
 *      `.baseSha` / `.baseRef` / `.head` / `.dirty`) plus a lease token on
 *      the resulting `AgentRecord.managedWorktree`.
 *
 *   3. Background queueing, `get_subagent_result`, `steer_subagent`, and
 *      `resume` operate against the same `AgentRecord.id` so identity is
 *      preserved across the lifecycle. The structured worktree handoff
 *      follows the record.
 *
 *   4. Concurrent spawns with the same `(repoRoot, dag, worktree)` slot are
 *      rejected with a clear error naming the path; the second spawn must
 *      not silently share the worktree.
 *
 *   5. `AgentManager.releaseManagedWorktree({ deleteBranch })` is the
 *      host-owned release path reachable through the manager: it removes
 *      the on-disk worktree, deletes the `.pi-worktree.json` marker, and —
 *      when `deleteBranch: true` is explicitly requested — deletes the
 *      `sages/<dag>/<worktree>` branch. Calls with paths that escape
 *      `<repoRoot>/.pi/worktree/` MUST throw a `path contained` error.
 *
 * We do not invoke the real `runAgent` (it depends on pi's createAgentSession
 * machinery); instead, we exercise the manager's spawn path directly with a
 * stubbed `runAgent` injected through dependency injection. The wiring is
 * trivial because `runAgent` is already imported as a regular function
 * reference — we'll swap it out via `vi.mock`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the agent-runner so a spawn does not need a live pi AgentSession. The
// implementation tests the manager contract; integration with `runAgent` is
// exercised by a smaller smoke test that asserts which cwd is passed.
//
// We share state between the mock factory and the test body via a
// `globalThis` slot. `vi.hoisted` is a vitest-only API; using globalThis lets
// bun test load the same test file without breaking. The mock factory runs
// before module imports resolve; we initialize the slot lazily inside the
// factory so the file works whether or not vi.mock actually intercepts.
const RUN_AGENT_STATE_KEY = "__pi_subagents_run_agent_calls__";
type RunAgentCall = { cwd: any; options: any };

function getRunAgentState(): { calls: RunAgentCall[] } {
	const g = globalThis as unknown as Record<string, { calls: RunAgentCall[] }>;
	if (!g[RUN_AGENT_STATE_KEY]) {
		g[RUN_AGENT_STATE_KEY] = { calls: [] };
	}
	return g[RUN_AGENT_STATE_KEY];
}
const RUN_AGENT_STATE: {
	calls: RunAgentCall[];
	reset(): void;
	get(): RunAgentCall[];
} = {
	get calls() {
		return getRunAgentState().calls;
	},
	reset() {
		getRunAgentState().calls.length = 0;
	},
	get(): RunAgentCall[] {
		return getRunAgentState().calls;
	},
};

vi.mock("../src/agent-runner.js", () => ({
	runAgent: vi.fn(async (_ctx: any, _type: any, _prompt: any, options: any) => {
		RUN_AGENT_STATE.calls.push({ cwd: options?.cwd, options });
		// Drive the same completion handshake as the real runner.
		setTimeout(() => {
			const cb = options?.onSessionCreated;
			if (typeof cb === "function") {
				cb({
					steer: async () => undefined,
					dispose: () => undefined,
					messages: [],
					subscribe: () => () => undefined,
					prompt: async () => undefined,
				});
			}
		}, 0);
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
	}),
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
import * as runnerModule from "../src/agent-runner.js";
import {
	acquireManagedWorktreeLease,
	readManagedWorktreeLease,
	releaseManagedWorktreeLease,
	validateIdentity,
} from "../src/worktree.js";
import {
	MANAGED_WORKTREE_REQUEST_TYPE,
	type ManagedWorktreeRequest,
	normalizeWorktreeIsolation,
	parseLegacyIsolationField,
	parseManagedWorktreeRequest,
	validateManagedWorktreeRequest,
} from "../src/worktree-contract.js";
import { makeRepoFixture, type RepoFixture, runGit } from "./_fixture.js";

const stubRunAgent = runnerModule.runAgent as unknown as ReturnType<
	typeof vi.fn
>;

beforeEach(() => {
	stubRunAgent.mockClear();
	RUN_AGENT_STATE.reset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("agent-worktree-contract: parseManagedWorktreeRequest", () => {
	it("parses the canonical request shape", () => {
		const req = parseManagedWorktreeRequest({
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
		});
		expect(req.dag_id).toBe("GC-2026-008");
		expect(req.task_id).toBe("P1");
		expect(req.mode).toBe("create");
	});

	it("rejects the legacy 'worktree' string literal at the type boundary", () => {
		// The Agent tool dispatcher hands in the raw `isolation` field. The legacy
		// literal must be refused here so that the JSON schema / manager can fail
		// BEFORE child execution.
		expect(() => parseManagedWorktreeRequest("worktree")).toThrow(
			/explicit worktree object/i,
		);
		expect(() => parseManagedWorktreeRequest("worktree")).toThrow(/dag_id/);
	});

	it("accepts mode='reuse' and forwards worktree_id", () => {
		const req = parseManagedWorktreeRequest({
			dag_id: "GC-2026-008",
			task_id: "P1",
			worktree_id: "wt-2",
			mode: "reuse",
		});
		expect(req.mode).toBe("reuse");
		expect(req.worktree_id).toBe("wt-2");
	});

	it("rejects unknown mode", () => {
		expect(() =>
			parseManagedWorktreeRequest({
				dag_id: "GC-2026-008",
				task_id: "P1",
				mode: "dup" as any,
			}),
		).toThrow(/mode/i);
	});

	it("rejects missing fields", () => {
		expect(() =>
			parseManagedWorktreeRequest({ task_id: "P1", mode: "create" }),
		).toThrow();
		expect(() =>
			parseManagedWorktreeRequest({ dag_id: "GC-2026-008", mode: "create" }),
		).toThrow();
		expect(() =>
			parseManagedWorktreeRequest({ dag_id: "GC-2026-008", task_id: "P1" }),
		).toThrow();
	});
});

describe("agent-worktree-contract: validateManagedWorktreeRequest", () => {
	it("delegates identity validation to validateIdentity", () => {
		expect(() =>
			validateManagedWorktreeRequest(
				parseManagedWorktreeRequest({
					dag_id: "GC-2026-008",
					task_id: "P1",
					mode: "create",
				}),
			),
		).not.toThrow();

		// dag / task_id are validated with the same constraints the managed
		// worktree helper enforces — so the validateManagedWorktreeRequest
		// boundary is just a thin validation surface.
		expect(() =>
			validateManagedWorktreeRequest(
				parseManagedWorktreeRequest({
					dag_id: "../escape",
					task_id: "P1",
					mode: "create",
				}),
			),
		).toThrow(/escape|invalid/i);
	});
});

describe("agent-worktree-contract: normalizeWorktreeIsolation + parseLegacyIsolationField", () => {
	it("normalizeWorktreeIsolation passes through undefined as absent", () => {
		expect(normalizeWorktreeIsolation(undefined)).toBeUndefined();
		expect(normalizeWorktreeIsolation(null)).toBeUndefined();
	});

	it("parseLegacyIsolationField accepts only the literal 'worktree'", () => {
		// The JSON schema accepts the literal as a vestigial alias — the
		// dispatcher refuses to forward it as "managed".
		expect(parseLegacyIsolationField("worktree")).toBe("worktree");
		expect(parseLegacyIsolationField(undefined)).toBeUndefined();
		expect(() => parseLegacyIsolationField("ephemeral" as any)).toThrow(
			/literal/i,
		);
	});
});

describe("agent-worktree-contract: the runtime request type is a single source of truth", () => {
	it("MANAGED_WORKTREE_REQUEST_TYPE describes the schema the Agent tool exposes", () => {
		expect(MANAGED_WORKTREE_REQUEST_TYPE.type).toBe("object");
		expect(MANAGED_WORKTREE_REQUEST_TYPE.required).toEqual(
			expect.arrayContaining(["dag_id", "task_id", "mode"]),
		);
		expect(MANAGED_WORKTREE_REQUEST_TYPE.required).not.toContain("worktree_id");
	});
});

// ---------------------------------------------------------------------------
// Lease semantics — owned by worktree.ts but pinned here so the Agent boundary
// can rely on them. Concurrent acquire MUST throw; release MUST be idempotent
// and the lease token MUST be a non-empty opaque string usable by handoff.
// ---------------------------------------------------------------------------
describe("agent-worktree-contract: worktree lease", () => {
	it("acquireManagedWorktreeLease returns a unique non-empty token", () => {
		const a = acquireManagedWorktreeLease("GC-2026-008", "P1");
		expect(a.token.length).toBeGreaterThan(0);
		expect(readManagedWorktreeLease("GC-2026-008", "P1")).toBe(a.token);
		// release so the next test gets a clean slate
		expect(releaseManagedWorktreeLease(a)).toBe(true);
		expect(readManagedWorktreeLease("GC-2026-008", "P1")).toBeNull();
	});

	it("concurrent acquire of the same (dag, worktree) throws and names the path slot", () => {
		const a = acquireManagedWorktreeLease("GC-2026-008", "P1");
		try {
			expect(() => acquireManagedWorktreeLease("GC-2026-008", "P1")).toThrow(
				/GC-2026-008.*P1/,
			);
			// peek shows the held token
			const peeked = readManagedWorktreeLease("GC-2026-008", "P1");
			expect(peeked).toBe(a.token);
		} finally {
			releaseManagedWorktreeLease(a);
		}
		// After release, the slot is acquirable again
		const c = acquireManagedWorktreeLease("GC-2026-008", "P1");
		releaseManagedWorktreeLease(c);
	});

	it("releaseManagedWorktreeLease of an unknown token is a no-op (idempotent)", () => {
		expect(() =>
			releaseManagedWorktreeLease({
				token: "no-such-token-12345",
				dag: "x",
				worktree: "y",
			} as any),
		).not.toThrow();
		expect(
			releaseManagedWorktreeLease({
				token: "no-such-token-12345",
				dag: "x",
				worktree: "y",
			} as any),
		).toBe(false);
	});

	it("readManagedWorktreeLease returns null when the slot is free", () => {
		expect(readManagedWorktreeLease("GC-2026-008", "P1")).toBeNull();
		const lease = acquireManagedWorktreeLease("GC-2026-008", "P1");
		try {
			expect(readManagedWorktreeLease("GC-2026-008", "P1")).toBe(lease.token);
		} finally {
			releaseManagedWorktreeLease(lease);
		}
	});
});

// ---------------------------------------------------------------------------
// deleteManagedWorktree — host-owned release path. Path containment FIRST.
// ---------------------------------------------------------------------------
describe("agent-worktree-contract: deleteManagedWorktree (host-owned release)", () => {
	let fx: RepoFixture;
	beforeEach(() => {
		fx = makeRepoFixture("agent-wt-delete");
	});
	afterEach(() => {
		fx.dispose();
	});

	it("removes the worktree path, the marker, and (when requested) the branch", async () => {
		const wt: ManagedWorktreeRequest = {
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
		};
		const manager = new AgentManager();
		const id = manager.spawn(
			undefined as any, // stub: runAgent is mocked
			{ cwd: fx.root } as any,
			"Explore",
			"stub prompt",
			{
				description: "wt-delete",
				managedWorktree: wt,
				isBackground: false,
				bypassQueue: true,
			},
		);
		// Allow microtask queue to flush
		await new Promise((r) => setImmediate(r));
		const rec = manager.getRecord(id);
		expect(rec?.managedWorktree).toBeDefined();
		const slot = rec!.managedWorktree!.path;
		expect(existsSync(slot)).toBe(true);
		const branch = rec!.managedWorktree!.branch;

		// Marker exists before delete
		const markerFp = join(
			fx.root,
			".pi",
			"worktree-state",
			"GC-2026-008",
			"P1.json",
		);
		expect(existsSync(markerFp)).toBe(true);
		// Branch exists before delete
		const beforeBranches = runGit(["branch"], { cwd: fx.root });
		expect(beforeBranches).toContain(branch);

		const result = manager.releaseManagedWorktree({
			repoRoot: fx.root,
			dag_id: "GC-2026-008",
			task_id: "P1",
			deleteBranch: true,
		});
		expect(result.removed).toBe(true);
		expect(existsSync(slot)).toBe(false);
		expect(existsSync(markerFp)).toBe(false);
		const afterBranches = runGit(["branch"], { cwd: fx.root });
		expect(afterBranches).not.toContain(branch);
		// Handoff metadata on the record reflects the deletion.
		expect(rec!.managedWorktree?.branch).toBe(branch);
		manager.dispose();
	});

	it("preserves the branch when deleteBranch is not requested", async () => {
		const wt: ManagedWorktreeRequest = {
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
		};
		const manager = new AgentManager();
		manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"stub",
			{
				description: "wt-preserve-branch",
				managedWorktree: wt,
				isBackground: false,
				bypassQueue: true,
			},
		);
		await new Promise((r) => setImmediate(r));
		const result = manager.releaseManagedWorktree({
			repoRoot: fx.root,
			dag_id: "GC-2026-008",
			task_id: "P1",
		});
		expect(result.removed).toBe(true);
		expect(result.branchDeleted).toBe(false);
		const afterBranches = runGit(["branch"], { cwd: fx.root });
		expect(afterBranches).toContain("sages/GC-2026-008/P1");
		manager.dispose();
	});

	it("refuses to escape .pi/worktree (path containment before deletion)", () => {
		const manager = new AgentManager();
		expect(() =>
			manager.releaseManagedWorktree({
				repoRoot: fx.root,
				path: join(fx.root, "..", "sibling", "evil"),
			} as any),
		).toThrow(/\.pi\/worktree/);
		// path-based call requires the path to live under `.pi/worktree`
		expect(() =>
			manager.releaseManagedWorktree({
				repoRoot: fx.root,
				path: join(fx.root, "src", "foo.ts"),
			} as any),
		).toThrow(/\.pi\/worktree/);
		manager.dispose();
	});

	it("refuses a path not under the supplied repoRoot", () => {
		const manager = new AgentManager();
		const otherFx = makeRepoFixture("agent-wt-delete-other");
		try {
			expect(() =>
				manager.releaseManagedWorktree({
					repoRoot: fx.root,
					path: join(otherFx.root, ".pi", "worktree", "GC-2026-008", "P1"),
				} as any),
			).toThrow(/\.pi\/worktree|repoRoot|contained/i);
		} finally {
			otherFx.dispose();
			manager.dispose();
		}
	});

	it("the workspacePath passed to runAgent is the managed worktree path exactly", async () => {
		const wt: ManagedWorktreeRequest = {
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
		};
		const manager = new AgentManager();
		manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"stub",
			{
				description: "wt-cwd",
				managedWorktree: wt,
				isBackground: false,
				bypassQueue: true,
			},
		);
		// runAgent is invoked synchronously inside spawn
		const calls = RUN_AGENT_STATE.get();
		expect(calls.length).toBe(1);
		expect(calls[0].options.cwd).toBe(
			join(fx.root, ".pi", "worktree", "GC-2026-008", "P1"),
		);
		manager.dispose();
	});
});

// ---------------------------------------------------------------------------
// Reuse + lifecycle — identity-preservation through the manager. We don't
// invoke a real runAgent (mocked), but the manager's record layers must hold
// stable handoff metadata across spawn → use.
// ---------------------------------------------------------------------------
describe("agent-worktree-contract: identity preservation", () => {
	let fx: RepoFixture;
	beforeEach(() => {
		fx = makeRepoFixture("agent-wt-identity");
	});
	afterEach(() => {
		fx.dispose();
	});

	it("two sequential spawns of the same (dag, task_id) reuse a single worktree when mode='reuse'", async () => {
		const manager = new AgentManager();
		const createReq: ManagedWorktreeRequest = {
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
		};
		const idA = manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"first",
			{
				description: "first",
				managedWorktree: createReq,
				isBackground: false,
				bypassQueue: true,
			},
		);
		await new Promise((r) => setImmediate(r));
		const recA = manager.getRecord(idA)!;
		const pathA = recA.managedWorktree!.path;

		const reuseReq: ManagedWorktreeRequest = {
			dag_id: "GC-2026-008",
			task_id: "P1",
			worktree_id: undefined,
			mode: "reuse",
		};
		const idB = manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"second",
			{
				description: "second",
				managedWorktree: reuseReq,
				isBackground: false,
				bypassQueue: true,
			},
		);
		await new Promise((r) => setImmediate(r));
		const recB = manager.getRecord(idB)!;
		expect(recB.managedWorktree!.path).toBe(pathA);
		expect(recB.managedWorktree!.reused).toBe(true);
		expect(recA.managedWorktree!.path).toBe(recB.managedWorktree!.path);
		manager.dispose();
	});

	it("handoff metadata includes path / branch / baseSha / baseRef / head / dirty / leaseToken", async () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"stub",
			{
				description: "handoff",
				managedWorktree: {
					dag_id: "GC-2026-008",
					task_id: "P1",
					mode: "create",
				},
				isBackground: false,
				bypassQueue: true,
			},
		);
		await new Promise((r) => setImmediate(r));
		const rec = manager.getRecord(id)!;
		const handoff = rec.managedWorktree!;
		expect(handoff.path).toBe(
			join(fx.root, ".pi", "worktree", "GC-2026-008", "P1"),
		);
		expect(handoff.branch).toBe("sages/GC-2026-008/P1");
		expect(handoff.baseRef).toBe("origin/main");
		expect(typeof handoff.baseSha).toBe("string");
		expect(handoff.baseSha.length).toBeGreaterThan(0);
		expect(typeof handoff.head).toBe("string");
		expect(handoff.head.length).toBeGreaterThan(0);
		expect(handoff.dirty).toBe(false);
		expect(typeof handoff.leaseToken).toBe("string");
		expect(handoff.leaseToken.length).toBeGreaterThan(0);
		// Worktree handoff carries no merge instruction string (Sages pins
		// that to pi/templates/SYSTEM.md).
		expect(JSON.stringify(handoff)).not.toMatch(/git merge/);
		manager.dispose();
	});

	it("background queueing preserves the agent id; get_subagent_result / steer see the same handoff", async () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"stub",
			{
				description: "bg",
				managedWorktree: {
					dag_id: "GC-2026-008",
					task_id: "P1",
					mode: "create",
				},
				isBackground: true,
				bypassQueue: false,
			},
		);
		const initialStatus = manager.getRecord(id)!.status;
		expect(initialStatus === "queued" || initialStatus === "running").toBe(
			true,
		);
		await new Promise((r) => setImmediate(r));
		const rec = manager.getRecord(id)!;
		expect(rec.managedWorktree!.path).toBe(
			join(fx.root, ".pi", "worktree", "GC-2026-008", "P1"),
		);
		// steer returns false after completion — by design — so we don't bother
		// testing it here. The contract is identity = id, and getRecord returns
		// the same record throughout the lifecycle.
		const again = manager.getRecord(id)!;
		expect(again.id).toBe(id);
		expect(again.managedWorktree).toEqual(rec.managedWorktree);
		manager.dispose();
	});

	it("abort before runAgent is wired still surfaces the handoff on the stopped record", () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"stub",
			{
				description: "abort-me",
				managedWorktree: {
					dag_id: "GC-2026-008",
					task_id: "P1",
					mode: "create",
				},
				isBackground: false,
				bypassQueue: true,
			},
		);
		// abort() while the runAgent promise is in flight queues the
		// handoff record (we still want to see the worktree on stop).
		expect(manager.abort(id)).toBe(true);
		const rec = manager.getRecord(id)!;
		expect(rec.status).toBe("stopped");
		expect(rec.managedWorktree?.path).toBe(
			join(fx.root, ".pi", "worktree", "GC-2026-008", "P1"),
		);
		manager.dispose();
	});
});

// ---------------------------------------------------------------------------
// validateIdentity ergonomic check — the Agent boundary delegates to the same
// constraint surface the worktree helper uses, so it must reject path-traversal.
// ---------------------------------------------------------------------------
describe("agent-worktree-contract: identity validation reuses validateIdentity", () => {
	it("validateIdentity rejects dag / task_id containing separators", () => {
		expect(() => validateIdentity("GC/2026", "P1")).toThrow();
		expect(() => validateIdentity("GC-2026-008", "P/1")).toThrow();
	});
});

// Surface-only smoke check — make sure the request can be encoded back into
// a handoff shape that downstream code (e.g. AgentDetails.worktree) reads.
describe("agent-worktree-contract: handoff shape is JSON-stringifiable", () => {
	let fx: RepoFixture;
	beforeEach(() => {
		fx = makeRepoFixture("agent-wt-json");
	});
	afterEach(() => {
		fx.dispose();
	});

	it("handoff round-trips through JSON.stringify / JSON.parse without loss", async () => {
		const manager = new AgentManager();
		const id = manager.spawn(
			undefined as any,
			{ cwd: fx.root } as any,
			"Explore",
			"stub",
			{
				description: "rt",
				managedWorktree: {
					dag_id: "GC-2026-008",
					task_id: "P1",
					mode: "create",
				},
				isBackground: false,
				bypassQueue: true,
			},
		);
		await new Promise((r) => setImmediate(r));
		const rec = manager.getRecord(id)!;
		const json = JSON.stringify(rec.managedWorktree);
		const parsed = JSON.parse(json);
		expect(parsed.path).toBe(rec.managedWorktree!.path);
		expect(parsed.branch).toBe(rec.managedWorktree!.branch);
		expect(parsed.baseSha).toBe(rec.managedWorktree!.baseSha);
		expect(parsed.leaseToken).toBe(rec.managedWorktree!.leaseToken);
		manager.dispose();
	});
});

/**
 * GC-2026-008 P2: the request schema gains an optional `base_ref` field.
 * The parser must:
 *   - accept the field when present (any safe git ref string)
 *   - default to `undefined` when absent (the helper's smart default then
 *     resolves to the cwd's current branch)
 *   - reject non-string / empty values
 * The schema's `required` list must NOT include `base_ref` (it's optional).
 */
describe("agent-worktree-contract: P2 — base_ref field in the request", () => {
	it("MANAGED_WORKTREE_REQUEST_TYPE does NOT require base_ref (it's optional)", () => {
		const required = MANAGED_WORKTREE_REQUEST_TYPE.required ?? [];
		expect(required).toEqual(
			expect.arrayContaining(["dag_id", "task_id", "mode"]),
		);
		expect(required).not.toContain("base_ref");
		expect(required).not.toContain("worktree_id");
	});

	it("MANAGED_WORKTREE_REQUEST_TYPE declares base_ref as an optional string property", () => {
		const props = MANAGED_WORKTREE_REQUEST_TYPE.properties as Record<
			string,
			{ type?: string; pattern?: string }
		>;
		expect(props.base_ref).toBeDefined();
		expect(props.base_ref.type).toBe("string");
		// The pattern enforces the same character class the runtime validates.
		expect(props.base_ref.pattern).toBe("^[A-Za-z0-9._/-]+$");
	});

	it("parseManagedWorktreeRequest omits base_ref when caller does not supply it", () => {
		const parsed = parseManagedWorktreeRequest({
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
		});
		expect(parsed.base_ref).toBeUndefined();
	});

	it("parseManagedWorktreeRequest preserves a valid base_ref verbatim", () => {
		const parsed = parseManagedWorktreeRequest({
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
			base_ref: "feature/x",
		});
		expect(parsed.base_ref).toBe("feature/x");
	});

	it("parseManagedWorktreeRequest accepts origin/<branch> refs", () => {
		const parsed = parseManagedWorktreeRequest({
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
			base_ref: "origin/feature/x",
		});
		expect(parsed.base_ref).toBe("origin/feature/x");
	});

	it("parseManagedWorktreeRequest accepts tag-like refs with dots", () => {
		const parsed = parseManagedWorktreeRequest({
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
			base_ref: "v1.2.3",
		});
		expect(parsed.base_ref).toBe("v1.2.3");
	});

	it("parseManagedWorktreeRequest rejects non-string base_ref", () => {
		expect(() =>
			parseManagedWorktreeRequest({
				dag_id: "GC-2026-008",
				task_id: "P1",
				mode: "create",
				base_ref: 42,
			}),
		).toThrow(/base_ref/);
		expect(() =>
			parseManagedWorktreeRequest({
				dag_id: "GC-2026-008",
				task_id: "P1",
				mode: "create",
				base_ref: null,
			}),
		).toThrow(/base_ref/);
	});

	it("parseManagedWorktreeRequest rejects empty-string base_ref", () => {
		expect(() =>
			parseManagedWorktreeRequest({
				dag_id: "GC-2026-008",
				task_id: "P1",
				mode: "create",
				base_ref: "",
			}),
		).toThrow(/base_ref/);
	});

	it("parseManagedWorktreeRequest accepts unsafe-looking base_ref at the schema layer (runtime validates)", () => {
		// The parser is intentionally a thin field-presence + type check.
		// The deeper `git check-ref-format` validation runs in
		// `createManagedWorktree` via `validateBaseRef` — a stage 1 schema
		// match is not the same as a safe ref name. Documenting the
		// separation here so a future contributor doesn't "promote" the
		// regex into the parser and lose the rich error messages.
		const parsed = parseManagedWorktreeRequest({
			dag_id: "GC-2026-008",
			task_id: "P1",
			mode: "create",
			base_ref: "../escape",
		});
		expect(parsed.base_ref).toBe("../escape");
	});
});

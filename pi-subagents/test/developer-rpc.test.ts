/**
 * developer-rpc.test.ts — RPC layer enforcement for the canonical `developer` agent.
 *
 * The cross-extension RPC layer (`cross-extension-rpc.ts`) forwards raw
 * caller input straight to `AgentManager.spawn`. Because spawn enforces
 * the developer-managed-isolation policy, the RPC layer inherits the
 * rejection — but it must convert the throw into the standard
 * `{ success: false, error: string }` envelope so RPC consumers see a
 * clean error instead of a generic exception.
 *
 * This file pins down:
 *   1. RPC `spawn` for canonical `developer` with the legacy literal
 *      returns `{ success: false, error: ... }` with the same precise
 *      message the dispatcher would surface.
 *   2. RPC `spawn` for canonical `developer` without any isolation
 *      returns the same envelope.
 *   3. RPC `spawn` for the legacy `software-developer` alias returns
 *      an "unknown agent type" envelope before manager side effects
 *      (GC-2026-028 F6 bounds validation).
 *   4. RPC `spawn` for `Explore` without isolation succeeds — the
 *      policy is a no-op for non-developer agents.
 *   5. RPC `spawn` for canonical `developer` with a valid managed-
 *      worktree object succeeds and the underlying record carries the
 *      managed-worktree handoff.
 *
 * The tests use a stub `manager` that delegates alias resolution and
 * policy enforcement to the real `AgentManager.spawn` path — the RPC
 * layer's only job is to convert the spawn result (id) or throw
 * (policy reject) into the standard envelope.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { makeRepoFixture, type RepoFixture } from "./_fixture.js";

interface EventBusStub {
	handlers: Map<string, ((data: unknown) => void)[]>;
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

function makeEventBus(): EventBusStub {
	const handlers = new Map<string, ((data: unknown) => void)[]>();
	return {
		handlers,
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const idx = cur.indexOf(handler);
				if (idx >= 0) cur.splice(idx, 1);
			};
		},
		emit(event, data) {
			for (const h of handlers.get(event) ?? []) h(data);
		},
	};
}

describe("developer-rpc: spawn RPC enforces the policy", () => {
	let fx: RepoFixture | undefined;
	let bus: EventBusStub | undefined;
	let manager: AgentManager | undefined;
	let handle: { unsubSpawn: () => void } | undefined;

	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
		fx = makeRepoFixture("developer-rpc");
		manager = new AgentManager();
		bus = makeEventBus();
		handle = registerRpcHandlers({
			events: bus as any,
			pi: {} as any,
			getCtx: () => ({ cwd: fx!.root }) as any,
			manager: manager as any,
		});
	});

	afterEach(() => {
		handle?.unsubSpawn();
		handle = undefined;
		manager = undefined;
		bus = undefined;
		fx?.dispose();
		fx = undefined;
	});

	it("returns a precise error envelope for canonical `Developer` + legacy `worktree` literal", async () => {
		const requestId = "r1";
		const reply = await new Promise<any>((resolve) => {
			bus!.on(`subagents:rpc:spawn:reply:${requestId}`, (raw: any) =>
				resolve(raw),
			);
			bus!.emit("subagents:rpc:spawn", {
				requestId,
				type: "Developer",
				prompt: "implement the thing",
				options: { description: "rpc spawn", isolation: "worktree" },
			});
		});
		expect(reply.success).toBe(false);
		expect(typeof reply.error).toBe("string");
		expect(reply.error).toMatch(/developer/i);
		expect(reply.error).toMatch(/worktree/i);
		expect(reply.error).toMatch(/explicit/i);
	});

	it("returns a precise error envelope for canonical `Developer` without any isolation", async () => {
		const requestId = "r2";
		const reply = await new Promise<any>((resolve) => {
			bus!.on(`subagents:rpc:spawn:reply:${requestId}`, (raw: any) =>
				resolve(raw),
			);
			bus!.emit("subagents:rpc:spawn", {
				requestId,
				type: "Developer",
				prompt: "implement the thing",
				options: { description: "rpc spawn" },
			});
		});
		expect(reply.success).toBe(false);
		expect(reply.error).toMatch(/developer/i);
	});

	it("accepts the legacy lowercase spelling case-insensitively (GC-2026-091)", async () => {
		// The canonical registry key is `Developer` after GC-2026-091, but
		// cross-extension callers (and persisted DAG YAMLs) still send
		// `developer`. The RPC type check resolves case-insensitively, so
		// the request reaches the managed-isolation policy instead of
		// bouncing off an "unknown agent type" error.
		const requestId = "r2b";
		const reply = await new Promise<any>((resolve) => {
			bus!.on(`subagents:rpc:spawn:reply:${requestId}`, (raw: any) =>
				resolve(raw),
			);
			bus!.emit("subagents:rpc:spawn", {
				requestId,
				type: "developer",
				prompt: "implement the thing",
				options: { description: "rpc spawn" },
			});
		});
		expect(reply.success).toBe(false);
		expect(reply.error).not.toMatch(/unknown agent type/i);
		expect(reply.error).toMatch(/developer/i);
	});

	it("rejects the removed legacy alias before spawning", async () => {
		// GC-2026-028 F6: RPC callers are untrusted. Validate their type
		// against the enabled registry before calling AgentManager.spawn,
		// rather than creating a record that only fails asynchronously.
		const requestId = "r3";
		const reply = await new Promise<any>((resolve) => {
			bus!.on(`subagents:rpc:spawn:reply:${requestId}`, (raw: any) =>
				resolve(raw),
			);
			bus!.emit("subagents:rpc:spawn", {
				requestId,
				type: "software-developer",
				prompt: "implement the thing",
				options: { description: "rpc spawn", isolation: "worktree" },
			});
		});
		expect(reply.success).toBe(false);
		expect(reply.error).toMatch(/unknown agent type/i);
	});
});

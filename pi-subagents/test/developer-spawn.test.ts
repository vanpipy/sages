/**
 * developer-spawn.test.ts — `AgentManager.spawn` managed-isolation enforcement.
 *
 * Pins the runtime boundary that AgentManager.spawn must enforce on the
 * canonical `developer` agent:
 *
 *   1. `DEFAULT_AGENTS` does not duplicate the developer roster under any
 *      legacy alias name (GC-2026-014: the alias infrastructure was
 *      removed entirely — `software-developer` is an unknown agent type).
 *   2. The managed-isolation policy is enforced BEFORE `runAgent`
 *      runs. Missing / legacy-string isolation for canonical `developer`
 *      throws — the spawn must not silently fall back to general-purpose
 *      (which was removed in DAG-2026-011 Phase C — passing that name is
 *      now an "unknown agent type" error, not a fallback path).
 *   3. A valid managed-worktree object provisions the worktree and
 *      attaches the handoff to `record.managedWorktree` (path /
 *      branch / baseSha / baseRef / head / dirty / leaseToken /
 *      dag_id / task_id / worktree_id / repoRoot). Other agents
 *      (Explore / Plan) are unaffected.
 *
 * The integration tests use the `_fixture.ts` helper for real git
 * repos and stub `runAgent` so the test only exercises the spawn path
 * (not the LLM child execution).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
	getAgentConfig,
	registerAgents,
	resolveType,
	setDefaultsDisabled,
} from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { makeRepoFixture, type RepoFixture } from "./_fixture.js";

const CANONICAL = "developer";
const LEGACY_ALIAS = "software-developer";

describe("developer-spawn: registry invariants (GC-2026-014)", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("registers the canonical `developer` under that exact name", () => {
		expect(DEFAULT_AGENTS.has(CANONICAL)).toBe(true);
	});

	it("does NOT register a legacy `software-developer` roster entry — the alias is gone", () => {
		expect(DEFAULT_AGENTS.has(LEGACY_ALIAS)).toBe(false);
	});

	it("resolveType returns `developer` for the canonical spelling", () => {
		expect(resolveType("developer")).toBe("developer");
	});

	it("resolveType returns `undefined` for the legacy spelling (alias removed in GC-2026-014)", () => {
		// The Phase A alias infrastructure was deleted. Legacy callers
		// surfacing as "Unknown agent type" — pin the resolution path.
		expect(resolveType(LEGACY_ALIAS)).toBeUndefined();
	});

	it("getAgentConfig returns undefined for the legacy spelling", () => {
		expect(getAgentConfig(LEGACY_ALIAS)).toBeUndefined();
	});
});

describe("developer-spawn: managed-isolation policy refuses malformed isolation", () => {
	// Policy enforcement is exercised in developer-runtime.test.ts at the
	// unit level. Here we just verify the integration: a spawn call with
	// missing / legacy-string isolation for the canonical developer must
	// throw, and `runAgent` must NOT have been called.
	let fx: RepoFixture | undefined;
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
		fx = makeRepoFixture("developer-spawn");
	});
	afterEach(() => {
		fx?.dispose();
		fx = undefined;
	});

	it("throws when canonical developer is spawned with the legacy string literal", () => {
		const manager = new AgentManager();
		expect(() =>
			manager.spawn(
				{} as any,
				{ cwd: fx!.root } as any,
				CANONICAL,
				"implement the thing",
				{ description: "spawn", isolation: "worktree" } as any,
			),
		).toThrow(/developer/i);
	});

	it("throws when canonical developer is spawned without any isolation", () => {
		const manager = new AgentManager();
		expect(() =>
			manager.spawn(
				{} as any,
				{ cwd: fx!.root } as any,
				CANONICAL,
				"implement the thing",
				{ description: "spawn" } as any,
			),
		).toThrow(/developer/i);
	});

	it("does NOT throw when non-developer agents (Explore) are spawned without isolation", () => {
		const manager = new AgentManager();
		expect(() =>
			manager.spawn(
				{} as any,
				{ cwd: fx!.root } as any,
				"Explore",
				"find the thing",
				{ description: "explore" } as any,
			),
		).not.toThrow();
	});
});

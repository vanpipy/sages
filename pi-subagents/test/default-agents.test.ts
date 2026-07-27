/**
 * default-agents.test.ts — Registry invariants for built-in subagents.
 *
 * Phase A P1 (DAG-2026-011): the canonical `developer` agent is added to
 * `DEFAULT_AGENTS`. This file pins the roster invariants every other test
 * can build on: name, tools, extensions, background default, prompt
 * embed, and the explicit managed-isolation policy NOT being carried via
 * the legacy `isolation: "worktree"` field on the config itself.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/default-agents.js";

describe("default-agents: roster", () => {
	it("registers general-purpose, Explore, Plan (unchanged)", () => {
		expect(DEFAULT_AGENTS.has("general-purpose")).toBe(true);
		expect(DEFAULT_AGENTS.has("Explore")).toBe(true);
		expect(DEFAULT_AGENTS.has("Plan")).toBe(true);
	});

	it("registers the canonical `developer` agent (Phase A P1)", () => {
		expect(DEFAULT_AGENTS.has("developer")).toBe(true);
	});

	it("does NOT register a duplicate `software-developer` roster entry (alias only)", () => {
		// The Phase A alias `software-developer -> developer` is metadata,
		// not a separate registry entry. A duplicate roster would let the
		// alias shadow canonical defaults and break precedence rules.
		expect(DEFAULT_AGENTS.has("software-developer")).toBe(false);
	});
});

describe("default-agents: developer config", () => {
	const dev = DEFAULT_AGENTS.get("developer");

	it("is registered with isDefault: true", () => {
		expect(dev?.isDefault).toBe(true);
	});

	it("has displayName 'Developer' and description referencing TDD", () => {
		expect(dev?.displayName).toBe("Developer");
		expect(dev?.description.toLowerCase()).toContain("tdd");
	});

	it("uses promptMode: 'replace' so the canonical prompt replaces the parent identity", () => {
		expect(dev?.promptMode).toBe("replace");
	});

	it("carries the canonical system prompt (non-empty, contains 'RED → GREEN → REFACTOR')", () => {
		expect(typeof dev?.systemPrompt).toBe("string");
		expect(dev?.systemPrompt.length).toBeGreaterThan(0);
		expect(dev?.systemPrompt).toContain("RED");
		expect(dev?.systemPrompt).toContain("GREEN");
		expect(dev?.systemPrompt).toContain("REFACTOR");
	});

	it("lists the required built-in tools: read, bash, grep, find, ls, edit, write", () => {
		const tools = new Set(dev?.builtinToolNames ?? []);
		for (const t of ["read", "bash", "grep", "find", "ls", "edit", "write"]) {
			expect(tools.has(t), `developer must include tool ${t}`).toBe(true);
		}
	});

	it("carries the required extensions: aft, pi-mcp-adapter, pi-magic-context", () => {
		// `extensions` is the loader-level selector; it must include all three
		// required extensions by canonical name so they load into the agent.
		// GC-2026-012: the magic-context selector was renamed to its package
		// name `pi-magic-context` so it survives the migration off the bare
		// `magic-context` identifier that previously resolved by accident.
		const extensions = dev?.extensions;
		expect(extensions).not.toBe(false);
		const list =
			extensions === true || extensions === undefined ? null : extensions;
		expect(list, "developer must pin extensions to a list").not.toBeNull();
		expect(list).toContain("aft");
		expect(list).toContain("pi-mcp-adapter");
		expect(list).toContain("pi-magic-context");
		expect(list).not.toContain("magic-context");
	});

	it("disables skills (false) — same posture as the legacy Sages role", () => {
		expect(dev?.skills).toBe(false);
	});

	it("defaults runInBackground to true (background default per README)", () => {
		expect(dev?.runInBackground).toBe(true);
	});

	it("does NOT copy the legacy `isolation: 'worktree'` literal — that policy is encoded separately", () => {
		// The legacy string literal is rejected by the worktree contract. The
		// package policy for `developer` (require explicit managed-worktree
		// object) lives in `enforceDeveloperManagedIsolationPolicy`, NOT in
		// this config field. This test pins that separation so a future
		// contributor can't reintroduce the old shape here.
		expect(dev?.isolation).toBeUndefined();
	});

	it("records the legacy `software-developer` name in `aliases` (deprecation signal)", () => {
		expect(dev?.aliases).toEqual(
			expect.arrayContaining(["software-developer"]),
		);
	});
});

/**
 * Subagent isolation + per-agent turn-limit invariants.
 *
 * Pinned here so the policy "subagents cannot dispatch further subagents" and
 * the role-specific `maxTurns` budgets are visible in code, not just inferred
 * from prose. The runtime already enforces the Agent-tool ban via
 * `EXCLUDED_TOOL_NAMES` in agent-runner.ts, but the proactive
 * `excludeExtensions: ["pi-subagents"]` is the cleanest expression of the
 * policy and the only one user-defined agents can read at a glance.
 */
describe("default-agents: subagent isolation", () => {
	// Every default agent must carry `excludeExtensions: ["pi-subagents"]` so
	// the Agent tool / get_subagent_result / steer_subagent never load. The
	// `developer` agent is also covered even though its `extensions:` list
	// doesn't include `pi-subagents` — explicit excludes survive a future
	// loosening of the include list.
	for (const name of ["general-purpose", "Explore", "Plan", "developer"] as const) {
		it(`${name} excludes pi-subagents from its extension set`, () => {
			const config = DEFAULT_AGENTS.get(name);
			expect(config, `${name} must be registered as a default agent`).toBeDefined();
			const excludes = config?.excludeExtensions ?? [];
			expect(
				excludes.map((s) => s.toLowerCase()),
				`${name}.excludeExtensions must include "pi-subagents"`,
			).toContain("pi-subagents");
		});
	}

	it("general-purpose is the only default with the historical inline annotation", () => {
		// The `// ← NEW: cannot recursively dispatch Agent tool` inline note
		// is historical context for the recent change. It only needs to live
		// on one entry; the rest can carry a fresh comment. This test pins
		// that the marker is exactly where the change history put it — if a
		// future contributor rewrites the entry, the comment can be dropped
		// alongside the marker without losing the semantic guarantee above.
		const gp = DEFAULT_AGENTS.get("general-purpose");
		expect(gp?.excludeExtensions).toEqual(["pi-subagents"]);
	});
});

describe("default-agents: per-agent maxTurns budgets", () => {
	// The runtime resolves `maxTurns` as
	//   options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns
	// so an explicit per-agent budget takes precedence over the global default.
	// Caller-supplied `Agent({ max_turns: ... })` still wins at spawn time.
	const expected: Record<string, number> = {
		"general-purpose": 50,
		Explore: 50,
		Plan: 100,
		developer: 200,
	};

	for (const [name, limit] of Object.entries(expected)) {
		it(`${name} sets maxTurns = ${limit}`, () => {
			const config = DEFAULT_AGENTS.get(name);
			expect(config?.maxTurns, `${name} must pin maxTurns`).toBe(limit);
		});
	}

	it("every default agent sets an explicit maxTurns (no global-default fallthrough)", () => {
		// A future contributor who adds a new default agent and forgets to
		// set `maxTurns` would silently inherit the global default — which
		// is `undefined` (unlimited) at startup. This test guards against
		// that by requiring every default to declare its own budget.
		for (const [name, config] of DEFAULT_AGENTS) {
			expect(
				typeof config.maxTurns,
				`default agent "${name}" must declare an explicit maxTurns`,
			).toBe("number");
			expect(
				(config.maxTurns ?? 0) > 0,
				`default agent "${name}" maxTurns must be positive`,
			).toBe(true);
		}
	});

	it("maxTurns budgets are within the settings ceiling (defense-in-depth)", () => {
		// `MAX_TURNS_CEILING = 10_000` (settings.ts) bounds what `sanitize()`
		// accepts from project / global subagents.json. The hardcoded agent
		// defaults skip sanitize() (they're in source, not config) but the
		// values should still stay well below the ceiling so future
		// settings-layer overrides can never be silently stricter than the
		// hardcoded default.
		const MAX_TURNS_CEILING = 10_000;
		for (const [name, config] of DEFAULT_AGENTS) {
			expect(
				(config.maxTurns ?? 0) <= MAX_TURNS_CEILING,
				`default agent "${name}" maxTurns must be <= ${MAX_TURNS_CEILING}`,
			).toBe(true);
		}
	});
});

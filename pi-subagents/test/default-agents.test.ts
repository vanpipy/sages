/**
 * default-agents.test.ts — Registry invariants for built-in subagents.
 *
 * Pins the roster invariants every other test can build on: name, tools,
 * extensions, background default, prompt embed, and the explicit
 * managed-isolation policy NOT being carried via the legacy
 * `isolation: "worktree"` field on the config itself.
 *
 * GC-2026-014: the Phase A / Phase B aliases (`software-developer` /
 * `software-auditor`) were removed entirely — both names now resolve as
 * unknown agent types and are NOT in any roster entry or `aliases` field.
 * The "legacy aliases removed" invariants below pin that state.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/default-agents.js";

describe("default-agents: roster", () => {
	it("registers Explore, Plan (unchanged)", () => {
		expect(DEFAULT_AGENTS.has("Explore")).toBe(true);
		expect(DEFAULT_AGENTS.has("Plan")).toBe(true);
	});

	it("registers Plan as a lightweight plan compiler (DAG-2026-017)", () => {
		// Public name stays `Plan`. Role identity is now "plan compiler";
		// the main agent owns architecture. Pinned by the dedicated
		// Plan config tests below.
		const plan = DEFAULT_AGENTS.get("Plan");
		expect(plan, "Plan must be registered").toBeDefined();
	});

	it("does NOT register `general-purpose` (removed in DAG-2026-011 Phase C)", () => {
		expect(DEFAULT_AGENTS.has("general-purpose")).toBe(false);
	});

	it("registers the canonical `developer` agent", () => {
		expect(DEFAULT_AGENTS.has("developer")).toBe(true);
	});

	it("does NOT register `software-developer` (GC-2026-014: legacy alias removed)", () => {
		// The Phase A alias was dropped in GC-2026-014 along with the
		// AgentConfig.aliases field. Callers passing the legacy spelling
		// now get a precise "Unknown agent type" error from the Agent
		// dispatcher.
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

	it("does NOT carry the legacy `isolation: 'worktree'` literal — that policy is encoded separately", () => {
		// The legacy string literal is rejected by the worktree contract. The
		// package policy for `developer` (require explicit managed-worktree
		// object) lives in `enforceDeveloperManagedIsolationPolicy`, NOT in
		// this config field. This test pins that separation so a future
		// contributor can't reintroduce the old shape here.
		expect(dev?.isolation).toBeUndefined();
	});

	it("does NOT carry a `software-developer` alias (GC-2026-014: aliases field removed from AgentConfig)", () => {
		// The AgentConfig.aliases field was dropped entirely in GC-2026-014.
		// Pin the absence so a future contributor can't quietly reintroduce it.
		expect(dev?.aliases).toBeUndefined();
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
	for (const name of ["Explore", "Plan", "developer", "auditor"] as const) {
		it(`${name} excludes pi-subagents from its extension set`, () => {
			const config = DEFAULT_AGENTS.get(name);
			expect(
				config,
				`${name} must be registered as a default agent`,
			).toBeDefined();
			const excludes = config?.excludeExtensions ?? [];
			expect(
				excludes.map((s) => s.toLowerCase()),
				`${name}.excludeExtensions must include "pi-subagents"`,
			).toContain("pi-subagents");
		});
	}
});

describe("default-agents: per-agent maxTurns budgets", () => {
	// The runtime resolves `maxTurns` as
	//   options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns
	// so an explicit per-agent budget takes precedence over the global default.
	// Caller-supplied `Agent({ max_turns: ... })` still wins at spawn time.
	const expected: Record<string, number> = {
		Explore: 50,
		// Plan is a lightweight compiler; the budget covers one Brief +
		// verified file reads + READY/BLOCKED write. Going over means
		// the main agent under-specified the brief.
		Plan: 12,
		developer: 200,
		auditor: 200,
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

describe("default-agents: auditor (Phase B) — canonical `auditor` registered", () => {
	it("registers the canonical `auditor` agent", () => {
		expect(DEFAULT_AGENTS.has("auditor")).toBe(true);
	});

	it("does NOT register `software-auditor` (GC-2026-014: legacy alias removed)", () => {
		// The Phase B alias was dropped in GC-2026-014 along with the
		// AgentConfig.aliases field.
		expect(DEFAULT_AGENTS.has("software-auditor")).toBe(false);
	});
});

describe("default-agents: auditor config", () => {
	const aud = DEFAULT_AGENTS.get("auditor");

	it("is registered with isDefault: true", () => {
		expect(aud?.isDefault).toBe(true);
	});

	it("has displayName 'Auditor' and description referencing the audit discipline", () => {
		expect(aud?.displayName).toBe("Auditor");
		expect(aud?.description.toLowerCase()).toContain("audit");
		// Default verdict stance is part of the public contract.
		expect(aud?.description.toLowerCase()).toContain("needs work");
	});

	it("uses promptMode: 'replace' so the canonical prompt replaces the parent identity", () => {
		expect(aud?.promptMode).toBe("replace");
	});

	it("carries the canonical system prompt (non-empty, references all three verdicts)", () => {
		expect(typeof aud?.systemPrompt).toBe("string");
		expect(aud?.systemPrompt.length).toBeGreaterThan(0);
		expect(aud?.systemPrompt).toContain("CERTIFIED");
		expect(aud?.systemPrompt).toContain("NEEDS WORK");
		expect(aud?.systemPrompt).toContain("BLOCKED");
	});

	it("lists the same required built-in tools as developer (read, bash, grep, find, ls, edit, write)", () => {
		// The auditor shares developer's tool set: edit/write are present
		// for the single allowed write target (the audit-{task_id}.md
		// report). The "verify only / no production edits" rule lives
		// in the prompt, not in the tool allowlist.
		const tools = new Set(aud?.builtinToolNames ?? []);
		for (const t of ["read", "bash", "grep", "find", "ls", "edit", "write"]) {
			expect(tools.has(t), `auditor must include tool ${t}`).toBe(true);
		}
	});

	it("carries the required extensions: aft, pi-mcp-adapter, pi-magic-context", () => {
		// Symmetric with developer. The auditor prompt's tool preference
		// order relies on these extensions being loaded.
		const extensions = aud?.extensions;
		expect(extensions).not.toBe(false);
		const list =
			extensions === true || extensions === undefined ? null : extensions;
		expect(list, "auditor must pin extensions to a list").not.toBeNull();
		expect(list).toContain("aft");
		expect(list).toContain("pi-mcp-adapter");
		expect(list).toContain("pi-magic-context");
	});

	it("disables skills (false) — auditor re-derives conventions at audit time per First Action Protocol", () => {
		expect(aud?.skills).toBe(false);
	});

	it("defaults runInBackground to true (audits re-run every verification and must not block)", () => {
		expect(aud?.runInBackground).toBe(true);
	});

	it("sets maxTurns = 200 (re-run loop + diff inspection + report write)", () => {
		// Symmetric with developer; audits need a generous budget for
		// typecheck + lint + tests + diff inspection + report write.
		expect(aud?.maxTurns).toBe(200);
	});

	it("does NOT copy the legacy `isolation: 'worktree'` literal — auditor is read-only on the developer's worktree", () => {
		// The auditor never enters a managed worktree; it audits the
		// developer's worktree from the outside. `enforceDeveloperManagedIsolationPolicy`
		// is `developer`-only.
		expect(aud?.isolation).toBeUndefined();
	});

	it("does NOT carry a `software-auditor` alias (GC-2026-014: aliases field removed from AgentConfig)", () => {
		// The AgentConfig.aliases field was dropped entirely in GC-2026-014.
		expect(aud?.aliases).toBeUndefined();
	});
});

describe("default-agents: auditor subagent isolation", () => {
	// Symmetric with developer: the auditor also pins
	// `excludeExtensions: ["pi-subagents"]` so the Agent tool cannot
	// load by accident. The auditor's purpose is verify-only — letting
	// it spawn further Agent calls would defeat the audit invariant.
	it("auditor excludes pi-subagents from its extension set", () => {
		const config = DEFAULT_AGENTS.get("auditor");
		expect(
			config,
			"auditor must be registered as a default agent",
		).toBeDefined();
		const excludes = config?.excludeExtensions ?? [];
		expect(
			excludes.map((s) => s.toLowerCase()),
			`auditor.excludeExtensions must include "pi-subagents"`,
		).toContain("pi-subagents");
	});
});

/**
 * Plan runtime contract — DAG-2026-017.
 *
 * Plan is a lightweight plan compiler, not an architect. The runtime
 * config below is the load-bearing part of the contract: even if a
 * future contributor weakens the prompt prose, these runtime knobs
 * keep Plan cheap and bounded.
 *
 * Public name stays `Plan`; the description must reflect the new
 * role; the tools list is the single source of truth for what Plan
 * can see; model + thinking + maxTurns pin the cost.
 */
describe("default-agents: Plan config (DAG-2026-017)", () => {
	const plan = DEFAULT_AGENTS.get("Plan");

	it("is registered with isDefault: true", () => {
		expect(plan?.isDefault).toBe(true);
	});

	it("uses promptMode: 'replace' (matches all other defaults)", () => {
		expect(plan?.promptMode).toBe("replace");
	});

	it("description frames Plan as a plan compiler, not an architect", () => {
		expect(plan?.displayName).toBe("Plan");
		const desc = plan?.description.toLowerCase() ?? "";
		// New identity pinned: the agent COMPIles a Planning Brief. The
		// description MUST NOT promise architecture / exploration /
		// trade-off design — that is the main agent's job.
		expect(desc).toContain("plan");
		expect(desc).toMatch(/brief|compile/);
		expect(desc).not.toContain("architect");
		expect(desc).not.toContain("trade-off");
	});

	it("builtinToolNames is exactly ['read'] — minimal surface for symbol/path confirmation", () => {
		// No bash, grep, find, ls, edit, write. Plan may read explicitly
		// named files only.
		expect(plan?.builtinToolNames).toEqual(["read"]);
	});

	it("disables extensions (false) — no codebase_memory / aft / ctx_search / magic-context", () => {
		// The previous Plan config had `extensions: true`, which loaded
		// aft / pi-mcp-adapter / pi-magic-context and let Plan run the
		// full architecture scan. Flip to false so Plan cannot reach
		// those tools even if the prompt drifted.
		expect(plan?.extensions).toBe(false);
	});

	it("disables skills (false)", () => {
		expect(plan?.skills).toBe(false);
	});

	it("uses fixed lightweight model anthropic/claude-haiku-4-5", () => {
		// Cost guard: Plan must not inherit the main agent's model.
		// haiku is the same model Explore uses for cheap read-only work.
		expect(plan?.model).toBe("anthropic/claude-haiku-4-5");
	});

	it("uses thinking: 'minimal'", () => {
		expect(plan?.thinking).toBe("minimal");
	});

	it("sets maxTurns = 12 (compile budget, not exploration budget)", () => {
		expect(plan?.maxTurns).toBe(12);
	});

	it("runInBackground = false (Plan returns a compiled plan inline)", () => {
		// Default at runtime is false, but the config field MUST be
		// pinned explicit so a future contributor can't silently flip
		// Plan to async.
		expect(plan?.runInBackground).toBe(false);
	});

	it("inheritContext = false — main agent must send a self-contained Planning Brief", () => {
		// Deliberate: the main agent owns its conversation. Plan must
		// receive only the Brief it was asked to compile, not the entire
		// upstream transcript. This is the load-bearing isolation that
		// keeps Plan from re-deriving decisions from chat history.
		expect(plan?.inheritContext).toBe(false);
	});
});

describe("default-agents: Plan subagent isolation", () => {
	it("excludes pi-subagents from its extension set", () => {
		const plan = DEFAULT_AGENTS.get("Plan");
		expect(plan, "Plan must be registered as a default agent").toBeDefined();
		const excludes = plan?.excludeExtensions ?? [];
		expect(
			excludes.map((s) => s.toLowerCase()),
			`Plan.excludeExtensions must include "pi-subagents"`,
		).toContain("pi-subagents");
	});
});

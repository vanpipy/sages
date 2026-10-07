/**
 * default-agents.test.ts — Registry invariants for built-in subagents.
 *
 * Pins the roster invariants every other test can build on: name, tools,
 * extensions, background default, prompt embed, and the explicit
 * managed-isolation policy NOT being carried via the legacy
 * `isolation: "worktree"` field on the config itself.
 *
 * GC-2026-014: the Phase A / Phase B aliases (`software-developer` /
 * `software-reviewer`) were removed entirely — both names now resolve as
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

	it("registers the canonical `Developer` agent", () => {
		expect(DEFAULT_AGENTS.has("Developer")).toBe(true);
	});

	it("does NOT register `software-developer` (GC-2026-014: legacy alias removed)", () => {
		// The Phase A alias was dropped in GC-2026-014 along with the
		// AgentConfig.aliases field. Callers passing the legacy spelling
		// now get a precise "Unknown agent type" error from the Agent
		// dispatcher.
		expect(DEFAULT_AGENTS.has("software-developer")).toBe(false);
	});

	it("does NOT register `git-expert` (GC-2026-091: agent removed)", () => {
		// GC-2026-091: the git-expert sub-agent was removed from the
		// roster along with its prompt module. Callers passing the name
		// now get a precise "Unknown agent type" error.
		expect(DEFAULT_AGENTS.has("git-expert")).toBe(false);
	});
});

describe("default-agents: developer config", () => {
	const dev = DEFAULT_AGENTS.get("Developer");

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

	it("carries the required extensions: aft-pi, pi-mcp-adapter", () => {
		// `extensions` is the loader-level selector; it must include both
		// required extensions by canonical name so they load into the agent.
		// GC-2026-remove-magic-context: pi-magic-context was dropped from the
		// developer allowlist — magic-context is replaced by pi-tasks at the
		// orchestrator layer and Sages' internal personal-todowrite covers
		// the per-subagent tracker need.
		//
		// GC-2026-prompt-parser-contract-cleanup: the canonical name for the
		// AFT extension is `"aft-pi"` (the unscoped npm short name from
		// `@cortexkit/aft-pi`'s package manifest). The previous `"aft"` value
		// never matched `extensionCanonicalNames(extPath)`, which returns
		// `["dist", "aft-pi"]` for the extension's entry path — so AFT was
		// silently never loaded into Developer/Reviewer/MergerAdvisor, and the
		// "FORBIDDEN bash grep" rule had no tool to back it up.
		const extensions = dev?.extensions;
		expect(extensions).not.toBe(false);
		const list =
			extensions === true || extensions === undefined ? null : extensions;
		expect(list, "developer must pin extensions to a list").not.toBeNull();
		expect(list).toContain("aft-pi");
		expect(list).toContain("pi-mcp-adapter");
		expect(list).not.toContain("aft"); // the old short name no longer matches
		expect(list).not.toContain("pi-magic-context");
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

describe("default-agents: subagent isolation", () => {
	// Every default agent must carry `excludeExtensions: ["pi-subagents"]` so
	// the Agent tool / get_subagent_result / steer_subagent never load. The
	// `developer` agent is also covered even though its `extensions:` list
	// doesn't include `pi-subagents` — explicit excludes survive a future
	// loosening of the include list.
	for (const name of [
		"Explore",
		"Plan",
		"Developer",
		"Reviewer",
		"MergerAdvisor",
		"Fix",
	] as const) {
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


describe("default-agents: reviewer (Phase B) — canonical `Reviewer` registered", () => {
	it("registers the canonical `Reviewer` agent", () => {
		expect(DEFAULT_AGENTS.has("Reviewer")).toBe(true);
	});

	it("does NOT register `software-reviewer` (GC-2026-014: legacy alias removed)", () => {
		// The Phase B alias was dropped in GC-2026-014 along with the
		// AgentConfig.aliases field.
		expect(DEFAULT_AGENTS.has("software-reviewer")).toBe(false);
	});
});

// GC-2026-merger-advisor-split: MergerAdvisor is the workflow_run Merge-phase
// advisor. Distinct from the DAG-synthesis Merger (which is auto-merge).
describe("default-agents: MergerAdvisor (workflow_run Merge phase advisor)", () => {
	it("registers the canonical `MergerAdvisor` agent", () => {
		expect(DEFAULT_AGENTS.has("MergerAdvisor")).toBe(true);
	});

	it("has displayName 'Merger (Advisor)' and description referencing workflow_run advisory merge", () => {
		const advisor = DEFAULT_AGENTS.get("MergerAdvisor");
		expect(advisor?.displayName).toBe("Merger (Advisor)");
		expect(advisor?.description.toLowerCase()).toContain("advisory");
		expect(advisor?.description).toContain("merge-recommendation.md");
	});

	it("uses MERGER_ADVISOR_PROMPT (the workflow_run advisory merge prompt)", () => {
		const advisor = DEFAULT_AGENTS.get("MergerAdvisor");
		expect(advisor?.systemPrompt).toContain("Merger (Advisor)");
		// Distinct from the legacy DAG-synthesis MERGER_PROMPT which
		// started with "Merger, a deterministic cross-workspace merge
		// agent". After GC-2026-merger-retirement, only MergerAdvisor
		// exists — the legacy prompt is gone.
		expect(advisor?.systemPrompt).not.toContain("deterministic cross-workspace");
	});
});

describe("default-agents: reviewer config", () => {
	const aud = DEFAULT_AGENTS.get("Reviewer");

	it("is registered with isDefault: true", () => {
		expect(aud?.isDefault).toBe(true);
	});

	it("has displayName 'Reviewer' and description referencing the review discipline", () => {
		expect(aud?.displayName).toBe("Reviewer");
		expect(aud?.description.toLowerCase()).toContain("review");
		// Default verdict stance is part of the public contract.
		expect(aud?.description.toLowerCase()).toContain("needs_work");
	});

	it("uses promptMode: 'replace' so the canonical prompt replaces the parent identity", () => {
		expect(aud?.promptMode).toBe("replace");
	});

	it("carries the canonical system prompt (non-empty, references all three verdicts)", () => {
		expect(typeof aud?.systemPrompt).toBe("string");
		expect(aud?.systemPrompt.length).toBeGreaterThan(0);
		expect(aud?.systemPrompt).toContain("CLEAN");
		expect(aud?.systemPrompt).toContain("NEEDS_WORK");
	});

	it("lists the same required built-in tools as developer (read, bash, grep, find, ls, edit, write)", () => {
		// The reviewer shares developer's tool set: edit/write are present
		// for the single allowed write target (the review-{task_id}.md
		// report). The "verify only / no production edits" rule lives
		// in the prompt, not in the tool allowlist.
		const tools = new Set(aud?.builtinToolNames ?? []);
		for (const t of ["read", "bash", "grep", "find", "ls", "edit", "write"]) {
			expect(tools.has(t), `reviewer must include tool ${t}`).toBe(true);
		}
	});

	it("carries the required extensions: aft-pi, pi-mcp-adapter", () => {
		// Symmetric with developer. The reviewer prompt's tool preference
		// order relies on these extensions being loaded.
		//
		// GC-2026-prompt-parser-contract-cleanup: use the canonical
		// `aft-pi` name (see the matching Developer-config test).
		const extensions = aud?.extensions;
		expect(extensions).not.toBe(false);
		const list =
			extensions === true || extensions === undefined ? null : extensions;
		expect(list, "reviewer must pin extensions to a list").not.toBeNull();
		expect(list).toContain("aft-pi");
		expect(list).toContain("pi-mcp-adapter");
		expect(list).not.toContain("aft");
		expect(list).not.toContain("pi-magic-context");
	});

	it("disables skills (false) — reviewer re-derives conventions at audit time per First Action Protocol", () => {
		expect(aud?.skills).toBe(false);
	});

	it("defaults runInBackground to true (audits re-run every verification and must not block)", () => {
		expect(aud?.runInBackground).toBe(true);
	});


	it("does NOT copy the legacy `isolation: 'worktree'` literal — reviewer is read-only on the developer's worktree", () => {
		// The reviewer never enters a managed worktree; it audits the
		// developer's worktree from the outside. `enforceDeveloperManagedIsolationPolicy`
		// is `developer`-only.
		expect(aud?.isolation).toBeUndefined();
	});

	it("does NOT carry a `software-reviewer` alias (GC-2026-014: aliases field removed from AgentConfig)", () => {
		// The AgentConfig.aliases field was dropped entirely in GC-2026-014.
		expect(aud?.aliases).toBeUndefined();
	});
});

describe("default-agents: reviewer subagent isolation", () => {
	// Symmetric with developer: the reviewer also pins
	// `excludeExtensions: ["pi-subagents"]` so the Agent tool cannot
	// load by accident. The auditor's purpose is verify-only — letting
	// it spawn further Agent calls would defeat the audit invariant.
	it("reviewer excludes pi-subagents from its extension set", () => {
		const config = DEFAULT_AGENTS.get("Reviewer");
		expect(
			config,
			"reviewer must be registered as a default agent",
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
 * can see; maxTurns pins the cost (model + thinking were
 * removed in GC-2026-subagent-model-inheritance — PlanCompiler now
 * inherits the parent session's model).
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
		expect(plan?.displayName).toBe("PlanCompiler");
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
		// aft / pi-mcp-adapter and let Plan run the full architecture
		// scan. Flip to false so Plan cannot reach those tools even if
		// the prompt drifted. (pi-magic-context is also absent — and
		// removed entirely from pi-subagents as of
		// GC-2026-remove-magic-context.)
		expect(plan?.extensions).toBe(false);
	});

	it("disables skills (false)", () => {
		expect(plan?.skills).toBe(false);
	});

	it("GC-2026-subagent-model-inheritance: Plan inherits parent model (no hardcoded pin)", () => {
		// GC-2026-subagent-model-inheritance removes the model pin.
		// Users who want PlanCompiler on a cheap model can pin it via
		// subagents.json#defaultModelsByType["PlanCompiler"]; the
		// default is to inherit whatever the main agent uses.
		expect(plan?.model).toBeUndefined();
	});

	it("GC-2026-subagent-model-inheritance: Plan no longer hardcodes thinking", () => {
		expect(plan?.thinking).toBeUndefined();
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

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

	it("carries the required extensions: aft, pi-mcp-adapter, magic-context", () => {
		// `extensions` is the loader-level selector; it must include all three
		// required extensions by canonical name so they load into the agent.
		const extensions = dev?.extensions;
		expect(extensions).not.toBe(false);
		const list =
			extensions === true || extensions === undefined ? null : extensions;
		expect(list, "developer must pin extensions to a list").not.toBeNull();
		expect(list).toContain("aft");
		expect(list).toContain("pi-mcp-adapter");
		expect(list).toContain("magic-context");
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

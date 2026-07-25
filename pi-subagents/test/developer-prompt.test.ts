/**
 * developer-prompt.test.ts — Content invariants of the developer prompt module.
 *
 * Phase A P1 (DAG-2026-011): the Sages software-developer role is migrated
 * into a dedicated prompt module under pi-subagents/src/agent-prompts/.
 * This file pins the **semantic invariants** every consumer can rely on,
 * not the prose. The prose is allowed to evolve; the invariants are not.
 *
 * Required content (per Phase A P1 spec):
 *   - RED → GREEN → REFACTOR cycle
 *   - First-action protocol (AGENTS.md / README / CLAUDE.md discovery)
 *   - Conventional Commits + author rules (no --author, no GIT_AUTHOR_*)
 *   - Write tools (read/edit/write, semantically)
 *   - Required extensions (aft, pi-mcp-adapter, magic-context) — encoded
 *     at the config layer, but the prompt must reference the loader
 *     behavior so the agent knows what extensions it inherits.
 *   - Background self-contained behavior (no synchronous user interaction)
 *   - Original-repo protection (worktree isolation keeps changes off the
 *     orchestrator's main branch)
 *   - No `.pi/orchestrator` writes (Sages meta-files are off-limits)
 */

import { describe, expect, it } from "vitest";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";

describe("developer-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof DEVELOPER_PROMPT).toBe("string");
		expect(DEVELOPER_PROMPT.length).toBeGreaterThan(1000);
	});

	it("documents the RED → GREEN → REFACTOR cycle", () => {
		expect(DEVELOPER_PROMPT).toMatch(/RED/i);
		expect(DEVELOPER_PROMPT).toMatch(/GREEN/i);
		expect(DEVELOPER_PROMPT).toMatch(/REFACTOR/i);
	});

	it("documents the first-action protocol (AGENTS.md / README / CLAUDE.md discovery)", () => {
		expect(DEVELOPER_PROMPT).toContain("AGENTS.md");
		expect(DEVELOPER_PROMPT).toContain("README.md");
		expect(DEVELOPER_PROMPT).toContain("CLAUDE.md");
	});

	it("documents Conventional Commits", () => {
		expect(DEVELOPER_PROMPT).toMatch(/Conventional Commits/i);
		expect(DEVELOPER_PROMPT).toMatch(/<type>\[optional scope\]/);
	});

	it("forbids the legacy author-override footguns (--author, git -c user.*, GIT_AUTHOR_*)", () => {
		expect(DEVELOPER_PROMPT).toContain("--author");
		expect(DEVELOPER_PROMPT).toContain("GIT_AUTHOR");
	});

	it("references the write tools (edit / write) and forbids drive-by refactors", () => {
		expect(DEVELOPER_PROMPT).toMatch(/\bedit\b/);
		expect(DEVELOPER_PROMPT).toMatch(/\bwrite\b/);
		expect(DEVELOPER_PROMPT.toLowerCase()).toContain("drive-by");
	});

	it("documents background self-contained behavior (no sync with the user)", () => {
		// The prompt must encode that the developer agent is spawned with
		// run_in_background: true and must NOT depend on synchronous user
		// interaction. The Sages role text mentions `run_in_background: true`
		// and the orchestrator relaying feedback via steer_subagent.
		expect(DEVELOPER_PROMPT).toContain("run_in_background");
		expect(DEVELOPER_PROMPT).toMatch(/steer_subagent/);
	});

	it("forbids writes under .pi/orchestrator/ (Sages meta-files are off-limits)", () => {
		expect(DEVELOPER_PROMPT).toContain(".pi/orchestrator");
	});

	it("documents worktree-based isolation keeping changes off the orchestrator's main branch", () => {
		// The original-repo protection invariant: changes land on a managed
		// worktree branch, not on the orchestrator's main branch. The prompt
		// must reference this so the agent never edits the parent repo.
		expect(DEVELOPER_PROMPT).toMatch(/worktree/i);
		expect(DEVELOPER_PROMPT).toMatch(/branch/i);
	});
});

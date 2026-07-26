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

describe("developer-prompt: tool preference order (GC-2026-012)", () => {
	// The developer prompt must publish an explicit tool preference order so
	// the subagent reaches for indexed semantic tools (AFT, MCP, Magic Context)
	// and `todowrite` before falling back to bash / read. This pins the L2
	// dispatch discipline into the prompt itself.

	function sectionIndex(name: string): number {
		// Section header is `## ... <name>` on its own line. Returns the byte
		// offset of the heading line, or -1 if absent.
		const re = new RegExp(`^##\\s+.*${name}.*$`, "m");
		const m = DEVELOPER_PROMPT.match(re);
		return m?.index ?? -1;
	}

	it("declares a 'Tool preference order' section", () => {
		const idx = sectionIndex("Tool preference order");
		expect(
			idx,
			"section 'Tool preference order' must exist",
		).toBeGreaterThanOrEqual(0);
	});

	it("'Tool preference order' is positioned BEFORE 'First Action Protocol'", () => {
		const toolIdx = sectionIndex("Tool preference order");
		const protoIdx = sectionIndex("First Action Protocol");
		expect(toolIdx).toBeGreaterThanOrEqual(0);
		expect(protoIdx).toBeGreaterThanOrEqual(0);
		expect(
			toolIdx,
			"'Tool preference order' must precede 'First Action Protocol'",
		).toBeLessThan(protoIdx);
	});

	it("lists AFT, MCP, and todowrite in the preference order", () => {
		const idx = sectionIndex("Tool preference order");
		expect(idx).toBeGreaterThanOrEqual(0);
		const after = DEVELOPER_PROMPT.slice(idx);
		const nextMatch = after.slice(2).match(/^##\\s/m);
		const endIdxInner =
			nextMatch?.index === undefined ? after.length : nextMatch.index + 2;
		const section = after.slice(0, endIdxInner);
		// Each tool must be present in the section.
		expect(section, "section must name AFT tools (aft_*)").toMatch(/aft_\\*/);
		expect(section, "section must name codebase_memory MCP tools").toMatch(
			/codebase_memory_\\*/,
		);
		expect(section, "section must name todowrite").toMatch(/todowrite/);
		expect(
			section,
			"section must name bash as a lower-preference tool",
		).toMatch(/bash/);
		expect(
			section,
			"section must name read as a lower-preference file-read tool",
		).toMatch(/read/);
		// Numbered list ordering: AFT (1) -> MCP (2) -> ... -> bash (6).
		// The list-item headings carry the priority semantics (AFT/MCP/
		// todowrite precede bash and read).
		const aftItem = section.match(/^1\.\s+\*\*AFT/m)?.index;
		const mcpItem = section.match(/^2\.\s+\*\*MCP/m)?.index;
		const todowriteItem = section.match(/^4\.\s+\*\*`?todowrite`?/m)?.index;
		const readItem = section.match(/^5\.\s+\*\*`?read`?/m)?.index;
		const bashItem = section.match(/^6\.\s+\*\*`?bash`?/m)?.index;
		expect(typeof aftItem, "must start with AFT as list item 1").toBe("number");
		expect(typeof mcpItem, "MCP must be list item 2").toBe("number");
		expect(typeof todowriteItem, "todowrite must be list item 4").toBe(
			"number",
		);
		expect(typeof readItem, "read must be list item 5").toBe("number");
		expect(typeof bashItem, "bash must be list item 6").toBe("number");
		// AFT (1) -> MCP (2) -> todowrite (4) -> read (5) -> bash (6). Use an
		// ordering array to avoid non-null assertions (biome noNonNullAssertion).
		const order: ReadonlyArray<number | undefined> = [
			aftItem,
			mcpItem,
			todowriteItem,
			readItem,
			bashItem,
		];
		for (let i = 1; i < order.length; i++) {
			expect(
				(order[i - 1] ?? 0) < (order[i] ?? 0),
				`priority ordering breaks at index ${i}`,
			).toBe(true);
		}
	});
});

describe("developer-prompt: codebase_memory MCP tool family (post-64eecc5/7b5deeb)", () => {
	// The developer prompt must reference the modern MCP tool family
	// (codebase_memory*) - not the retired codebase_search / codebase_refs
	// names from the pre-MCP pi-codebase-memory API. References:
	//   - commit 64eecc5 (explore/plan migration)
	//   - commit 7b5deeb (decouple explore/plan prompts)
	it("documents the codebase_memory MCP tool family (search_graph + trace_path)", () => {
		expect(DEVELOPER_PROMPT).toMatch(/codebase_memory_search_graph/);
		expect(DEVELOPER_PROMPT).toMatch(/codebase_memory_trace_path/);
	});

	it("does NOT reference retired codebase_search / codebase_refs (now codebase_memory*)", () => {
		// Word-boundary check: codebase_memory_search* is a different prefix
		// and must not trigger. The intent is to catch the *bare* stale names.
		expect(DEVELOPER_PROMPT).not.toMatch(/\bcodebase_search\b/);
		expect(DEVELOPER_PROMPT).not.toMatch(/\bcodebase_refs\b/);
	});
});


/**
 * auditor-prompt.test.ts — Content invariants of the auditor prompt module.
 *
 * The canonical `auditor` prompt is embedded as a built-in in
 * `pi-subagents/src/agent-prompts/auditor.ts`. This file pins the
 * **semantic invariants** every consumer can rely on, not the prose.
 * The prose is allowed to evolve; the invariants are not.
 *
 * GC-2026-014: the `software-auditor` legacy alias was removed — the
 * canonical name is `auditor` now. The test focuses on the prompt's
 * behavioural contracts, which are independent of the alias rename.
 *
 * Required content:
 *   - Three verdicts (CERTIFIED / NEEDS WORK / BLOCKED) named explicitly
 *   - Default-verdict stance: "default to NEEDS WORK" is the auditor's
 *     starting position; flipping to CERTIFIED requires overwhelming proof
 *   - First-action protocol (AGENTS.md / README / CLAUDE.md discovery)
 *   - Re-run every verification command (never trust the developer's report)
 *   - TDD discipline check (RED → GREEN → REFACTOR; tests written first)
 *   - "Verify only" — no production edits, single allowed write target
 *     is `.pi/orchestrator/audit-{task_id}.md`
 *   - Semantic tool preference (AFT / MCP / Magic Context) over bash grep
 *   - Required extensions (aft, pi-mcp-adapter, magic-context) referenced
 *     so the agent knows what extensions it inherits
 *   - Background self-contained behavior (run_in_background: true)
 *   - Automatic FAIL triggers (drive-by refactoring, no todowrite, etc.)
 *   - Structured audit report template with PASS/FAIL per SC
 */

import { describe, expect, it } from "vitest";
import { AUDITOR_PROMPT } from "../src/agent-prompts/auditor.js";

describe("auditor-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof AUDITOR_PROMPT).toBe("string");
		expect(AUDITOR_PROMPT.length).toBeGreaterThan(1000);
	});

	it("names all three verdicts explicitly", () => {
		// The orchestrator's `parseAuditReport` regex looks for the
		// `## Final Verdict` anchor + a `**CERTIFIED**` / `**NEEDS WORK**`
		// / `**BLOCKED**` marker. All three strings must appear in the
		// prompt (the template uses all three) so a future prose edit
		// that drops one of them surfaces here.
		expect(AUDITOR_PROMPT).toContain("CERTIFIED");
		expect(AUDITOR_PROMPT).toContain("NEEDS WORK");
		expect(AUDITOR_PROMPT).toContain("BLOCKED");
	});

	it("documents the default-verdict stance (NEEDS WORK unless overwhelming proof)", () => {
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(/default to.*needs work/);
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(/overwhelming.*proof/);
	});

	it("documents the first-action protocol (AGENTS.md / README / CLAUDE.md discovery)", () => {
		expect(AUDITOR_PROMPT).toContain("AGENTS.md");
		expect(AUDITOR_PROMPT).toContain("README.md");
		expect(AUDITOR_PROMPT).toContain("CLAUDE.md");
	});

	it("requires re-running every verification command (no trust in developer's report)", () => {
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(/re-run.*every.*verification/);
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(
			/never trust.*developer.*report/,
		);
	});

	it("verifies TDD discipline (RED → GREEN → REFACTOR; tests written first)", () => {
		expect(AUDITOR_PROMPT).toMatch(/RED/i);
		expect(AUDITOR_PROMPT).toMatch(/GREEN/i);
		expect(AUDITOR_PROMPT).toMatch(/REFACTOR/i);
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(
			/tests? (written|first).*first/,
		);
	});

	it("enforces 'verify only' — no production edits, single allowed write target", () => {
		expect(AUDITOR_PROMPT.toLowerCase()).toContain("verify only");
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(
			/no.*(editing|modif).*production/,
		);
		// The audit file path is the single allowed write target.
		expect(AUDITOR_PROMPT).toContain("audit-{task_id}.md");
	});

	it("forbids writing Sages meta-files other than the audit report", () => {
		// The orchestrator owns `.pi/orchestrator/{goal,dag,state,designs}/*`.
		// The auditor must NOT write to those — the prompt must surface the
		// boundary so a future prose edit doesn't accidentally re-open it.
		expect(AUDITOR_PROMPT).toContain(".pi/orchestrator");
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(
			/other than.*audit|never write to.*\.pi\/orchestrator/i,
		);
	});

	it("references the AFT extension (the preferred semantic-search tool)", () => {
		expect(AUDITOR_PROMPT.toLowerCase()).toContain("aft");
		expect(AUDITOR_PROMPT).toContain("aft_search");
	});

	it("references the codebase_memory MCP tool family (post-64eecc5/7b5deeb)", () => {
		expect(AUDITOR_PROMPT).toMatch(/codebase_memory_search_graph/);
		expect(AUDITOR_PROMPT).toMatch(/codebase_memory_trace_path/);
	});

	it("does NOT reference retired codebase_search / codebase_refs (now codebase_memory*)", () => {
		expect(AUDITOR_PROMPT).not.toMatch(/\bcodebase_search\b/);
		expect(AUDITOR_PROMPT).not.toMatch(/\bcodebase_refs\b/);
	});

	it("documents background self-contained behavior (run_in_background: true)", () => {
		expect(AUDITOR_PROMPT).toContain("run_in_background");
		// Background audits do not block the orchestrator.
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(
			/(do not|doesn't|don't).*block/,
		);
	});

	it("flags drive-by refactoring as an automatic FAIL trigger", () => {
		expect(AUDITOR_PROMPT.toLowerCase()).toContain("drive-by refactoring");
	});

	it("includes the audit report template with PASS/FAIL per criterion", () => {
		expect(AUDITOR_PROMPT).toContain("## Final Verdict");
		expect(AUDITOR_PROMPT).toContain("Status**: PASS / FAIL");
	});

	it("emits the final-output contract (VERDICT, AUDIT, EVIDENCE, CONCERNS)", () => {
		expect(AUDITOR_PROMPT).toContain("VERDICT:");
		expect(AUDITOR_PROMPT).toContain("AUDIT:");
		expect(AUDITOR_PROMPT).toContain("EVIDENCE:");
		expect(AUDITOR_PROMPT).toContain("CONCERNS:");
	});
});

describe("auditor-prompt: tool preference order (GC-2026-012 symmetry)", () => {
	// The auditor prompt must publish the same tool preference order as
	// the developer prompt — AFT → MCP → Magic Context → todowrite → read
	// → bash. This pins the L2 dispatch discipline into the auditor's
	// prompt and gives a "is the auditor reaching for AFT before bash?"
	// signal visible in the prose itself.

	function sectionIndex(name: string): number {
		const re = new RegExp(`^##\\s+.*${name}.*$`, "m");
		const m = AUDITOR_PROMPT.match(re);
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
		const after = AUDITOR_PROMPT.slice(idx);
		const nextMatch = after.slice(2).match(/^##\\s/m);
		const endIdxInner =
			nextMatch?.index === undefined ? after.length : nextMatch.index + 2;
		const section = after.slice(0, endIdxInner);
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

describe("auditor-prompt: MUST/forbidden language for tool preference (GC-2026-016)", () => {
	// Symmetric with developer-prompt. Audit showed the auditor ALSO
	// defaulted to bash grep / rg / find instead of AFT — pinning the
	// MUST/forbidden rule here so the auditor's prose can't drift back
	// to preference language.

	function sectionBody(name: string): string {
		const re = new RegExp(`^##\\s+.*${name}.*$`, "m");
		const m = AUDITOR_PROMPT.match(re);
		const idx = m?.index ?? -1;
		expect(idx).toBeGreaterThanOrEqual(0);
		const after = AUDITOR_PROMPT.slice(idx);
		const nextMatch = after.slice(2).match(/^##\s/m);
		const endIdxInner =
			nextMatch?.index === undefined ? after.length : nextMatch.index + 2;
		return after.slice(0, endIdxInner);
	}

	it("Tool preference order section carries MUST language", () => {
		const section = sectionBody("Tool preference order");
		expect(section, "section must use MUST/required/expected language").toMatch(
			/\bMUST\b/,
		);
	});

	it("Tool preference order section forbids bash code search (grep / rg / find / cat)", () => {
		const section = sectionBody("Tool preference order");
		expect(section, "section must explicitly forbid bash code search").toMatch(
			/FORBIDDEN|forbidden/i,
		);
	});

	it("First Action Protocol section treats parent-injected context as authoritative (GC-2026-016)", () => {
		// Symmetric with developer-prompt: with inherit_context=true
		// (GC-2026-016 default), the auditor MUST accept the parent's
		// project-context block as authoritative rather than re-reading
		// AGENTS.md / README.md / CLAUDE.md / package.json.
		const section = sectionBody("First Action Protocol");
		expect(section, "section must mention parent-injected context").toMatch(
			/parent[- ]injected|injected.*context/i,
		);
		expect(
			section,
			"section must tell the agent to NOT re-read AGENTS.md / README.md / CLAUDE.md",
		).toMatch(/DO NOT re-read|do not re-read/i);
	});
});

describe("auditor-prompt: 🔴/🟡/💭 priority scheme (GC-2026-039 T2)", () => {
	// The audit report template carries three priority buckets (code-reviewer
	// pattern from engineering-code-reviewer.md). The orchestrator's audit
	// reader relies on these headers for structured severity parsing — a
	// future prose edit that drops one of them surfaces here as a hard
	// regression.

	function sectionIndex(name: string): number {
		const re = new RegExp(`^##\\s+.*${name}.*$`, "m");
		const m = AUDITOR_PROMPT.match(re);
		return m?.index ?? -1;
	}

	function sectionBody(name: string): string {
		const re = new RegExp(`^##\\s+.*${name}.*$`, "m");
		const m = AUDITOR_PROMPT.match(re);
		const idx = m?.index ?? -1;
		expect(idx, `section '${name}' must exist`).toBeGreaterThanOrEqual(0);
		const after = AUDITOR_PROMPT.slice(idx);
		const nextMatch = after.slice(2).match(/^##\s/m);
		const endIdxInner =
			nextMatch?.index === undefined ? after.length : nextMatch.index + 2;
		return after.slice(0, endIdxInner);
	}

	it("Audit Report Template contains a 🔴 Blockers section", () => {
		expect(AUDITOR_PROMPT).toMatch(/^##\s+🔴\s+Blockers.*$/m);
	});

	it("Audit Report Template contains a 🟡 Suggestions section", () => {
		expect(AUDITOR_PROMPT).toMatch(/^##\s+🟡\s+Suggestions.*$/m);
	});

	it("Audit Report Template contains a 💭 Nits section", () => {
		expect(AUDITOR_PROMPT).toMatch(/^##\s+💭\s+Nits.*$/m);
	});

	it("priority sections appear in Blockers → Suggestions → Nits order", () => {
		const blockers = sectionIndex("🔴 Blockers");
		const suggestions = sectionIndex("🟡 Suggestions");
		const nits = sectionIndex("💭 Nits");
		expect(blockers).toBeGreaterThanOrEqual(0);
		expect(suggestions).toBeGreaterThanOrEqual(0);
		expect(nits).toBeGreaterThanOrEqual(0);
		expect(blockers, "Blockers must come before Suggestions").toBeLessThan(
			suggestions,
		);
		expect(suggestions, "Suggestions must come before Nits").toBeLessThan(nits);
	});

	it("per-issue template lists the six required fields", () => {
		// Each priority bucket's template enumerates the issue shape:
		// Description, Expected, Actual, Evidence, Fix instruction,
		// File(s) to modify. The orchestrator's report parser keys off
		// these labels.
		const blockersSection = sectionBody("🔴 Blockers");
		expect(blockersSection, "Blockers must define Description").toMatch(
			/Description:/,
		);
		expect(blockersSection, "Blockers must define Expected").toMatch(/Expected:/);
		expect(blockersSection, "Blockers must define Actual").toMatch(/Actual:/);
		expect(blockersSection, "Blockers must define Evidence").toMatch(/Evidence:/);
		expect(blockersSection, "Blockers must define Fix instruction").toMatch(
			/Fix instruction:/,
		);
		expect(blockersSection, "Blockers must define File(s) to modify").toMatch(
			/File\(s\) to modify:/,
		);
	});

	it("Blockers category list names Security, Correctness, Data loss (and adjacent risks)", () => {
		const section = sectionBody("🔴 Blockers");
		expect(section, "Blockers must list Security").toMatch(/Security/);
		expect(section, "Blockers must list Correctness").toMatch(/Correctness/);
		expect(section, "Blockers must list Data loss").toMatch(/Data loss/);
		expect(section, "Blockers must list Race/deadlock").toMatch(
			/Race\/?deadlock|Race condition/,
		);
	});

	it("Suggestions category list names missing validation / tests / perf / duplication", () => {
		const section = sectionBody("🟡 Suggestions");
		expect(section, "Suggestions must list Missing validation").toMatch(
			/[Mm]issing validation/,
		);
		expect(section, "Suggestions must list Missing tests").toMatch(
			/[Mm]issing tests/,
		);
		expect(section, "Suggestions must list Perf").toMatch(/[Pp]erf/);
		expect(section, "Suggestions must list Code duplication").toMatch(
			/[Cc]ode duplication/,
		);
	});

	it("Nits category list names style / naming / docs / alternative approaches", () => {
		const section = sectionBody("💭 Nits");
		expect(section, "Nits must list Style inconsistency").toMatch(/[Ss]tyle/);
		expect(section, "Nits must list Minor naming").toMatch(/[Nn]aming/);
		expect(section, "Nits must list Doc gap").toMatch(/[Dd]oc/);
		expect(section, "Nits must list Alternative approach").toMatch(
			/[Aa]lternative/,
		);
	});

	it("Communication Style mentions the priority markers consistently", () => {
		const section = sectionBody("Communication Style");
		expect(
			section,
			"Communication Style must reference priority markers",
		).toMatch(/🔴|🟡|💭/);
		// "one-line summaries" is the audit-friendly compression rule
		expect(
			section,
			"Communication Style must require one-line summaries",
		).toMatch(/[Oo]ne-?line/);
	});

	it("free-form Concerns section is preserved as escape hatch (regression)", () => {
		// The Concerns free-form list is kept AFTER the three priority
		// buckets so non-content findings (architectural concerns, HANDOFF
		// notes, future risks) still have a place. A future edit that
		// drops Concerns to make room for priorities surfaces here.
		expect(AUDITOR_PROMPT).toMatch(/^##\s+Concerns$/m);
	});

	it("priority buckets are positioned between Diff Inspection and Concerns", () => {
		const diffInspectionIdx = sectionIndex("Diff Inspection");
		const blockersIdx = sectionIndex("🔴 Blockers");
		const concernsIdx = sectionIndex("Concerns");
		expect(diffInspectionIdx).toBeGreaterThanOrEqual(0);
		expect(blockersIdx).toBeGreaterThanOrEqual(0);
		expect(concernsIdx).toBeGreaterThanOrEqual(0);
		expect(
			diffInspectionIdx,
			"Blockers must follow Diff Inspection",
		).toBeLessThan(blockersIdx);
		expect(
			blockersIdx,
			"Concerns must follow Blockers",
		).toBeLessThan(concernsIdx);
	});

	it("Automatic FAIL Triggers section is preserved (regression on overlap)", () => {
		// Process-violation triggers are complementary to per-issue content
		// findings. A future edit that conflates them (or drops Automatic
		// FAIL Triggers to make room for priorities) surfaces here.
		expect(AUDITOR_PROMPT).toMatch(/^##\s+🚫\s+Automatic FAIL Triggers.*$/m);
	});
});

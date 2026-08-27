/**
 * developer-prompt.test.ts — Content invariants of the developer prompt module.
 *
 * The canonical `developer` prompt is embedded as a built-in in
 * `pi-subagents/src/agent-prompts/developer.ts`. This file pins the
 * **semantic invariants** every consumer can rely on, not the prose.
 * The prose is allowed to evolve; the invariants are not.
 *
 * GC-2026-014: the `software-developer` legacy alias was removed — the
 * canonical name is `developer` now. The test focuses on the prompt's
 * behavioural contracts, which are independent of the alias rename.
 *
 * Required content:
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
	// and `todowrite` before falling back to bash / read. This pins the subagent
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

describe("developer-prompt: MUST/forbidden language for tool preference (GC-2026-016)", () => {
	// GC-2026-016: an audit of 78 historical sessions showed bash = 63% of
	// all tool calls while AFT = 0.06% and codebase_memory = 0%. Preference
	// language ("reach for", "use", "fine for") was being ignored by the
	// subagent LLM. The fix is to upgrade the prose to MUST / FORBIDDEN /
	// MUST NOT and pin the new invariant here so a future prose edit
	// doesn't silently re-soften the rule.

	function sectionBody(name: string): string {
		const re = new RegExp(`^##\\s+.*${name}.*$`, "m");
		const m = DEVELOPER_PROMPT.match(re);
		const idx = m?.index ?? -1;
		expect(idx).toBeGreaterThanOrEqual(0);
		const after = DEVELOPER_PROMPT.slice(idx);
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
		// AFT item (item 1) is the MANDATORY first choice — must be
		// positioned as the rule, not a preference.
		expect(section, "AFT item must carry MUST/mandatory language").toMatch(
			/\bMUST\b/,
		);
	});

	it("First Action Protocol section treats parent-injected context as authoritative (GC-2026-016)", () => {
		// GC-2026-016: inherit_context defaults to true, so the subagent
		// forks the parent's conversation. The First Action Protocol must
		// therefore tell the subagent to TRUST the parent-injected context
		// rather than re-derive AGENTS.md / README.md / CLAUDE.md /
		// package.json (audit showed this wasted 3–8 turns per spawn).
		const section = sectionBody("First Action Protocol");
		expect(section, "section must mention parent-injected context").toMatch(
			/parent[- ]injected|injected.*context/i,
		);
		// And must explicitly tell the agent NOT to re-read the conventions.
		expect(
			section,
			"section must tell the agent to NOT re-read AGENTS.md / README.md / CLAUDE.md",
		).toMatch(/DO NOT re-read|do not re-read/i);
	});
});

describe("developer-prompt: workspace + HANDOFF invariants (GC-2026-prompt-workspace)", () => {
	// Q2=b: a worktree is a workspace, not just an isolation boundary.
	// Q3=c: HANDOFF.md is the carrier across developer sessions on the
	// same workspace. Both ends of the protocol — read on entry + write
	// on exit — must be encoded in the developer prompt with MUST
	// language; skipping the read is an automatic audit failure.
	//
	// The canonical text is shared verbatim with `merger.ts` so the two
	// prompts cannot drift apart. The prose is allowed to evolve; the
	// invariants below are not.

	it("declares a 'Workspace Context' section header", () => {
		// The "Workspace Context" section sits between the First Action
		// Protocol and the Core Mission. It encodes the read-HANDOFF
		// half of the protocol (the developer side).
		const re = /^##\s+.*Workspace Context.*$/m;
		const m = DEVELOPER_PROMPT.match(re);
		expect(
			m?.index ?? -1,
			"'Workspace Context' section must exist",
		).toBeGreaterThanOrEqual(0);
	});

	it("declares a 'Workspace Output' section header", () => {
		// The "Workspace Output" section encodes the write-HANDOFF
		// half — what the developer writes on exit so a successor on
		// the same workspace can pick up cleanly.
		const re = /^##\s+.*Workspace Output.*$/m;
		const m = DEVELOPER_PROMPT.match(re);
		expect(
			m?.index ?? -1,
			"'Workspace Output' section must exist",
		).toBeGreaterThanOrEqual(0);
	});

	it("references the HANDOFF.md write path (.pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md)", () => {
		expect(DEVELOPER_PROMPT).toContain(
			".pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md",
		);
	});

	it("references the HANDOFF.md read path (.pi/orchestrator/handoff/<workspace_id>/)", () => {
		expect(DEVELOPER_PROMPT).toContain(
			".pi/orchestrator/handoff/<workspace_id>/",
		);
	});

	it("'Workspace Context' is positioned AFTER 'First Action Protocol' (extends it)", () => {
		// The Workspace Context section extends the First Action
		// Protocol (reading HANDOFF.md is the new step inserted into
		// the entry sequence). It must therefore come after the
		// existing First Action Protocol section.
		const protoIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*First Action Protocol.*$/m)?.index ?? -1;
		const ctxIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*Workspace Context.*$/m)?.index ?? -1;
		expect(protoIdx).toBeGreaterThanOrEqual(0);
		expect(ctxIdx).toBeGreaterThanOrEqual(0);
		expect(
			ctxIdx,
			"'Workspace Context' must come after 'First Action Protocol'",
		).toBeGreaterThan(protoIdx);
	});

	it("skipping read-HANDOFF is explicitly tied to 'automatic audit failure'", () => {
		// The developer prompt MUST surface the consequence (audit
		// failure) of skipping the HANDOFF read. This pins the
		// MUST-level language so a future prose edit doesn't soften
		// it back to "consider reading".
		expect(DEVELOPER_PROMPT.toLowerCase()).toContain("automatic audit failure");
		// And the audit-failure language must appear in the Workspace
		// Context section, not somewhere unrelated.
		const ctxIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*Workspace Context.*$/m)?.index ?? -1;
		expect(ctxIdx).toBeGreaterThanOrEqual(0);
		const after = DEVELOPER_PROMPT.slice(ctxIdx);
		const nextSection = after.slice(2).match(/^##\s/m);
		const endIdx =
			nextSection?.index === undefined ? after.length : nextSection.index + 2;
		const section = after.slice(0, endIdx).toLowerCase();
		expect(
			section,
			"audit-failure language must be inside 'Workspace Context'",
		).toContain("automatic audit failure");
	});

	it("'Workspace Output' section lists the (a)-(e) HANDOFF contents (summary, modified files, TODOs, test status, questions)", () => {
		// The HANDOFF writer must include the five-part body so
		// successors can pick up cleanly. The prose is allowed to
		// rephrase, but all five labelled points must appear in the
		// section.
		const ctxIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*Workspace Output.*$/m)?.index ?? -1;
		expect(ctxIdx).toBeGreaterThanOrEqual(0);
		const after = DEVELOPER_PROMPT.slice(ctxIdx);
		const nextSection = after.slice(2).match(/^##\s/m);
		const endIdx =
			nextSection?.index === undefined ? after.length : nextSection.index + 2;
		const section = after.slice(0, endIdx).toLowerCase();
		expect(section, "must include task summary").toMatch(/summary/);
		expect(section, "must include modified files").toMatch(/modified/);
		expect(section, "must include TODOs for successor").toMatch(/todo/);
		expect(section, "must include test status").toMatch(/test status/);
		expect(section, "must include open questions").toMatch(/open question/);
	});
});

describe("developer-prompt: 3-template HANDOFF + minimal-change discipline (GC-2026-039)", () => {
	// GC-2026-039: integrate two agency-agents patterns into the developer
	// prompt.
	//
	//   1. NEXUS `strategy/coordination/handoff-templates.md` — the flat
	//      five-section HANDOFF body becomes three *named* templates
	//      (Standard / Phase Gate / Escalation) selected by the dispatch
	//      brief's `handoff_template` field. The MECHANISM is unchanged:
	//      same write path, same writer (developer), same reader
	//      (successor developer + merger), same lifecycle. Only the
	//      on-disk section shape is parameterized.
	//
	//   2. `engineering/engineering-minimal-change-engineer.md` — the
	//      Scope Self-Check pre-commit ritual and the "three similar
	//      lines beats a premature abstraction" guardrail, which give
	//      rule #4 ("no drive-by refactoring") concrete instruments.
	//
	// The canonical Handoff-protocol block is shared verbatim with
	// `merger.ts`; these invariants are the drift guard for the developer
	// half. The prose may evolve; the template names may not.

	function handoffProtocolIndex(): number {
		return DEVELOPER_PROMPT.match(/^##\s+Handoff protocol.*$/m)?.index ?? -1;
	}

	it("names all three HANDOFF templates (Standard / Phase Gate / Escalation)", () => {
		expect(DEVELOPER_PROMPT).toContain("### Template A — Standard");
		expect(DEVELOPER_PROMPT).toContain("### Template B — Phase Gate");
		expect(DEVELOPER_PROMPT).toContain("### Template C — Escalation");
	});

	it("places the three templates inside the Handoff protocol section", () => {
		// Anti-drift: the templates are the *body* of the handoff protocol,
		// not a free-floating appendix. They must appear after the section
		// heading so the merger's byte-identical copy stays coherent.
		const protoIdx = handoffProtocolIndex();
		expect(
			protoIdx,
			"'Handoff protocol' section must exist",
		).toBeGreaterThanOrEqual(0);
		for (const header of [
			"### Template A — Standard",
			"### Template B — Phase Gate",
			"### Template C — Escalation",
		]) {
			expect(
				DEVELOPER_PROMPT.indexOf(header),
				`${header} must sit inside the Handoff protocol section`,
			).toBeGreaterThan(protoIdx);
		}
	});

	it("documents the `handoff_template` dispatch-brief selector", () => {
		// Template selection is dispatch DATA, not agent inference — the
		// brief carries the field and the developer picks the matching
		// shape rather than inventing one.
		expect(DEVELOPER_PROMPT).toContain("handoff_template");
		expect(DEVELOPER_PROMPT).toContain('handoff_template: "phase-gate"');
		expect(DEVELOPER_PROMPT).toContain('handoff_template: "escalation"');
	});

	it("keeps the HANDOFF mechanism unchanged (path + audit-failure language)", () => {
		// Regression guard: parameterizing the section shape must NOT move
		// the write path, drop the ordered read-on-entry rule, or soften
		// the audit-failure consequence.
		const protoIdx = handoffProtocolIndex();
		expect(protoIdx).toBeGreaterThanOrEqual(0);
		const after = DEVELOPER_PROMPT.slice(protoIdx);
		const nextSection = after.slice(2).match(/^##\s/m);
		const endIdx =
			nextSection?.index === undefined ? after.length : nextSection.index + 2;
		const section = after.slice(0, endIdx);
		expect(section, "write path must stay in the protocol section").toContain(
			".pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md",
		);
		expect(section, "read-on-entry must stay ordered by task_id").toContain(
			"ordered by task_id",
		);
		expect(
			section.toLowerCase(),
			"skipping the read must stay an automatic audit failure",
		).toContain("automatic audit failure");
	});

	it("declares a 'Scope Self-Check' pre-commit ritual", () => {
		expect(DEVELOPER_PROMPT).toContain("Scope Self-Check");
		// The ritual is a section header, not a passing mention.
		expect(DEVELOPER_PROMPT).toMatch(/^##\s+.*Scope Self-Check.*$/m);
	});

	it("carries the 'three similar lines' anti-premature-abstraction guardrail", () => {
		// Case-insensitive: the guardrail opens a numbered rule, so the
		// prose capitalizes it ("Three similar lines ..."). Pin the whole
		// phrase so a future edit cannot keep the words while dropping the
		// rule.
		expect(DEVELOPER_PROMPT).toMatch(
			/three similar lines beats a premature abstraction/i,
		);
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

describe("developer-prompt: current-workspace isolation mode (GC-2026-017 P3)", () => {
	// GC-2026-017 P3: the developer prompt must acknowledge that the
	// agent may be dispatched with `isolation: "current-workspace"` —
	// running in the caller's cwd, no managed worktree, no isolated
	// branch. The dispatcher surfaces the mode in the spawn details;
	// the prompt must teach the agent to read that field and not assume
	// worktree semantics (HANDOFF.md protocol, branch naming, isolation
	// object shape) when in current-workspace mode.
	//
	// Two modes coexist:
	//   1. Managed worktree (default): isolation = { dag_id, task_id, mode }
	//   2. Current workspace (opt-in): isolation = "current-workspace"
	//
	// The prose is allowed to evolve; the three invariants below are not.

	it("mentions the 'current-workspace' mode literal", () => {
		// The prompt must surface the exact literal so the LLM matches
		// the spawn-details field. Bare mentions of "current workspace"
		// in prose are NOT enough — the agent has to recognize the
		// exact string the dispatcher emits.
		expect(DEVELOPER_PROMPT).toContain('"current-workspace"');
	});

	it("still documents worktree-based isolation (regression guard)", () => {
		// Anti-goal: the new mode must NOT remove the existing worktree
		// language — worktree is still the default and the prompt must
		// keep teaching it. Regression-guard the literal shape.
		expect(DEVELOPER_PROMPT).toMatch(/worktree/i);
		expect(DEVELOPER_PROMPT).toContain('mode: "create" | "reuse"');
		// The HANDOFF.md write path must still appear — the protocol
		// still applies in worktree mode.
		expect(DEVELOPER_PROMPT).toContain(
			".pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md",
		);
	});

	it("explicitly enumerates both modes (worktree + current-workspace)", () => {
		// The Workspace Context preamble must enumerate the two modes
		// as distinct items so the LLM cannot collapse them. We pin
		// the enumerated phrasing by requiring both anchor phrases
		// appear close together in the same section.
		expect(DEVELOPER_PROMPT).toContain("Managed worktree");
		expect(DEVELOPER_PROMPT).toContain("Current workspace");
		// The Workspace Context section must contain the enumeration.
		// Locate the section and verify both anchors land inside it.
		const ctxIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*Workspace Context.*$/m)?.index ?? -1;
		expect(ctxIdx).toBeGreaterThanOrEqual(0);
		const after = DEVELOPER_PROMPT.slice(ctxIdx);
		const nextSection = after.slice(2).match(/^##\s/m);
		const endIdx =
			nextSection?.index === undefined ? after.length : nextSection.index + 2;
		const section = after.slice(0, endIdx);
		expect(
			section,
			"Workspace Context must enumerate the Managed worktree mode",
		).toContain("Managed worktree");
		expect(
			section,
			"Workspace Context must enumerate the Current workspace mode",
		).toContain("Current workspace");
		expect(
			section,
			"Workspace Context must enumerate both modes via a numbered list",
		).toMatch(/^1\.\s+\*\*Managed worktree/m);
		expect(
			section,
			"Workspace Context must enumerate both modes via a numbered list",
		).toMatch(/^2\.\s+\*\*Current workspace/m);
	});
});

describe("developer-prompt: FIRST tool priorities (GC-2026-087 P2)", () => {
	// GC-2026-087 P2: audit showed subagents call baseline tools
	// (bash/read/edit/write) at 92.8% — AFT / codebase_memory / ctx_*
	// are loaded but ignored. Constitution tells the agent to prefer
	// them, but the rule lives too far down in the prompt. The fix
	// is a FIRST tool priorities section near the top — bullet
	// entries that the LLM cannot skip. Pin the section's presence
	// and entry count so a future prose edit cannot silently weaken
	// it back to buried prose.

	it("declares a 'FIRST tool priorities' section header", () => {
		expect(DEVELOPER_PROMPT).toMatch(/^##\s+FIRST tool priorities.*$/m);
	});

	it("FIRST tool priorities section sits between Identity and Tool preference order", () => {
		// The new section must be near the top — AFTER Identity (the
		// role section) and BEFORE the longer Tool preference order
		// prose. This positioning is what makes the preference
		// unmissable to the LLM.
		const identityIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*Your Identity.*$/m)?.index ?? -1;
		const firstIdx =
			DEVELOPER_PROMPT.match(/^##\s+FIRST tool priorities.*$/m)?.index ?? -1;
		const toolIdx = DEVELOPER_PROMPT.match(
			/^##\s+.*Tool preference order.*$/m,
		)?.index ?? -1;
		expect(identityIdx).toBeGreaterThanOrEqual(0);
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(toolIdx).toBeGreaterThanOrEqual(0);
		expect(
			firstIdx,
			"FIRST tool priorities must come AFTER Identity",
		).toBeGreaterThan(identityIdx);
		expect(
			firstIdx,
			"FIRST tool priorities must come BEFORE Tool preference order",
		).toBeLessThan(toolIdx);
	});

	it("includes at least 3 bullet entries (each '- **Task**: ...')", () => {
		expect(DEVELOPER_PROMPT).toContain("## FIRST tool priorities");
		const section =
			DEVELOPER_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ??
			"";
		const entries = section
			.split("\n")
			.filter((l) => l.trim().startsWith("- **"));
		expect(
			entries.length,
			`expected >= 3 bullet entries, got ${entries.length}`,
		).toBeGreaterThanOrEqual(3);
	});

	it("references AFT, codebase_memory, and ctx_ tool families in the section", () => {
		// The section must name all three indexed tool families so the
		// LLM has concrete tools to reach for — naming the families
		// without naming tools re-creates the buried-prose problem.
		expect(DEVELOPER_PROMPT).toContain("## FIRST tool priorities");
		const section =
			DEVELOPER_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ??
			"";
		expect(section, "must reference AFT").toMatch(/aft_/);
		expect(section, "must reference codebase_memory").toMatch(
			/codebase_memory/,
		);
		expect(section, "must reference ctx_").toMatch(/ctx_/);
	});
});

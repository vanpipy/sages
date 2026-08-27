/**
 * merger-prompt.test.ts — Content invariants of the merger prompt module.
 *
 * The canonical `merger` prompt is embedded as a built-in in
 * `pi-subagents/src/agent-prompts/merger.ts`. This file pins the
 * **semantic invariants** every consumer can rely on, not the prose.
 * The prose is allowed to evolve; the invariants are not.
 *
 * GC-2026-prompt-workspace: the merger sub-agent handles cross-workspace
 * file overlap detected at DAG synthesis. It is read-only on production
 * code (no `edit` / `write` tools), classifies overlap into three
 * categories (clean / disjoint-hunk / hunk-conflict), produces a merge
 * commit when feasible, and verifies the merged result via typecheck +
 * lint + the merged test suite.
 *
 * The canonical workflow description (Cross-workspace merging) is
 * shared verbatim with `developer.ts` (Workspace Context section) so
 * the two prompts cannot drift apart.
 *
 * Required content:
 *   - Non-empty string > 1000 chars
 *   - Identifies itself as a merger sub-agent
 *   - Names the three classifications: clean / disjoint-hunk / hunk-conflict
 *   - References merge, hunk, typecheck, lint
 *   - Carries the canonical "Cross-workspace merging" section header
 *   - Documents the tool set (read-only on production code)
 *   - Documents the hunk-conflict escalation path (NOT auto-resolved)
 *   - Documents the merge verification contract (typecheck + lint + test)
 *   - Documents the audit-merge-{task_id}.md output target
 */

import { describe, expect, it } from "vitest";
import { MERGER_PROMPT } from "../src/agent-prompts/merger.js";

describe("merger-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof MERGER_PROMPT).toBe("string");
		expect(MERGER_PROMPT.length).toBeGreaterThan(1000);
	});

	it("identifies itself as a merger sub-agent", () => {
		// Identity must surface in the heading so an LLM reading the
		// prompt can immediately recognize the role. Audit reads use
		// the same anchor to verify role identity.
		expect(MERGER_PROMPT.toLowerCase()).toMatch(
			/merger.*sub-agent|merger agent/,
		);
	});

	it("names all three overlap classifications (clean / disjoint-hunk / hunk-conflict)", () => {
		// The three classifications are the load-bearing taxonomy. A
		// future prose edit that drops one of them would silently
		// flatten the merger behaviour to a single path, which is
		// exactly the failure mode this pin prevents.
		expect(MERGER_PROMPT).toContain("clean");
		expect(MERGER_PROMPT).toContain("disjoint-hunk");
		expect(MERGER_PROMPT).toContain("hunk-conflict");
	});

	it("references merge, hunk, typecheck, and lint as load-bearing concepts", () => {
		expect(MERGER_PROMPT.toLowerCase()).toContain("merge");
		expect(MERGER_PROMPT.toLowerCase()).toContain("hunk");
		expect(MERGER_PROMPT.toLowerCase()).toContain("typecheck");
		expect(MERGER_PROMPT.toLowerCase()).toContain("lint");
	});

	it("declares a 'Cross-workspace merging' section header (canonical text anchor)", () => {
		// The canonical text in developer.ts §Cross-workspace merging
		// is byte-identical to the merger prompt's top-level section.
		// The § header is the anchor the consistency check reads.
		const re = /^##\s+.*Cross-workspace merging.*$/m;
		const m = MERGER_PROMPT.match(re);
		expect(
			m?.index ?? -1,
			"'Cross-workspace merging' section must exist",
		).toBeGreaterThanOrEqual(0);
	});

	it("hunk-conflict path is explicitly NOT auto-resolved", () => {
		// Hunk-conflicts on the same lines cannot be safely machine-
		// resolved. The merger MUST escalate, not auto-resolve. Pin
		// the negative phrasing here so a future contributor can't
		// quietly re-open it.
		const section = sectionBody("Cross-workspace merging");
		expect(section.toLowerCase()).toMatch(
			/not.*auto[- ]?resolve|not.*auto[- ]?resolved/i,
		);
	});

	it("documents the verification contract (typecheck + lint + test on merged state)", () => {
		// Merged verification runs on the cross-workspace result, NOT
		// on per-workspace tests. This pin surfaces the contract.
		const section = sectionBody("Cross-workspace merging");
		expect(section.toLowerCase()).toContain("typecheck");
		expect(section.toLowerCase()).toContain("lint");
		expect(section.toLowerCase()).toContain("test");
		// And it must say "merged" or "cross-workspace" to distinguish
		// from per-workspace tests.
		expect(section.toLowerCase()).toMatch(
			/merged.*test|cross[- ]workspace.*test/,
		);
	});

	it("includes Phase Gate documents carried forward guidance", () => {
		expect(MERGER_PROMPT).toContain("## Documents Carried Forward");
	});

	it("includes Phase Gate risks carried forward guidance", () => {
		expect(MERGER_PROMPT).toContain("## Risks Carried Forward");
	});

	it("documents the audit-merge-{task_id}.md output target", () => {
		// file, parallel to the auditor's audit-{task_id}.md. Future
		// prose edits that drop the path surface here.
		expect(MERGER_PROMPT).toContain("audit-merge-{task_id}.md");
	});

	it("documents read-only tool set on production code (no edit / write)", () => {
		// The merger produces commits via git plumbing (bash) — it
		// must NEVER call edit / write on production code. The prompt
		// must surface this so the registry's read-only tool list is
		// backed by the prose.
		expect(MERGER_PROMPT.toLowerCase()).toMatch(
			/no.*edit.*write|read[- ]only|read only/,
		);
		expect(MERGER_PROMPT.toLowerCase()).toContain("read");
		expect(MERGER_PROMPT.toLowerCase()).toContain("bash");
		expect(MERGER_PROMPT.toLowerCase()).toContain("grep");
		expect(MERGER_PROMPT.toLowerCase()).toContain("find");
		expect(MERGER_PROMPT.toLowerCase()).toContain("ls");
		// The negative phrasings — the registry test pins the same.
		expect(MERGER_PROMPT.toLowerCase()).toMatch(/no\s+`?edit`?|no\s+`?write`?/);
	});
});

describe("merger-prompt: cross-file consistency with developer.ts", () => {
	// The canonical text (Cross-workspace merging) is the same byte
	// sequence in developer.ts (Workspace Context section) and
	// merger.ts. If the two diverge, the orchestrator's audit cannot
	// reason about cross-workspace overlap coherently. Pin the
	// cross-prompt invariant.

	it("the canonical §Workspace/Handoff/Cross-workspace block is byte-identical across developer.ts and merger.ts", async () => {
		const { DEVELOPER_PROMPT } = await import(
			"../src/agent-prompts/developer.js"
		);
		// Canonical block boundary anchors: the shared text opens at
		// "## Workspace semantics" and closes at "...the **cross-workspace**
		// merge result." (the last line of §Cross-workspace merging).
		// Both files must carry the SAME byte sequence between these
		// anchors — if one drifts, the cross-prompt invariant breaks.
		const BLOCK_OPEN = "## Workspace semantics\n";
		const BLOCK_CLOSE_SUFFIX = "the **cross-workspace** merge result.";
		expect(DEVELOPER_PROMPT).toContain(BLOCK_OPEN);
		expect(MERGER_PROMPT).toContain(BLOCK_OPEN);

		function extractCanonicalBlock(prompt: string): string {
			const start = prompt.indexOf(BLOCK_OPEN);
			expect(start, "canonical block open must exist").toBeGreaterThanOrEqual(
				0,
			);
			const tail = prompt.slice(start);
			const end = tail.indexOf(BLOCK_CLOSE_SUFFIX);
			expect(end, "canonical block close must exist").toBeGreaterThanOrEqual(0);
			// +len so we keep the closing line itself in the slice.
			return tail.slice(0, end + BLOCK_CLOSE_SUFFIX.length);
		}

		const devBlock = extractCanonicalBlock(DEVELOPER_PROMPT);
		const merBlock = extractCanonicalBlock(MERGER_PROMPT);
		expect(
			devBlock,
			"developer.ts canonical block must byte-match merger.ts",
		).toBe(merBlock);
	});
});

// Helper: pull a section's body (between ## header and next ## header).
function sectionBody(name: string): string {
	const re = new RegExp(`^##\\s+.*${name}.*$`, "m");
	const m = MERGER_PROMPT.match(re);
	const idx = m?.index ?? -1;
	if (idx < 0) return "";
	const after = MERGER_PROMPT.slice(idx);
	const nextMatch = after.slice(2).match(/^##\s/m);
	const endIdxInner =
		nextMatch?.index === undefined ? after.length : nextMatch.index + 2;
	return after.slice(0, endIdxInner);
}

describe("merger-prompt: current-workspace isolation mode (GC-2026-017 P3)", () => {
	// GC-2026-017 P3: the merger prompt must acknowledge that the
	// workspaces it merges may be the result of a developer spawned
	// with `isolation: "current-workspace"`. The merger itself still
	// runs in a scratch worktree, but it must understand that the
	// source workspaces may be on non-isolated branches (the
	// orchestrator's main branch or the parent repo's currently
	// checked-out branch).
	//
	// The two-modes framing is added OUTSIDE the canonical
	// §Workspace/Handoff/Cross-workspace block so byte-identity with
	// developer.ts is preserved (see the cross-file consistency test
	// above).

	it("mentions the 'current-workspace' mode literal", () => {
		expect(MERGER_PROMPT).toContain('"current-workspace"');
	});

	it("declares a 'Workspace isolation modes' preamble that enumerates both modes", () => {
		const re = /^##\s+.*Workspace isolation modes.*$/m;
		const m = MERGER_PROMPT.match(re);
		expect(
			m?.index ?? -1,
			"'Workspace isolation modes' section must exist",
		).toBeGreaterThanOrEqual(0);
		const idx = m?.index ?? -1;
		const after = MERGER_PROMPT.slice(idx);
		const nextSection = after.slice(2).match(/^##\s/m);
		const endIdx =
			nextSection?.index === undefined ? after.length : nextSection.index + 2;
		const section = after.slice(0, endIdx);
		expect(
			section,
			"preamble must enumerate Managed worktree (default)",
		).toContain("Managed worktree");
		expect(
			section,
			"preamble must enumerate Current workspace (opt-in)",
		).toContain("Current workspace");
	});

	it("'Workspace isolation modes' is positioned BEFORE the canonical byte-identical block", () => {
		// The two-modes framing is preamble; it must precede the
		// canonical §Workspace semantics block whose byte-identity
		// with developer.ts is pinned by the cross-file test above.
		const preambleIdx =
			MERGER_PROMPT.match(/^##\s+.*Workspace isolation modes.*$/m)?.index ?? -1;
		const canonicalIdx = MERGER_PROMPT.indexOf("## Workspace semantics");
		expect(preambleIdx).toBeGreaterThanOrEqual(0);
		expect(canonicalIdx).toBeGreaterThanOrEqual(0);
		expect(
			preambleIdx,
			"'Workspace isolation modes' must precede the canonical block",
		).toBeLessThan(canonicalIdx);
	});
});

describe("merger-prompt: FIRST tool priorities (GC-2026-087 P2)", () => {
	// GC-2026-087 P2: the merger is read-only on production code,
	// so the default table applies minus edit/write. Two extra
	// rows for the merger's actual workload: (a) inspect diff
	// hunks with `read` against the worktree path; (b) classify
	// hunk overlap with `aft_outline` on both sides.

	it("declares a 'FIRST tool priorities' section header", () => {
		expect(MERGER_PROMPT).toMatch(/^##\s+FIRST tool priorities.*$/m);
	});

	it("FIRST tool priorities section sits between Identity and Tool set", () => {
		// Merger opens with identity, then "Tool set (read-only on
		// production code)" — FIRST tool priorities belongs between
		// them so the LLM sees the priority table before learning
		// the (read-only) tool list.
		const identityIdx =
			MERGER_PROMPT.match(/^##\s+.*Your Identity.*$/m)?.index ?? -1;
		const firstIdx =
			MERGER_PROMPT.match(/^##\s+FIRST tool priorities.*$/m)?.index ?? -1;
		const toolIdx =
			MERGER_PROMPT.match(/^##\s+.*Tool set.*$/m)?.index ?? -1;
		expect(identityIdx).toBeGreaterThanOrEqual(0);
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(toolIdx).toBeGreaterThanOrEqual(0);
		expect(
			firstIdx,
			"FIRST tool priorities must come AFTER Identity",
		).toBeGreaterThan(identityIdx);
		expect(
			firstIdx,
			"FIRST tool priorities must come BEFORE Tool set",
		).toBeLessThan(toolIdx);
	});

	it("includes at least 3 bullet entries (each '- **Task**: ...')", () => {
		expect(MERGER_PROMPT).toContain("## FIRST tool priorities");
		const section =
			MERGER_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ?? "";
		const entries = section
			.split("\n")
			.filter((l) => l.trim().startsWith("- **"));
		expect(
			entries.length,
			`expected >= 3 bullet entries, got ${entries.length}`,
		).toBeGreaterThanOrEqual(3);
	});

	it("mentions diff inspection with `read` and overlap classification with `aft_outline`", () => {
		// Two merger-specific entries:
		//   - inspect diff hunks → `read` (with worktree path)
		//   - classify hunk overlap → `aft_outline` on both sides
		// These are the merger's actual recurring calls; pinning them
		// here keeps the prompt load-bearing for the merger role.
		expect(MERGER_PROMPT).toContain("## FIRST tool priorities");
		const section =
			MERGER_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ?? "";
		expect(section, "must surface aft_outline for overlap classification").toMatch(
			/aft_outline/,
		);
		expect(section, "must surface read for diff inspection").toMatch(/`?read`?/);
	});
});

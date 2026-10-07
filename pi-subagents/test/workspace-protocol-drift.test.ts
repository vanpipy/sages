/**
 * workspace-protocol-drift.test.ts — Pins WORKSPACE_PROTOCOL_SECTION shape
 * and interpolation invariants (GC-2026-076 P1).
 *
 * After GC-2026-076 the §Workspace semantics + §Handoff protocol +
 * §Cross-workspace merging block lives as a single
 * WORKSPACE_PROTOCOL_SECTION constant exported from
 * `_workspace-protocol.ts`. The Developer and Fix prompts interpolate it
 * via template literal. This test pins:
 *   1. The constant itself exists, is non-empty, and carries the three
 *      section headers.
 *   2. Both DEVELOPER_PROMPT and DEVELOPER_FIX_PROMPT contain the
 *      canonical block at byte-identical offsets (cross-prompt
 *      consistency for the agents that share HANDOFF.md discipline).
 *
 * Covers: SC5.
 *
 * GC-2026-merger-retirement: the original cross-file consistency test
 * compared DEVELOPER_PROMPT against MERGER_PROMPT. After the legacy
 * cross-workspace Merger agent was retired, only Developer + Fix share
 * this protocol, so the comparison set is reduced accordingly.
 */

import { describe, expect, it } from "vitest";
import { WORKSPACE_PROTOCOL_SECTION } from "../src/agent-prompts/_workspace-protocol.js";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";
import { DEVELOPER_FIX_PROMPT } from "../src/agent-prompts/_fix.js";

describe("WORKSPACE_PROTOCOL_SECTION: shape (GC-2026-076 P1)", () => {
	it("is exported as a non-empty string", () => {
		expect(typeof WORKSPACE_PROTOCOL_SECTION).toBe("string");
		expect(WORKSPACE_PROTOCOL_SECTION.length).toBeGreaterThan(1000);
	});

	it("opens with '## Workspace semantics' (anchor for cross-file consistency)", () => {
		expect(
			WORKSPACE_PROTOCOL_SECTION.startsWith("## Workspace semantics\n"),
		).toBe(true);
	});

	it("closes with the §Cross-workspace merging tail (historical section)", () => {
		// After Merger retirement, this section is informational only (no
		// agent executes cross-workspace merging). Kept for context. The
		// closing substring anchors the byte-identity drift guard below.
		expect(WORKSPACE_PROTOCOL_SECTION).toContain(
			"the **cross-workspace** merge result.",
		);
	});

	it("carries the three section headers (Workspace semantics, Handoff protocol, Cross-workspace merging)", () => {
		expect(WORKSPACE_PROTOCOL_SECTION).toContain("## Workspace semantics");
		expect(WORKSPACE_PROTOCOL_SECTION).toContain("## Handoff protocol");
		expect(WORKSPACE_PROTOCOL_SECTION).toContain("## Cross-workspace merging");
	});

	it("carries all three HANDOFF templates (Standard / Phase Gate / Escalation)", () => {
		expect(WORKSPACE_PROTOCOL_SECTION).toContain("### Template A — Standard");
		expect(WORKSPACE_PROTOCOL_SECTION).toContain("### Template B — Phase Gate");
		expect(WORKSPACE_PROTOCOL_SECTION).toContain("### Template C — Escalation");
	});

	it("keeps the audit-failure language intact (load-bearing MUST)", () => {
		expect(WORKSPACE_PROTOCOL_SECTION.toLowerCase()).toContain(
			"automatic audit failure",
		);
	});
});

describe("WORKSPACE_PROTOCOL_SECTION: byte-identity across Developer + Fix prompts", () => {
	// After Merger retirement, the only cross-prompt consumers of
	// WORKSPACE_PROTOCOL_SECTION are Developer (implements tasks) and Fix
	// (post-Review patches). Both share HANDOFF.md discipline so their
	// canonical blocks must be byte-identical.

	const BLOCK_OPEN = "## Workspace semantics\n";
	const BLOCK_CLOSE_SUFFIX = "the **cross-workspace** merge result.";

	function extractCanonicalBlock(prompt: string): string {
		const start = prompt.indexOf(BLOCK_OPEN);
		expect(
			start,
			"canonical block open must exist in the prompt",
		).toBeGreaterThanOrEqual(0);
		const tail = prompt.slice(start);
		const end = tail.indexOf(BLOCK_CLOSE_SUFFIX);
		expect(
			end,
			"canonical block close must exist in the prompt",
		).toBeGreaterThanOrEqual(0);
		return tail.slice(0, end + BLOCK_CLOSE_SUFFIX.length);
	}

	it("DEVELOPER_PROMPT canonical block === DEVELOPER_FIX_PROMPT canonical block", () => {
		const devBlock = extractCanonicalBlock(DEVELOPER_PROMPT);
		const fixBlock = extractCanonicalBlock(DEVELOPER_FIX_PROMPT);
		expect(
			devBlock,
			"developer.ts and _fix.ts must share byte-identical canonical block",
		).toBe(fixBlock);
	});

	it("DEVELOPER_PROMPT canonical block === WORKSPACE_PROTOCOL_SECTION", () => {
		// The whole constant must land in the developer's runtime export
		// without mutation — if a future edit wraps or re-indents the
		// constant, this fires.
		expect(extractCanonicalBlock(DEVELOPER_PROMPT)).toBe(
			WORKSPACE_PROTOCOL_SECTION,
		);
	});

	it("DEVELOPER_FIX_PROMPT canonical block === WORKSPACE_PROTOCOL_SECTION", () => {
		expect(extractCanonicalBlock(DEVELOPER_FIX_PROMPT)).toBe(
			WORKSPACE_PROTOCOL_SECTION,
		);
	});
});

describe("WORKSPACE_PROTOCOL_SECTION: preserves preamble ordering", () => {
	// The Developer prompt's "🌳 Workspace Context" preamble sits BEFORE
	// the canonical block; the test below pins that ordering. After Merger
	// retirement the matching merger-side preamble test is gone.

	it("developer preamble ('🌳 Workspace Context') precedes the canonical block", () => {
		const preambleIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*🌳 Workspace Context.*$/m)?.index ?? -1;
		const canonicalIdx = DEVELOPER_PROMPT.indexOf("## Workspace semantics");
		expect(preambleIdx).toBeGreaterThanOrEqual(0);
		expect(canonicalIdx).toBeGreaterThanOrEqual(0);
		expect(
			preambleIdx,
			"'🌳 Workspace Context' must precede the canonical block",
		).toBeLessThan(canonicalIdx);
	});
});

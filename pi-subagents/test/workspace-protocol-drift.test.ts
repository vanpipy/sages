/**
 * workspace-protocol-drift.test.ts — Pins WORKSPACE_PROTOCOL_SECTION byte-
 * identity across the two prompts that interpolate it (GC-2026-076 P1).
 *
 * Before GC-2026-076 the §Workspace semantics + §Handoff protocol +
 * §Cross-workspace merging block lived as plain prose in both
 * developer.ts and merger.ts. The cross-file consistency was protected
 * only by a comment ("the two prompts MUST NOT drift") plus a test that
 * reached into both exports and compared byte slices.
 *
 * After GC-2026-076 the canonical block lives in a single
 * WORKSPACE_PROTOCOL_SECTION constant exported from
 * `_workspace-protocol.ts`. Both prompts interpolate it. This test
 * pins:
 *   1. The constant itself exists, is non-empty, and carries the three
 *      section headers.
 *   2. The DEVELOPER_PROMPT and MERGER_PROMPT runtime exports contain
 *      the canonical block at byte-identical offsets.
 *   3. The extraction marker (the block open / close anchors) match the
 *      shape the existing merger-prompt.test.ts cross-file consistency
 *      test already pins.
 *
 * Covers: SC5.
 */

import { describe, expect, it } from "vitest";
import { WORKSPACE_PROTOCOL_SECTION } from "../src/agent-prompts/_workspace-protocol.js";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";
import { MERGER_PROMPT } from "../src/agent-prompts/merger.js";

describe("WORKSPACE_PROTOCOL_SECTION: shape (GC-2026-076 P1)", () => {
	it("is exported as a non-empty string", () => {
		expect(typeof WORKSPACE_PROTOCOL_SECTION).toBe("string");
		expect(WORKSPACE_PROTOCOL_SECTION.length).toBeGreaterThan(1000);
	});

	it("opens with '## Workspace semantics' (anchor for cross-file consistency)", () => {
		// The merger-prompt.test.ts cross-file consistency test asserts
		// the canonical block opens with this exact byte sequence. The
		// extracted constant must preserve that contract.
		expect(
			WORKSPACE_PROTOCOL_SECTION.startsWith("## Workspace semantics\n"),
		).toBe(true);
	});

	it("closes with the §Cross-workspace merging tail", () => {
		// The cross-file consistency test asserts the canonical block
		// closes with this exact substring. The extracted constant must
		// preserve it verbatim.
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

describe("WORKSPACE_PROTOCOL_SECTION: byte-identity across DEVELOPER_PROMPT and MERGER_PROMPT", () => {
	// After extraction, both DEVELOPER_PROMPT and MERGER_PROMPT interpolate
	// the same constant. The byte slice starting with `## Workspace
	// semantics\n` and ending with `the **cross-workspace** merge result.`
	// MUST be byte-identical. If a future edit drifts the prose between
	// the two prompts, this test fires.
	//
	// The slice anchors mirror the existing merger-prompt.test.ts cross-
	// file consistency test (BLOCK_OPEN / BLOCK_CLOSE_SUFFIX) so the
	// new extraction stays coherent with the legacy contract.

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

	it("DEVELOPER_PROMPT canonical block === MERGER_PROMPT canonical block", () => {
		const devBlock = extractCanonicalBlock(DEVELOPER_PROMPT);
		const merBlock = extractCanonicalBlock(MERGER_PROMPT);
		expect(
			devBlock,
			"developer.ts and merger.ts must share byte-identical canonical block",
		).toBe(merBlock);
	});

	it("DEVELOPER_PROMPT canonical block === WORKSPACE_PROTOCOL_SECTION", () => {
		// The whole constant must land in the developer's runtime export
		// without mutation — if a future edit wraps or re-indents the
		// constant, this fires.
		expect(extractCanonicalBlock(DEVELOPER_PROMPT)).toBe(
			WORKSPACE_PROTOCOL_SECTION,
		);
	});

	it("MERGER_PROMPT canonical block === WORKSPACE_PROTOCOL_SECTION", () => {
		expect(extractCanonicalBlock(MERGER_PROMPT)).toBe(
			WORKSPACE_PROTOCOL_SECTION,
		);
	});
});

describe("WORKSPACE_PROTOCOL_SECTION: preserves current-workspace preamble ordering", () => {
	// The merger's `Workspace isolation modes` preamble sits BEFORE the
	// canonical block, and the cross-file test in merger-prompt.test.ts
	// pins that ordering. After extraction, the preamble is still in
	// MERGER_PROMPT (not in the constant), and the canonical block still
	// follows it. We re-pin the ordering here so the new extraction
	// doesn't accidentally move the preamble.

	it("merger preamble precedes the canonical block", () => {
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

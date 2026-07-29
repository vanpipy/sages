/**
 * Escape Window unit tests — the state machine + the bash-guard
 * policy split. The extension wiring (event listeners, appendEntry
 * notification) is exercised end-to-end by `install.test.sh` + the
 * orchestrator smoke test; this file pins the pure logic.
 */

import { describe, it, expect } from "bun:test";

import {
	applyLayer1EscapeAdd,
	applyLayer1Strip,
	createEscapeState,
	escapeNoteText,
	ESCAPE_RETRY_THRESHOLD,
	evaluateEscapeBash,
	openEscapeWindow,
} from "../src/escape-window.js";

// ─── State machine ──────────────────────────────────────────────────

describe("escape-window: state machine", () => {
	it("createEscapeState returns a fresh window-closed state", () => {
		const s = createEscapeState();
		expect(s.escapeMode).toBe(false);
		expect(s.toolErrorCount).toBe(0);
		expect(s.openedBy).toBeNull();
		expect(s.openedAt).toBeNull();
	});

	it("openEscapeWindow is idempotent — first open wins", () => {
		const s0 = createEscapeState();
		const r1 = openEscapeWindow(s0, "user-trigger");
		expect(r1.justOpened).toBe(true);
		expect(r1.state.escapeMode).toBe(true);
		expect(r1.state.openedBy).toBe("user-trigger");
		const r2 = openEscapeWindow(r1.state, "retry-threshold");
		// Re-opening is a no-op; the original reason is preserved.
		expect(r2.justOpened).toBe(false);
		expect(r2.state.openedBy).toBe("user-trigger");
	});

	it("openEscapeWindow records openedAt as a numeric epoch ms", () => {
		const before = Date.now();
		const { state } = openEscapeWindow(createEscapeState(), "user-trigger");
		const after = Date.now();
		expect(typeof state.openedAt).toBe("number");
		expect(state.openedAt!).toBeGreaterThanOrEqual(before);
		expect(state.openedAt!).toBeLessThanOrEqual(after);
	});
});

// ─── Toolset management (Layer 1) ───────────────────────────────────

describe("escape-window: Layer 1 (toolset)", () => {
	it("applyLayer1Strip uses a positive allowlist, not a mutation-tool denylist", () => {
		const fakeTools = ["read", "edit", "write", "aft_edit", "apply_patch", "mystery_mutate", "bash", "grep"];
		const active: string[] = [...fakeTools];
		const fakePi = {
			getActiveTools: () => active,
			setActiveTools: (next: string[]) => {
				active.length = 0;
				active.push(...next);
			},
		} as never;
		applyLayer1Strip(fakePi);
		expect(active).toEqual(["read", "bash", "grep"]);
	});

	it("applyLayer1Strip is idempotent — calling twice on a stripped set is a no-op", () => {
		const active: string[] = ["read", "bash"];
		const fakePi = {
			getActiveTools: () => active,
			setActiveTools: (next: string[]) => {
				active.length = 0;
				active.push(...next);
			},
		} as never;
		applyLayer1Strip(fakePi);
		applyLayer1Strip(fakePi);
		expect(active).toEqual(["read", "bash"]);
	});

	it("applyLayer1EscapeAdd cannot re-add mutation capabilities", () => {
		const active: string[] = ["read", "bash"];
		const fakePi = {
			getActiveTools: () => active,
			setActiveTools: (next: string[]) => {
				active.length = 0;
				active.push(...next);
			},
		} as never;
		applyLayer1EscapeAdd(fakePi);
		expect(active).toEqual(["read", "bash"]);
	});

	it("applyLayer1EscapeAdd strips pre-existing mutation capabilities", () => {
		const active: string[] = ["read", "edit", "write", "aft_edit", "apply_patch", "bash"];
		const fakePi = {
			getActiveTools: () => active,
			setActiveTools: (next: string[]) => {
				active.length = 0;
				active.push(...next);
			},
		} as never;
		applyLayer1EscapeAdd(fakePi);
		expect(active).toEqual(["read", "bash"]);
	});
});

// ─── Layer 2 policy split (bash) ────────────────────────────────────

describe("escape-window: Layer 2 (bash) policy split", () => {
	// Use cwd-relative paths because the underlying `canMainAgentWrite` rejects
	// absolute paths (different layer). The bash-guard's `isProductionTarget`
	// short-circuits on absolute paths; relative paths are the real test surface.
	const META = ".pi/orchestrator/goal-GC-001.yaml";
	const PROD = "src/foo.ts";

	it("read-only commands are always allowed", () => {
		const decision = evaluateEscapeBash("ls -la", "/Users/me/proj");
		expect(decision).toBeUndefined();
	});

	it("destructive commands (rm / mv / cp) are always denied, even in escape mode", () => {
		// GC-2026-015 follow-up: rm/mv/cp/unlink/rmdir are ALWAYS
		// denied regardless of target path (the destructive-invariant
		// shortcut in `shouldBlockBashCommand` returns before any
		// path check). The escape window's bypass does NOT override
		// this — the user must dispatch a `developer` subagent for
		// rm/mv/cp against either meta-files or production code.
		//
		// rm a meta-file — blocked (destructive, regardless of path).
		const okMeta = evaluateEscapeBash(`rm ${META}`, "/Users/me/proj");
		expect(okMeta).toBeDefined();
		expect(okMeta?.reason).toMatch(/destructive:/);
		// rm a production file — also blocked, same destructive reason.
		const blockProd = evaluateEscapeBash(`rm ${PROD}`, "/Users/me/proj");
		expect(blockProd).toBeDefined();
		expect(blockProd?.reason).toMatch(/destructive:/);
	});

	it("does not bypass non-destructive write policy", () => {
		const sed = evaluateEscapeBash(`sed -i 's/x/y/' ${PROD}`, "/Users/me/proj");
		expect(sed).toBeDefined();
		const redirect = evaluateEscapeBash(`echo hello > ${PROD}`, "/Users/me/proj");
		expect(redirect).toBeDefined();
		const findDel = evaluateEscapeBash(
			`find src -name '*.tmp' -delete`,
			"/Users/me/proj",
		);
		expect(findDel).toBeDefined();
	});

	it("'unknown' commands are still blocked (we don't trust them)", () => {
		// python3 -c is unknown — always blocked.
		const decision = evaluateEscapeBash(
			`python3 -c "import os; os.remove('${PROD}')"`,
			"/Users/me/proj",
		);
		expect(decision).toBeDefined();
	});
});

// ─── Note text ───────────────────────────────────────────────────────

describe("escape-window: note text", () => {
	it("escapeNoteText names the trigger reason and the timestamp", () => {
		const s = openEscapeWindow(createEscapeState(), "user-trigger").state;
		const text = escapeNoteText(s);
		expect(text).toContain("ESCAPE WINDOW OPEN");
		expect(text).toContain("user typed `escape-window`");
		expect(text).toContain("capability gate remains enforced");
	});

	it("escapeNoteText surfaces the retry-threshold reason when that fired", () => {
		const s = openEscapeWindow(createEscapeState(), "retry-threshold").state;
		const text = escapeNoteText(s);
		expect(text).toContain("ESCAPE WINDOW OPEN");
		expect(text).toContain(`tool error count crossed ${ESCAPE_RETRY_THRESHOLD}`);
	});
});

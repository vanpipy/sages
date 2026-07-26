/**
 * Tests for the file-gate: path-aware policy that allows the main
 * agent to write to Sages meta-files (`.pi/orchestrator/`, `pi/`,
 * `README.md`, `AGENTS.md`, `package.json`, etc.) but rejects writes
 * to production code (which must go through the Agent tool with a
 * `developer` subagent (with explicit managed-worktree isolation).
 *
 * RED phase: these tests fail until `file-gate.ts` is implemented.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	canMainAgentWrite,
	executeSagesEdit,
	executeSagesWrite,
	policyMessage,
} from "@/tools/file-gate.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "sages-filegate-test-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function parseResult(resp: any): any {
	return typeof resp.content[0].text === "string"
		? { text: resp.content[0].text, isError: resp.isError }
		: JSON.parse(resp.content[0].text);
}

describe("canMainAgentWrite", () => {
	describe("meta paths (allowed)", () => {
		const allowed = [
			// Sages runtime state
			".pi/orchestrator/goal-GC-1.yaml",
			".pi/orchestrator/dag-DAG-1.yaml",
			".pi/orchestrator/audit-P1.md",
			".pi/orchestrator/audit-workflow.md",
			".pi/orchestrator/audit-state-DAG-1.yaml",
			".pi/orchestrator/designs/2026-01-01-login.md",
			".pi/orchestrator/task-P1-report.md",
			// Sages own code
			"pi/src/extension.ts",
			"pi/src/tools/orchestrator/index.ts",
			"pi/src/services/file-service.ts",
			"pi/test/tools/orchestrator.test.ts",
			"pi/skills/orchestrator/SKILL.md",
			"pi/skills/brainstorming/SKILL.md",
			"pi/templates/SYSTEM.md",
			"pi/templates/SUBAGENTS.md",
			"pi/templates/agents/developer.md",
			"pi/templates/agent-tool-description.md",
			"pi/templates/subagents.json",
			"pi/scripts/install.sh",
			"pi/scripts/install.ps1",
			// Root meta
			"README.md",
			"AGENTS.md",
			"package.json",
			"tsconfig.json",
			".gitignore",
			".graphifyignore",
			".aft.jsonc",
			".aft.json",
			// Sibling subpackages (Sages monorepo)
			"pi-subagents/src/agent-runner.ts",
			"pi-subagents/src/agent-prompts/developer.ts",
			"pi-subagents/package.json",
			"pi-codebase-memory/src/index.ts",
			"pi-graphify/src/index.ts",
			"pi-evaluator/src/evaluator.py",
			"pi-minimax/src/index.ts",
			"pi-yunxiao/src/index.ts",
			"pi-yunxiao/README.md",
			"pi-yunxiao/AGENTS.md",
		];
		for (const p of allowed) {
			it(`allows ${p}`, () => {
				expect(canMainAgentWrite(p)).toBe(true);
			});
		}
	});

	describe("production code (denied)", () => {
		const denied = [
			// User code
			"src/index.ts",
			"src/auth/service.ts",
			"lib/foo.js",
			"app/main.tsx",
			"cmd/server/main.go",
			"internal/handler.go",
			"pkg/foo/bar.rs",
			// Test files at user-code locations
			"test/integration_test.ts",
			"tests/test_foo.py",
			// Random extension files at root
			"foo.ts",
			"main.py",
			"index.js",
			"handler.go",
			// Misc user files
			"README_user.md",
			"package.json.bak",
			"notes.md",
		];
		for (const p of denied) {
			it(`denies ${p}`, () => {
				expect(canMainAgentWrite(p)).toBe(false);
			});
		}
	});

	describe("path validation (denied)", () => {
		const bad = [
			"",                              // empty
			"..",                            // parent dir
			"../etc/passwd",                 // traversal
			"./../foo",                      // traversal
			"src/../src/x.ts",               // mid-path traversal
			"/etc/passwd",                   // absolute
			"~/config",                      // home
			"foo\0bar",                      // null byte
		];
		for (const p of bad) {
			it(`denies ${JSON.stringify(p)}`, () => {
				expect(canMainAgentWrite(p)).toBe(false);
			});
		}
	});
});

describe("policyMessage", () => {
	it("names the rejected path", () => {
		const msg = policyMessage("src/foo.ts");
		expect(msg).toContain("src/foo.ts");
	});

	it("points at the Agent tool + developer subagent", () => {
		const msg = policyMessage("src/foo.ts");
		expect(msg.toLowerCase()).toContain("agent");
		expect(msg.toLowerCase()).toContain("developer");
	});
});

describe("executeSagesWrite", () => {
	it("writes a meta-file when path is allowed", async () => {
		const resp = await executeSagesWrite(
			{ path: ".pi/orchestrator/goal-test.yaml", content: "id: GC-test\n" },
			{ cwd },
		);
		const r = parseResult(resp);
		expect(r.isError).toBeFalsy();
		expect(existsSync(join(cwd, ".pi/orchestrator/goal-test.yaml"))).toBe(true);
		expect(readFileSync(join(cwd, ".pi/orchestrator/goal-test.yaml"), "utf-8")).toBe("id: GC-test\n");
	});

	it("rejects a production-code path with isError + policy message", async () => {
		const resp = await executeSagesWrite(
			{ path: "src/foo.ts", content: "// should not be written" },
			{ cwd },
		);
		const r = parseResult(resp);
		expect(resp.isError).toBe(true);
		expect(r.text.toLowerCase()).toContain("agent");
		expect(r.text.toLowerCase()).toContain("developer");
		expect(existsSync(join(cwd, "src/foo.ts"))).toBe(false);
	});

	it("rejects a path-traversal attempt", async () => {
		const resp = await executeSagesWrite(
			{ path: "../etc/passwd", content: "x" },
			{ cwd },
		);
		expect(resp.isError).toBe(true);
	});

	it("rejects an absolute path", async () => {
		const resp = await executeSagesWrite(
			{ path: "/etc/passwd", content: "x" },
			{ cwd },
		);
		expect(resp.isError).toBe(true);
	});
});

describe("executeSagesEdit", () => {
	beforeEach(() => {
		mkdirSync(join(cwd, ".pi", "orchestrator"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "orchestrator", "goal-test.yaml"),
			"id: GC-test\ntitle: old\n",
			"utf-8",
		);
	});

	it("replaces oldText with newText on a meta-file", async () => {
		const resp = await executeSagesEdit(
			{
				path: ".pi/orchestrator/goal-test.yaml",
				oldText: "title: old",
				newText: "title: new",
			},
			{ cwd },
		);
		const r = parseResult(resp);
		expect(r.isError).toBeFalsy();
		const updated = readFileSync(join(cwd, ".pi/orchestrator/goal-test.yaml"), "utf-8");
		expect(updated).toContain("title: new");
		expect(updated).not.toContain("title: old");
	});

	it("rejects edit on production code", async () => {
		const resp = await executeSagesEdit(
			{
				path: "src/foo.ts",
				oldText: "x",
				newText: "y",
			},
			{ cwd },
		);
		expect(resp.isError).toBe(true);
	});

	it("returns isError if oldText is not found", async () => {
		const resp = await executeSagesEdit(
			{
				path: ".pi/orchestrator/goal-test.yaml",
				oldText: "title: nonexistent",
				newText: "title: new",
			},
			{ cwd },
		);
		expect(resp.isError).toBe(true);
	});

	// Regression test for the 2026-07-26 multi-line replace gotcha.
	// When oldText and newText have the SAME line count (1:1), the
	// in-tool replace is well-behaved. The IPC layer's tail-duplication
	// bug is documented in `executeSagesEdit`'s source comment and
	// triggers when newText is LONGER than oldText — outside this
	// tool's boundary. This test only verifies the in-tool contract.
	it("replaces multi-line oldText 1:1 (same line count)", async () => {
		writeFileSync(
			join(cwd, ".pi", "orchestrator", "multi-line.yaml"),
			"line-1\nline-2\nline-3\nline-4\n",
			"utf-8",
		);
		const resp = await executeSagesEdit(
			{
				path: ".pi/orchestrator/multi-line.yaml",
				oldText: "line-2\nline-3\nline-4",
				newText: "REPLACED-2\nREPLACED-3\nREPLACED-4",
			},
			{ cwd },
		);
		const r = parseResult(resp);
		expect(r.isError).toBeFalsy();
		const updated = readFileSync(
			join(cwd, ".pi", "orchestrator", "multi-line.yaml"),
			"utf-8",
		);
		// All three lines replaced in place, no other lines added/removed
		expect(updated).toBe("line-1\nREPLACED-2\nREPLACED-3\nREPLACED-4\n");
	});

	it("replaces only the FIRST occurrence of oldText", async () => {
		writeFileSync(
			join(cwd, ".pi", "orchestrator", "dup.yaml"),
			"foo\nfoo\nfoo\n",
			"utf-8",
		);
		const resp = await executeSagesEdit(
			{
				path: ".pi/orchestrator/dup.yaml",
				oldText: "foo",
				newText: "bar",
			},
			{ cwd },
		);
		const r = parseResult(resp);
		expect(r.isError).toBeFalsy();
		const updated = readFileSync(
			join(cwd, ".pi", "orchestrator", "dup.yaml"),
			"utf-8",
		);
		// String.prototype.replace with string first arg replaces only
		// the FIRST occurrence (would need a global regex / String.replaceAll
		// for multi-occurrence). Locking this in so callers don't expect
		// "edit all" semantics.
		expect(updated).toBe("bar\nfoo\nfoo\n");
	});
});

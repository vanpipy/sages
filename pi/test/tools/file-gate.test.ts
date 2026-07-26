/**
 * Tests for the file-gate: path-aware policy that decides whether
 * the main agent (or any subagent inheriting the bash-guard) can
 * write to a given path.
 *
 * After commit f7144b2 (2026-07-26), the file-gate is **policy only**:
 *   - `canMainAgentWrite(path)` returns true iff path is meta-file
 *     (`.pi/orchestrator/`, `pi/`, sibling subpackages under `pi-…`, root docs) and not
 *     production code (user `src/`, `test/`, `lib/`, `*.ts`, `*.py`, ...).
 *   - `policyMessage(path)` returns the human-readable explanation
 *     used by the bash-guard when a write is blocked.
 *
 * The LLM-facing tool surface (Layer 1) no longer exposes any direct
 * write tool — the bash-guard (Layer 2) is the only remaining
 * limb-side write enforcement. The main agent dispatches
 * `Agent({subagent_type: "general-purpose"})` (no isolation) for
 * meta-file edits and `Agent({subagent_type: "developer", isolation: {...}})`
 * (managed worktree) for production code.
 */

import { describe, it, expect } from "bun:test";
import { canMainAgentWrite, policyMessage } from "@/tools/file-gate.js";

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

	it("points at the Agent tool + general-purpose for meta-file edits", () => {
		const msg = policyMessage("src/foo.ts");
		expect(msg.toLowerCase()).toContain("agent");
		// Either general-purpose (meta) or developer (prod) is acceptable
		// in the policy text; for src/foo.ts (production) the message
		// must mention developer.
		expect(msg.toLowerCase()).toContain("developer");
	});

	it("mentions general-purpose as the meta-file subagent", () => {
		const msg = policyMessage("src/foo.ts");
		expect(msg).toContain("general-purpose");
	});

	it("lists the meta-path allowlist for general-purpose dispatch", () => {
		const msg = policyMessage("src/foo.ts");
		// Spot-check key allowlist entries
		expect(msg).toContain(".pi/orchestrator/");
		expect(msg).toContain("pi/src/");
		expect(msg).toContain("pi-");
		expect(msg).toContain("README.md");
		expect(msg).toContain("AGENTS.md");
	});

	it("explains that no direct write tool exists (force subagent dispatch)", () => {
		const msg = policyMessage("src/foo.ts");
		expect(msg).toMatch(/no direct write tool|dispatch/i);
	});
});

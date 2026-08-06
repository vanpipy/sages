/**
 * Tests for the file-gate: path-aware recommendation helper that
 * classifies paths as meta-file or production code.
 *
 * After GC-2026-031, the file-gate is a **recommendation helper only**:
 *   - `canMainAgentWrite(path)` returns true iff path is meta-file
 *     (`.pi/orchestrator/`, root docs, root configs) and not
 *     production code (user `src/`, `test/`, `lib/`, `*.ts`, `*.py`, ...).
 *   - `policyMessage(path)` returns the human-readable explanation
 *     used as a recommendation hint for callers.
 *
 * Soft mode: no commands are blocked by the bash-guard. The main agent
 * has full `edit` / `write` / `aft_edit` / `apply_patch` access. The
 * file-gate is exposed for downstream consumers (advisory metadata,
 * audit reports) that want to surface a path-policy recommendation.
 * Subagent dispatch via the 4-stage DAG workflow is RECOMMENDED for
 * workflows with >2 items in the agent's active todowrite; the agent
 * decides.
 */

import { describe, it, expect } from "bun:test";
import { canMainAgentWrite, policyMessage } from "@/tools/file-gate.js";

describe("canMainAgentWrite", () => {
	// GC-2026-029: the meta-paths allowlist is contracted to root-only.
	// Every path under `pi/` (src/test/templates/skills/scripts/README/package/tsconfig)
	// and every sibling subpackage under `pi-*/` is now PRODUCTION code —
	// it must be edited through the `developer` subagent in a managed worktree.
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
			".pi/agents/developer.md",
			// Root meta
			"README.md",
			"AGENTS.md",
			"package.json",
			"tsconfig.json",
			".gitignore",
			".aft.jsonc",
			".aft.json",
			".claude/settings.json",
			".codex/agents.json",
		];
		for (const p of allowed) {
			it(`allows ${p}`, () => {
				expect(canMainAgentWrite(p)).toBe(true);
			});
		}
	});

	// GC-2026-029 — every `pi/` and `pi-*/` subtree is production code.
	// These paths must be DENIED by `canMainAgentWrite`; main-agent direct
	// writes go through `developer` in a managed worktree (or `tdd: none`
	// with `isolation: "current-workspace"` for true meta-files only).
	describe("contracted meta-paths deny (GC-2026-029)", () => {
		const denied = [
			// pi/ source
			"pi/src/extension.ts",
			"pi/src/tools/orchestrator/index.ts",
			"pi/src/services/file-service.ts",
			// pi/ tests
			"pi/test/tools/orchestrator.test.ts",
			// pi/ templates + skills + scripts
			"pi/templates/SYSTEM.md",
			"pi/templates/SUBAGENTS.md",
			"pi/templates/agent-tool-description.md",
			"pi/skills/orchestrator/SKILL.md",
			"pi/skills/brainstorming/SKILL.md",
			"pi/scripts/install.sh",
			"pi/scripts/install.ps1",
			// pi/ root docs + configs
			"pi/README.md",
			"pi/package.json",
			"pi/tsconfig.json",
			// Sibling subpackages (Sages monorepo) — every subtree
			"pi-subagents/src/agent-runner.ts",
			"pi-subagents/src/agent-prompts/developer.ts",
			"pi-subagents/package.json",
			"pi-codebase-memory/src/index.ts",
			"pi-evaluator/src/evaluator.py",
			"pi-minimax/src/index.ts",
			"pi-yunxiao/src/index.ts",
			"pi-yunxiao/README.md",
			"pi-yunxiao/AGENTS.md",
		];
		for (const p of denied) {
			it(`denies ${p}`, () => {
				expect(canMainAgentWrite(p)).toBe(false);
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

	it("mentions developer (not general-purpose) for meta-file subagent guidance", () => {
		// DAG-2026-011 Phase C removed the `general-purpose` helper. The
		// policy message now steers callers to the `developer` agent for
		// both meta-file edits (`tdd: none`) and production code (managed
		// worktree). The `general-purpose` string is intentionally absent.
		const msg = policyMessage("src/foo.ts");
		expect(msg).toContain("developer");
		expect(msg).not.toContain("general-purpose");
	});

	it("lists the contracted (root-only) meta-path allowlist (GC-2026-029)", () => {
		const msg = policyMessage("src/foo.ts");
		// Surviving root-meta entries must still appear
		expect(msg).toContain(".pi/orchestrator/");
		expect(msg).toContain("README.md");
		expect(msg).toContain("AGENTS.md");
		// Dropped carve-outs must NOT appear in the policy message
		expect(msg).not.toContain("pi/src/");
		expect(msg).not.toContain("pi/test/");
		expect(msg).not.toContain("pi/templates/");
		expect(msg).not.toContain("pi/skills/");
		expect(msg).not.toContain("pi/scripts/");
		expect(msg).not.toContain("pi-*/");
		expect(msg).not.toContain("pi-subagents");
		expect(msg).not.toContain("pi-codebase-memory");
		expect(msg).not.toContain("pi-evaluator");
		expect(msg).not.toContain("pi-minimax");
		expect(msg).not.toContain("pi-yunxiao");
	});

	it("explains that no direct write tool exists (force subagent dispatch)", () => {
		const msg = policyMessage("src/foo.ts");
		expect(msg).toMatch(/no direct write tool|dispatch/i);
	});
});

/**
 * Post-tool-removal regression tests
 *
 * Pins down that the four-sages workflow machinery has been fully removed.
 * Per simplify-actions: only the seven role-based tools remain
 * (fuxi_design, qiaochui_review, qiaochui_decompose, luban_execute_task,
 *  gaoyao_audit, gaoyao_observe, gaoyao_finalize). No fsm, no slash
 * commands, no deprecated state module, no batch executor, no
 * workflow-state-manager, no mode-checker, no draft helpers.
 *
 * Round 1 (commit 9673465): slash commands, fuxi_start, fuxi_end,
 *   luban_run_batch, deprecated src/state module.
 * Round 2 (this commit): workflow-state-manager, mode-checker, scheduler,
 *   executor shim, draft-generator/draft-parser/request-classifier,
 *   partial helpers in conflict-detector + task-runner.
 *
 * Brainstorming module and skills/ docs are intentionally retained.
 *
 * These tests catch accidental resurrection of the deleted pieces.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..");

// ────────────────────────────────────────────────────────────────────────────
// Round 1: workflow machinery removed
// ────────────────────────────────────────────────────────────────────────────

describe("Slash commands removed (no /sages-init, /sages-plan)", () => {
	it("extensions/sages-tool.ts no longer exists", () => {
		const p = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		expect(fs.existsSync(p)).toBe(false);
	});

	it("extensions/ directory is gone (no other extensions either)", () => {
		const dir = path.join(PI_ROOT, "extensions");
		expect(fs.existsSync(dir)).toBe(false);
	});
});

describe("Deprecated state module removed", () => {
	it("src/state/state-manager.ts no longer exists", () => {
		const p = path.join(PI_ROOT, "src", "state", "state-manager.ts");
		expect(fs.existsSync(p)).toBe(false);
	});

	it("src/state/workspace-manager.ts no longer exists", () => {
		const p = path.join(PI_ROOT, "src", "state", "workspace-manager.ts");
		expect(fs.existsSync(p)).toBe(false);
	});

	it("src/state/index.ts no longer exists", () => {
		const p = path.join(PI_ROOT, "src", "state", "index.ts");
		expect(fs.existsSync(p)).toBe(false);
	});

	it("src/state/ directory is gone", () => {
		const dir = path.join(PI_ROOT, "src", "state");
		expect(fs.existsSync(dir)).toBe(false);
	});
});

describe("Workflow-level tools removed from registration", () => {
	function sourceFiles() {
		const tools = [
			"fuxi-tools.ts",
			"luban/index.ts",
			"gaoyao/tools.ts",
			"gaoyao/index.ts",
			"qiaochui/index.ts",
		];
		return tools
			.map((rel) => path.join(PI_ROOT, "src", "tools", rel))
			.filter((p) => fs.existsSync(p))
			.map((p) => ({ name: path.basename(p), content: fs.readFileSync(p, "utf-8") }));
	}

	const removed = ["fuxi_start", "fuxi_end", "luban_run_batch"];
	for (const tool of removed) {
		it(`${tool} is NOT registered in any tool source file`, () => {
			const sources = sourceFiles();
			const offenders = sources.filter((s) =>
				new RegExp(`name:\\s*["']${tool}["']`).test(s.content),
			);
			expect(offenders).toEqual([]);
		});
	}

	const kept = [
		"fuxi_design",
		"qiaochui_review",
		"qiaochui_decompose",
		"luban_execute_task",
		"gaoyao_audit",
		"gaoyao_observe",
		"gaoyao_finalize",
	];
	for (const tool of kept) {
		it(`${tool} IS still registered (regression guard)`, () => {
			const sources = sourceFiles();
			const matches = sources.filter((s) =>
				new RegExp(`name:\\s*["']${tool}["']`).test(s.content),
			);
			expect(matches.length).toBeGreaterThan(0);
		});
	}
});

describe("Package config no longer references slash commands or workflow", () => {
	it("package.json does not mention 'workflow' in description or keywords", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_ROOT, "package.json"), "utf-8"),
		);
		const haystack = `${pkg.description ?? ""} ${(pkg.keywords ?? []).join(" ")}`;
		expect(haystack.toLowerCase()).not.toContain("workflow");
	});

	it("package.json pi.extensions is REQUIRED and points at ./src/extension.ts", () => {
		// Round 3 (2026-07-19): the wrapper layer was re-introduced to wire
		// the AFT-backed sages_* tools into the pi runtime. Re-introducing
		// pi.extensions is intentional — the role-tool/wrapper split needs
		// a single entrypoint. Guard: it must NOT be removed again.
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_ROOT, "package.json"), "utf-8"),
		);
		expect(pkg.pi?.extensions).toBeDefined();
		expect(pkg.pi.extensions).toContain("./src/extension.ts");
	});

	it("src/extension.ts exists and is the single entrypoint (regression guard)", () => {
		// Lock down: if pi.extensions drifts to anything else, the package
		// loses its 4 role tools + 9 sages_* wrappers at runtime.
		const extPath = path.join(PI_ROOT, "src", "extension.ts");
		expect(fs.existsSync(extPath)).toBe(true);
	});
});

describe("Public exports do not leak deprecated state module", () => {
	it("src/index.ts does not export StateManager / WorkspaceManager", () => {
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "index.ts"), "utf-8");
		expect(content).not.toMatch(/export\s*\{[^}]*\bStateManager\b/);
		expect(content).not.toMatch(/export\s*\{[^}]*\bWorkspaceManager\b/);
		expect(content).not.toMatch(/\bLegacyWorkflowState\b/);
		expect(content).not.toMatch(/\bLegacyTask\b/);
		expect(content).not.toMatch(/\bLegacyAuditResult\b/);
	});

	it("src/index.ts top-level docstring does not mention 'workflow' orchestration", () => {
		// The docstring (top `/** ... */` block) should describe the role-based
		// design, not a workflow orchestration runtime. Class names like
		// WorkflowStateManager are per-tool runtime support and are allowed.
		// Note: as of 2026-07-19, the docstring references "sage workflow" in
		// the context of the sage file operations that wrap/ serves — that's
		// a content reference, not a workflow orchestration claim. We keep
		// the guard strict for orchestration terminology.
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "index.ts"), "utf-8");
		const docMatch = content.match(/^\/\*\*([\s\S]*?)\*\//m);
		expect(docMatch).not.toBeNull();
		if (docMatch) {
			const lower = docMatch[1].toLowerCase();
			expect(lower).not.toContain("orchestration");
		}
	});
});

describe("No test residue for removed tools", () => {
	it("test/sages-tool.test.ts no longer exists", () => {
		const p = path.join(PI_ROOT, "test", "sages-tool.test.ts");
		expect(fs.existsSync(p)).toBe(false);
	});

	it("test/state/ directory is gone", () => {
		const dir = path.join(PI_ROOT, "test", "state");
		expect(fs.existsSync(dir)).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Round 2: deep dead-code sweep
// ────────────────────────────────────────────────────────────────────────────

describe("Round 2: dead files removed", () => {
	const deleted = [
		"src/services/workflow-state-manager.ts",
		"src/utils/mode-checker.ts",
		"src/tools/luban/scheduler.ts",
		"src/executor/index.ts",
		"src/utils/draft-generator.ts",
		"src/utils/draft-parser.ts",
		"src/utils/request-classifier.ts",
		"src/utils/model-helper.ts",
		"src/tools/luban/plan-parser.ts",
	];
	for (const rel of deleted) {
		it(`${rel} no longer exists`, () => {
			const p = path.join(PI_ROOT, rel);
			expect(fs.existsSync(p)).toBe(false);
		});
	}

	it("src/executor/ directory is empty/gone", () => {
		const dir = path.join(PI_ROOT, "src", "executor");
		// Either gone or empty
		if (fs.existsSync(dir)) {
			expect(fs.readdirSync(dir)).toEqual([]);
		}
	});

	const deletedTests = [
		"test/services/workflow-state-manager.test.ts",
		"test/utils/mode-checker.test.ts",
		"test/tools/luban/scheduler.test.ts",
		"test/utils/draft-generator.test.ts",
		"test/utils/draft-parser.test.ts",
		"test/utils/request-classifier.test.ts",
		"test/utils/model-helper.test.ts",
		"test/tools/luban/plan-parser.test.ts",
	];
	for (const rel of deletedTests) {
		it(`${rel} no longer exists`, () => {
			const p = path.join(PI_ROOT, rel);
			expect(fs.existsSync(p)).toBe(false);
		});
	}
});

describe("Round 2: partial files only export live helpers", () => {
	it("src/tools/luban/conflict-detector.ts no longer exports detectFileConflicts", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "luban", "conflict-detector.ts"),
			"utf-8",
		);
		expect(content).not.toMatch(/export\s+function\s+detectFileConflicts\b/);
		// deriveTestFiles is the live helper — must still be exported
		expect(content).toMatch(/export\s+function\s+deriveTestFiles\b/);
	});

	it("src/tools/luban/task-runner.ts no longer exports runTask / runTDDCycle / generateTestFromScenarios", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "luban", "task-runner.ts"),
			"utf-8",
		);
		expect(content).not.toMatch(/export\s+(async\s+)?function\s+runTask\b/);
		expect(content).not.toMatch(/export\s+(async\s+)?function\s+runTDDCycle\b/);
		expect(content).not.toMatch(/export\s+function\s+generateTestFromScenarios\b/);
		// Live helpers must still be exported
		expect(content).toMatch(/export\s+function\s+runTests\b/);
		expect(content).toMatch(/export\s+function\s+validateScope\b/);
		expect(content).toMatch(/export\s+const\s+TDD_GUIDE\b/);
	});
});

describe("Round 2: qiaochui no longer imports unused model-helper", () => {
	it("src/tools/qiaochui/index.ts does not import getUserDefaultModel", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "qiaochui", "index.ts"),
			"utf-8",
		);
		expect(content).not.toMatch(/getUserDefaultModel/);
		expect(content).not.toMatch(/model-helper/);
	});
});

describe("Round 2: public API surface is minimal (only role tools + FileService)", () => {
	it("src/index.ts does not export dead re-exports", () => {
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "index.ts"), "utf-8");
		// workflow-state-manager types
		expect(content).not.toMatch(/\bWorkflowState\b/);
		expect(content).not.toMatch(/\bFuxiPhase\b/);
		expect(content).not.toMatch(/\bArchiveInfo\b/);
		// executor functions
		expect(content).not.toMatch(/\brunTask\b/);
		expect(content).not.toMatch(/\brunTDDCycle\b/);
		expect(content).not.toMatch(/\bparseExecutionYaml\b/);
		expect(content).not.toMatch(/\bresolveDependencies\b/);
		expect(content).not.toMatch(/\bsortByDependencies\b/);
		// executor types
		expect(content).not.toMatch(/\bTDDConfig\b/);
		expect(content).not.toMatch(/\bExecutionSettings\b/);
		// mode-checker
		expect(content).not.toMatch(/\bcheckWritePermission\b/);
		expect(content).not.toMatch(/\bgetModeInfo\b/);
		expect(content).not.toMatch(/\bgetModeIndicator\b/);
		expect(content).not.toMatch(/\bgetAccessDeniedMessage\b/);
		// WorkflowStateManager itself (now dead)
		expect(content).not.toMatch(/\bWorkflowStateManager\b/);
		expect(content).not.toMatch(/["']\.\/executor/);
	});

	it("src/index.ts keeps the role-tool registration exports", () => {
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "index.ts"), "utf-8");
		expect(content).toContain("registerFuxiTools");
		expect(content).toContain("registerQiaoChuiTools");
		expect(content).toContain("registerLubanTools");
		expect(content).toContain("registerGaoYaoTools");
		expect(content).toContain("FileService");
	});
});

describe("Round 2: brainstorming module and skills/ docs are preserved", () => {
	it("src/tools/brainstorming/index.ts still exists", () => {
		const p = path.join(PI_ROOT, "src", "tools", "brainstorming", "index.ts");
		expect(fs.existsSync(p)).toBe(true);
	});

	const skills = ["fuxi", "qiaochui", "luban", "gaoyao", "brainstorming"];
	for (const name of skills) {
		it(`skills/${name}/SKILL.md still exists`, () => {
			const p = path.join(PI_ROOT, "skills", name, "SKILL.md");
			expect(fs.existsSync(p)).toBe(true);
		});
	}
});
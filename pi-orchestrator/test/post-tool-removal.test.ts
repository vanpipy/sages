/**
 * Post-tool-removal regression tests (Round 3 — four-sage workflow stripped).
 *
 * Pins down that the four-sage role-tool machinery (Fuxi, QiaoChui, LuBan,
 * GaoYao) has been fully removed from the pi package and replaced by the
 * orchestrator + subagent workflow.
 *
 * What was removed (round 1 + 2 + 3):
 *   - src/tools/fuxi-tools.ts
 *   - src/tools/qiaochui/ (entire directory)
 *   - src/tools/luban/   (entire directory)
 *   - src/tools/gaoyao-tools.ts
 *   - src/tools/gaoyao/  (entire directory)
 *   - src/tools/deprecation-stubs.ts (was only used by the four sages)
 *   - skills/{fuxi,qiaochui,luban,gaoyao}/SKILL.md (entire dirs)
 *   - test/tools/{qiaochui,luban,gaoyao}/ (entire dirs)
 *   - test/tools/{fuxi,qiaochui,luban}-tools*.test.ts
 *   - test/tools/{fuxi,qiaochui,luban,gaoyao}-*.test.ts (deep tests)
 *   - test/deprecation-stubs.test.ts
 *   - src/utils/scope-parser.ts (orphaned — parsed Fuxi draft.md format)
 *
 * What was kept:
 *   - src/tools/orchestrator/ (goal + DAG + dispatch + audit)
 *   - src/tools/brainstorming/ (design exploration + orchestrator handoff)
 *   - skills/{orchestrator,brainstorming}/SKILL.md
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
// Round 3: four-sage role tools fully removed
// ────────────────────────────────────────────────────────────────────────────

describe("Four-sage role tools removed (Round 3)", () => {
	const deletedSources = [
		"src/tools/fuxi-tools.ts",
		"src/tools/qiaochui/index.ts",
		"src/tools/qiaochui/decompose-service.ts",
		"src/tools/qiaochui/review-service.ts",
		"src/tools/qiaochui/types.ts",
		"src/tools/luban/index.ts",
		"src/tools/luban/types.ts",
		"src/tools/luban/task-runner.ts",
		"src/tools/luban/conflict-detector.ts",
		"src/tools/gaoyao-tools.ts",
		"src/tools/gaoyao/index.ts",
		"src/tools/gaoyao/phases.ts",
		"src/tools/gaoyao/session.ts",
		"src/tools/gaoyao/tools.ts",
		"src/tools/deprecation-stubs.ts",
	];
	for (const rel of deletedSources) {
		it(`${rel} no longer exists`, () => {
			const p = path.join(PI_ROOT, rel);
			expect(fs.existsSync(p)).toBe(false);
		});
	}

	const deletedDirs = [
		"src/tools/qiaochui",
		"src/tools/luban",
		"src/tools/gaoyao",
	];
	for (const dir of deletedDirs) {
		it(`${dir}/ directory is gone`, () => {
			const p = path.join(PI_ROOT, dir);
			expect(fs.existsSync(p)).toBe(false);
		});
	}

	const deletedSkills = [
		"skills/fuxi/SKILL.md",
		"skills/qiaochui/SKILL.md",
		"skills/luban/SKILL.md",
		"skills/gaoyao/SKILL.md",
	];
	for (const rel of deletedSkills) {
		it(`${rel} no longer exists`, () => {
			const p = path.join(PI_ROOT, rel);
			expect(fs.existsSync(p)).toBe(false);
		});
	}

	const deletedTests = [
		"test/tools/fuxi-tools.test.ts",
		"test/tools/fuxi-tools-simplified.test.ts",
		"test/tools/fuxi-request-deep.test.ts",
		"test/tools/qiaochui-tools.test.ts",
		"test/tools/qiaochui-tools-simplified.test.ts",
		"test/tools/luban-tools.test.ts",
		"test/tools/qiaochui/decompose-service.test.ts",
		"test/tools/qiaochui/review-service.test.ts",
		"test/tools/qiaochui/types.test.ts",
		"test/tools/luban/conflict-detector.test.ts",
		"test/tools/luban/task-runner.test.ts",
		"test/tools/luban/tdd-guide.test.ts",
		"test/tools/luban/tools.test.ts",
		"test/tools/luban/types.test.ts",
		"test/tools/gaoyao/session.test.ts",
		"test/tools/gaoyao/tools.test.ts",
		"test/deprecation-stubs.test.ts",
	];
	for (const rel of deletedTests) {
		it(`${rel} no longer exists`, () => {
			const p = path.join(PI_ROOT, rel);
			expect(fs.existsSync(p)).toBe(false);
		});
	}

	const deletedTestDirs = [
		"test/tools/qiaochui",
		"test/tools/luban",
		"test/tools/gaoyao",
	];
	for (const dir of deletedTestDirs) {
		it(`test/tools/${dir}/ directory is gone`, () => {
			const p = path.join(PI_ROOT, "test", "tools", dir);
			expect(fs.existsSync(p)).toBe(false);
		});
	}

	// Orphaned utility — parsed Fuxi's MDD draft.md, which no longer exists.
	const orphanedUtility = ["src/utils/scope-parser.ts", "test/utils/scope-parser.test.ts"];
	for (const rel of orphanedUtility) {
		it(`orphan ${rel} removed`, () => {
			const p = path.join(PI_ROOT, rel);
			expect(fs.existsSync(p)).toBe(false);
		});
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Round 3: entry points no longer reference the four sages
// ────────────────────────────────────────────────────────────────────────────

describe("Entry points no longer reference the four sages", () => {
	it("src/extension.ts does not import any four-sage registrars", () => {
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "extension.ts"), "utf-8");
		expect(content).not.toMatch(/registerFuxiTools/);
		expect(content).not.toMatch(/registerQiaoChuiTools/);
		expect(content).not.toMatch(/registerLubanTools/);
		expect(content).not.toMatch(/registerGaoYaoTools/);
		// Orchestrator must remain.
		expect(content).toContain("registerOrchestratorTools");
	});

	it("src/index.ts does not export any four-sage registrars", () => {
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "index.ts"), "utf-8");
		expect(content).not.toMatch(/registerFuxiTools/);
		expect(content).not.toMatch(/registerQiaoChuiTools/);
		expect(content).not.toMatch(/registerLubanTools/);
		expect(content).not.toMatch(/registerGaoYaoTools/);
		// FileService (the only cross-tool utility) must remain.
		expect(content).toContain("FileService");
	});

	it("src/tools/index.ts does not export any four-sage registrars", () => {
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "tools", "index.ts"), "utf-8");
		expect(content).not.toMatch(/registerFuxiTools/);
		expect(content).not.toMatch(/registerQiaoChuiTools/);
		expect(content).not.toMatch(/registerLubanTools/);
		expect(content).not.toMatch(/registerGaoYaoTools/);
		expect(content).toContain("registerOrchestratorTools");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Round 3: orchestrator + brainstorming module preserved
// ────────────────────────────────────────────────────────────────────────────

describe("Orchestrator + brainstorming preserved", () => {
	it("src/tools/orchestrator/ exists with all 5 module files", () => {
		const dir = path.join(PI_ROOT, "src", "tools", "orchestrator");
		expect(fs.existsSync(dir)).toBe(true);
		const files = fs.readdirSync(dir);
		for (const required of [
			"index.ts",
			"types.ts",
			"planes.ts",
			"goal-contract.ts",
			"dag-synthesizer.ts",
			"task-dispatcher.ts",
			"orchestrator-audit.ts",
			"template-loader.ts",
		]) {
			expect(files).toContain(required);
		}
	});

	it("src/tools/brainstorming/ exists", () => {
		const dir = path.join(PI_ROOT, "src", "tools", "brainstorming");
		expect(fs.existsSync(dir)).toBe(true);
	});

	const keptSkills = ["orchestrator", "brainstorming"];
	for (const name of keptSkills) {
		it(`skills/${name}/SKILL.md still exists`, () => {
			const p = path.join(PI_ROOT, "skills", name, "SKILL.md");
			expect(fs.existsSync(p)).toBe(true);
		});
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Round 3: brainstorming source no longer references Fuxi
// ────────────────────────────────────────────────────────────────────────────

describe("Brainstorming source uses orchestrator handoff (not Fuxi)", () => {
	it("src/tools/brainstorming/index.ts exports createOrchestratorContext, not createFuxiContext", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "brainstorming", "index.ts"),
			"utf-8",
		);
		expect(content).toContain("createOrchestratorContext");
		expect(content).not.toMatch(/createFuxiContext\b/);
		expect(content).not.toMatch(/FuxiPlanContext\b/);
	});

	it("src/tools/brainstorming/types.ts uses 'orchestrator' as transition target", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "brainstorming", "types.ts"),
			"utf-8",
		);
		expect(content).toContain('"orchestrator"');
		expect(content).not.toMatch(/["']fuxi["']/);
		expect(content).not.toContain("TRANSITION_TO_FUXI");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Round 3: orchestrator types no longer import from qiaochui
// ────────────────────────────────────────────────────────────────────────────

describe("Orchestrator types inlined the MDD plane classification (no qiaochui import)", () => {
	it("src/tools/orchestrator/types.ts does not import from qiaochui", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "orchestrator", "types.ts"),
			"utf-8",
		);
		expect(content).not.toMatch(/from\s+["']\.\.\/qiaochui/);
		expect(content).not.toMatch(/from\s+["']\.\.\/\.\.\/qiaochui/);
	});

	it("src/tools/orchestrator/types.ts no longer extends MDDTask", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "orchestrator", "types.ts"),
			"utf-8",
		);
		expect(content).not.toMatch(/MDDTask/);
	});

	it("src/tools/orchestrator/planes.ts defines the MDD plane vocabulary", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "tools", "orchestrator", "planes.ts"),
			"utf-8",
		);
		expect(content).toContain("MDDPlane");
		expect(content).toContain("MDD_PLANES");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Round 3: package extensions entrypoint still wires orchestrator
// ────────────────────────────────────────────────────────────────────────────

describe("Package config still wires the orchestrator (regression guard)", () => {
	it("src/extension.ts exists and is the single entrypoint", () => {
		const extPath = path.join(PI_ROOT, "src", "extension.ts");
		expect(fs.existsSync(extPath)).toBe(true);
	});

	it("package.json pi.extensions still points at ./src/extension.ts", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_ROOT, "package.json"), "utf-8"),
		);
		expect(pkg.pi?.extensions).toBeDefined();
		expect(pkg.pi.extensions).toContain("./src/extension.ts");
	});
});
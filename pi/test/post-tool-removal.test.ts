/**
 * Post-tool-removal regression tests
 *
 * Pins down that the four-sages workflow machinery has been fully removed.
 * Per simplify-actions: only the seven role-based tools remain
 * (fuxi_design, qiaochui_review, qiaochui_decompose, luban_execute_task,
 *  gaoyao_audit, gaoyao_observe, gaoyao_finalize). No fsm, no slash
 * commands, no deprecated state module.
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

	it("package.json pi.extensions array is removed (no extensions anymore)", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_ROOT, "package.json"), "utf-8"),
		);
		expect(pkg.pi?.extensions).toBeUndefined();
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
		// design, not a workflow orchestration. Class names like WorkflowStateManager
		// are per-tool runtime support and are allowed.
		const content = fs.readFileSync(path.join(PI_ROOT, "src", "index.ts"), "utf-8");
		const docMatch = content.match(/^\/\*\*([\s\S]*?)\*\//m);
		expect(docMatch).not.toBeNull();
		if (docMatch) {
			expect(docMatch[1].toLowerCase()).not.toContain("workflow");
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
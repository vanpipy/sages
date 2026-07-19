/**
 * Post-FSM-removal tests
 *
 * Per simplify-actions principle, this round removes the FSM orchestrator
 * and all stage prompts. The four sages work standalone via natural-language
 * routing. These tests pin down what was removed.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..");

describe("FSM orchestrator removed", () => {
	it("extensions/sages-fsm.ts no longer exists", () => {
		const fsmPath = path.join(PI_ROOT, "extensions", "sages-fsm.ts");
		expect(fs.existsSync(fsmPath)).toBe(false);
	});

	it("extensions/experiments/03-state-machine-fsm.ts no longer exists", () => {
		const expPath = path.join(PI_ROOT, "extensions", "experiments", "03-state-machine-fsm.ts");
		expect(fs.existsSync(expPath)).toBe(false);
	});
});

describe("Stage prompts removed", () => {
	const prompts = [
		"four-sages-design.md",
		"four-sages-review.md",
		"four-sages-plan-approval.md",
		"four-sages-decompose.md",
		"four-sages-execute.md",
		"four-sages-audit.md",
		"four-sages-finalize.md",
		"four-sages-workflow.md",
		"bugfix-fix.md",
		"bugfix-reproduce.md",
	];

	for (const prompt of prompts) {
		it(`prompts/${prompt} no longer exists`, () => {
			const p = path.join(PI_ROOT, "prompts", prompt);
			expect(fs.existsSync(p)).toBe(false);
		});
	}

	it("prompts/ directory is empty (no leftover files)", () => {
		const dir = path.join(PI_ROOT, "prompts");
		if (fs.existsSync(dir)) {
			const files = fs.readdirSync(dir);
			expect(files).toEqual([]);
		}
	});
});

describe("Workflow YAML removed", () => {
	it(".sages/workflow.yaml no longer exists", () => {
		const p = path.join(PI_ROOT, ".sages", "workflow.yaml");
		expect(fs.existsSync(p)).toBe(false);
	});

	it(".sages/workflows/four-sages.yaml no longer exists", () => {
		const p = path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml");
		expect(fs.existsSync(p)).toBe(false);
	});

	it(".sages/workflows/bugfix.yaml no longer exists", () => {
		const p = path.join(PI_ROOT, ".sages", "workflows", "bugfix.yaml");
		expect(fs.existsSync(p)).toBe(false);
	});

	it(".sages/workflows/ directory does not exist (no templates)", () => {
		const dir = path.join(PI_ROOT, ".sages", "workflows");
		expect(fs.existsSync(dir)).toBe(false);
	});
});



describe("Source code no longer references FSM", () => {
	it("src/index.ts does NOT export WorkflowStateManager.create or similar FSM internals", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "index.ts"),
			"utf-8"
		);
		// WorkflowStateManager stays (sage tools use it); just no FSM exports.
		expect(content).not.toContain("SagesFSM");
		expect(content).not.toContain("extensions/sages-fsm");
	});
});
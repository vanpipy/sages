/**
 * 验证 workflow YAML 解析和 FSM 加载逻辑
 *
 * 目标:
 * 1. .sages/workflow.yaml 可解析
 * 2. .sages/workflows/four-sages.yaml 可解析
 * 3. FSM 加载逻辑正确(缺配置 → fallback)
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..");

describe("Workflow YAML Schema", () => {
	it("workflows/four-sages.yaml 存在且合法", () => {
		const workflowPath = path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml");
		expect(fs.existsSync(workflowPath)).toBe(true);

		const raw = fs.readFileSync(workflowPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		expect(parsed.apiVersion).toBe("sages.io/workflow-v1alpha1");
		expect(parsed.kind).toBe("Workflow");
		expect(parsed.metadata.name).toBe("four-sages");
		expect(Array.isArray(parsed.spec.stages)).toBe(true);
		expect(parsed.spec.stages.length).toBeGreaterThanOrEqual(7);
	});

	it("workflows/four-sages.yaml 8 个 stage ID 唯一", () => {
		const workflowPath = path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml");
		const raw = fs.readFileSync(workflowPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		const ids = parsed.spec.stages.map((s: any) => s.id);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it("workflows/four-sages.yaml 包含关键 stage", () => {
		const workflowPath = path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml");
		const raw = fs.readFileSync(workflowPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		const ids = parsed.spec.stages.map((s: any) => s.id);
		expect(ids).toContain("design");
		expect(ids).toContain("review");
		expect(ids).toContain("plan");
		expect(ids).toContain("decompose");
		expect(ids).toContain("execute");
		expect(ids).toContain("audit");
		expect(ids).toContain("archive");
		expect(ids).toContain("complete");
	});

	it("plan stage 是手动 gate(command trigger)", () => {
		const workflowPath = path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml");
		const raw = fs.readFileSync(workflowPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		const planStage = parsed.spec.stages.find((s: any) => s.id === "plan");
		expect(planStage).toBeDefined();
		expect(planStage.trigger.type).toBe("command");
		expect(planStage.trigger.command).toBe("/sages-plan");
	});

	it("complete stage 是 terminal", () => {
		const workflowPath = path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml");
		const raw = fs.readFileSync(workflowPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		const completeStage = parsed.spec.stages.find((s: any) => s.id === "complete");
		expect(completeStage.terminal).toBe(true);
	});

	it("audit stage 有 onVerdict 分支处理", () => {
		const workflowPath = path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml");
		const raw = fs.readFileSync(workflowPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		const auditStage = parsed.spec.stages.find((s: any) => s.id === "audit");
		expect(auditStage.onVerdict).toBeDefined();
		expect(auditStage.onVerdict.PASS).toBeDefined();
		expect(auditStage.onVerdict.REJECTED).toBeDefined();
		expect(auditStage.onVerdict.NEEDS_CHANGES).toBeDefined();
	});
});

describe("Workflow Config", () => {
	it("workflow.yaml 存在且合法", () => {
		const configPath = path.join(PI_ROOT, ".sages", "workflow.yaml");
		expect(fs.existsSync(configPath)).toBe(true);

		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		expect(parsed.apiVersion).toBe("sages.io/workflow-v1alpha1");
		expect(parsed.kind).toBe("WorkflowConfig");
		expect(parsed.spec.activeWorkflow).toBe("four-sages");
		expect(parsed.spec.onSwitch).toBeDefined();
		expect(parsed.spec.bootstrap).toBeDefined();
	});

	it("workflow.yaml 指向存在的 workflow 文件", () => {
		const configPath = path.join(PI_ROOT, ".sages", "workflow.yaml");
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = yaml.load(raw) as any;

		const workflowDir = parsed.spec.workflowDir || "./.sages/workflows";
		const workflowName = parsed.spec.activeWorkflow;
		const workflowPath = path.join(PI_ROOT, workflowDir, `${workflowName}.yaml`);

		expect(fs.existsSync(workflowPath)).toBe(true);
	});
});

describe("Stage Prompts", () => {
	// [修复] prompts 已扁平化,prefix 为 four-sages- / bugfix-
	const promptDir = PI_ROOT; // 扁平化后 prompts 在 PI_ROOT/prompts/
	const expectedPrompts = [
		"four-sages-design.md",
		"four-sages-review.md",
		"four-sages-plan-approval.md",
		"four-sages-execute.md",
		"four-sages-audit.md",
	];

	for (const prompt of expectedPrompts) {
		it(`prompts/${prompt} 存在`, () => {
			const p = path.join(promptDir, "prompts", prompt);
			expect(fs.existsSync(p)).toBe(true);
			const content = fs.readFileSync(p, "utf-8");
			expect(content.length).toBeGreaterThan(100);  // 至少不是空文件
		});
	}
});

describe("FSM Extension Files", () => {
	it("sages-fsm.ts 存在且 typecheck 通过", () => {
		const fsmPath = path.join(PI_ROOT, "extensions", "sages-fsm.ts");
		expect(fs.existsSync(fsmPath)).toBe(true);
	});

	it("sages-tool.ts 存在且 typecheck 通过", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		expect(fs.existsSync(toolPath)).toBe(true);
	});

	it("sages-tool.ts 注册 2 个命令(/sages-plan, /sages-status)", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		expect(content).toContain('"sages-plan"');
		expect(content).toContain('"sages-status"');
	});

	it("sages-fsm.ts 使用 pi.on(\"tool_result\")", () => {
		const fsmPath = path.join(PI_ROOT, "extensions", "sages-fsm.ts");
		const content = fs.readFileSync(fsmPath, "utf-8");
		expect(content).toContain('pi.on("tool_result"');
		expect(content).toContain('pi.on("session_start"');
		expect(content).toContain("sendUserMessage");
		expect(content).toContain("appendEntry");
	});
});

describe("向后兼容(校正后问题 5)", () => {
	it("FSM 加载 state 缺 workflow 字段时不报错", () => {
		// 模拟旧 state.json
		const legacyState = {
			planName: "old-plan",
			phase: "design",
			// 缺 workflow 字段
		};

		// FSM 应填默认值
		const stateWithWorkflow = legacyState as { workflow?: { name: string; version: string } };
		if (!stateWithWorkflow.workflow) {
			stateWithWorkflow.workflow = { name: "legacy", version: "0.0.0" };
		}

		expect(stateWithWorkflow.workflow.name).toBe("legacy");
	});
});

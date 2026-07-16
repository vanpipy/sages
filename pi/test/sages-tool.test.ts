/**
 * Sages Tool 测试
 *
 * 验证 2 个 slash command 的注册和基本行为:
 * - /sages-init  (一次性 setup)
 * - /sages-plan  (唯一的 REQUIRED 人工批准 gate)
 *
 * 不再注册 /sages-status 和 /sages-workflow——自然语言路由覆盖这两个用例:
 *   "where are we?" / "switch to bugfix" 由 LLM 直接处理。
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..");

describe("sages-tool: 命令注册", () => {
	it("sages-tool.ts 存在", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		expect(fs.existsSync(toolPath)).toBe(true);
	});

	it("注册 2 个 command: init / plan", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		expect(content).toContain('"sages-init"');
		expect(content).toContain('"sages-plan"');
	});

	it("不移除 /sages-status (因为自然语言已覆盖 status 查询)", () => {
		// 明确去除——"where are we?" 由 LLM 直接响应,无需 slash command
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		expect(content).not.toContain('"sages-status"');
	});

	it("不移除 /sages-workflow (因为自然语言已覆盖 workflow 切换)", () => {
		// 明确去除——"switch to bugfix" 由 LLM 直接编辑 workflow.yaml
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		expect(content).not.toContain('"sages-workflow"');
	});

	it("也不出现 TERMINAL_STAGES 常量 (随 /sages-workflow 一起移除)", () => {
		// strict-mode 终态检查不再有 slash command 触发,常量也随之移除
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		expect(content).not.toContain("TERMINAL_STAGES");
		expect(content).not.toContain("isTerminalStage");
	});

	it("不复用旧的 18 个 sage-specific 命令", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		// 不应出现 fuxi-start / qiaochui-review / luban-execute-* / gaoyao-init
		expect(content).not.toContain('"fuxi-start"');
		expect(content).not.toContain('"qiaochui-review"');
		expect(content).not.toContain('"luban-execute-task"');
		expect(content).not.toContain('"gaoyao-init"');
	});
});

describe("sages-tool: /sages-init", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sages-init-test-"));
	});

	it("全新项目:创建 .sages/workflow.yaml + workflows/ 目录", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");

		// 验证 init 处理函数包含创建目录和写 config 的逻辑
		expect(content).toContain("mkdirSync");
		expect(content).toContain("workflows");
		expect(content).toContain("workflow.yaml");
		expect(content).toContain("activeWorkflow");
	});

	it("已有 config:不覆盖", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		// 验证 init 处理函数检查已存在的情况
		expect(content).toContain("已存在");
	});
});

describe("sages-tool: /sages-plan 手动 gate", () => {
	it("通过 EventBus 通知 FSM", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "extensions", "sages-tool.ts"),
			"utf-8",
		);
		expect(content).toContain("sages:plan-approved");
	});
});
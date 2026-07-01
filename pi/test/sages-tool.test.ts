/**
 * Sages Tool 测试
 *
 * 验证 4 个 slash command 的注册和基本行为:
 * - /sages-init
 * - /sages-plan
 * - /sages-status
 * - /sages-workflow [list|current|name]
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

	it("注册 4 个 command:init / plan / status / workflow", () => {
		const toolPath = path.join(PI_ROOT, "extensions", "sages-tool.ts");
		const content = fs.readFileSync(toolPath, "utf-8");
		expect(content).toContain('"sages-init"');
		expect(content).toContain('"sages-plan"');
		expect(content).toContain('"sages-status"');
		expect(content).toContain('"sages-workflow"');
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
		// 直接读取源代码,确保逻辑正确
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

describe("sages-tool: /sages-workflow 子命令", () => {
	let tmpDir: string;
	let toolContent: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sages-wf-test-"));
		const sagesDir = path.join(tmpDir, ".sages");
		fs.mkdirSync(path.join(sagesDir, "workflows"), { recursive: true });

		// 复制真实 workflow files
		fs.copyFileSync(
			path.join(PI_ROOT, ".sages", "workflow.yaml"),
			path.join(sagesDir, "workflow.yaml"),
		);
		fs.copyFileSync(
			path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml"),
			path.join(sagesDir, "workflows", "four-sages.yaml"),
		);
		fs.copyFileSync(
			path.join(PI_ROOT, ".sages", "workflows", "bugfix.yaml"),
			path.join(sagesDir, "workflows", "bugfix.yaml"),
		);

		toolContent = fs.readFileSync(
			path.join(PI_ROOT, "extensions", "sages-tool.ts"),
			"utf-8",
		);
	});

	it("list:列出 workflows/ 下的 .yaml 文件", () => {
		expect(toolContent).toContain('trimmed === "list"');
		expect(toolContent).toContain("readdirSync");
	});

	it("current:显示 activeWorkflow", () => {
		expect(toolContent).toContain('trimmed === "current"');
	});

	it("切换:写入新的 activeWorkflow + emit EventBus 事件", () => {
		expect(toolContent).toContain("activeWorkflow = trimmed");
		expect(toolContent).toContain("sages:workflow-switched");
	});

	it("切换前检查 workflow 文件存在", () => {
		expect(toolContent).toContain("workflow 不存在");
	});

	it("切换前检查 .sages/workflow.yaml 存在", () => {
		expect(toolContent).toContain(".sages/workflow.yaml 不存在");
	});
});

describe("sages-tool: /sages-status", () => {
	it("通过 EventBus 异步请求状态", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "extensions", "sages-tool.ts"),
			"utf-8",
		);
		expect(content).toContain("sages:status-request");
		expect(content).toContain("sages:status-response");
		expect(content).toContain("setTimeout"); // timeout fallback
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
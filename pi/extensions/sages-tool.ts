/**
 * Sages Tool - 仅保留必须由人类明确触发的 slash command
 *
 * 保留 2 个命令 (其余的"状态查询 / workflow 切换 / score 更新"等都是自然语言路由):
 * - /sages-init      一次性 setup: 初始化 .sages/workflow.yaml + 复制模板
 * - /sages-plan      唯一 REQUIRED 手动 gate: 批准 plan 后推进到 decompose/execute
 *
 * 为什么只有这两个: 自然语言路由(“design an API” / “audit my code”等) 让 LLM
 * 动选选 sage 工具。同时查询(状态、score、workflow 列表)也同样由 LLM
 * 在工具响应中携带。消除能消的 slash command。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// package 根目录(extensions/ 的上一级)
const PACKAGE_ROOT = path.resolve(__dirname, "..");

// 模板源路径(package 内)
const TEMPLATE_WORKFLOW_DIR = path.join(PACKAGE_ROOT, ".sages", "workflows");
const TEMPLATE_PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

export default function (pi: ExtensionAPI) {
	// ─── /sages-init:初始化全新项目 ───
	pi.registerCommand("sages-init", {
		description: "[Sages] 初始化 .sages/workflow.yaml + 复制模板(全新项目)",
		handler: async (_args, ctx) => {
			const sagesDir = path.join(ctx.cwd, ".sages");
			const workflowsDir = path.join(sagesDir, "workflows");
			const configPath = path.join(sagesDir, "workflow.yaml");

			if (fs.existsSync(configPath)) {
				ctx.ui.notify("[Sages] .sages/workflow.yaml 已存在,无需初始化", "info");
				return;
			}

			// 创建目录
			fs.mkdirSync(workflowsDir, { recursive: true });

			// 写默认 config
			const defaultConfig = `apiVersion: sages.io/workflow-v1alpha1
kind: WorkflowConfig
metadata:
  name: user-defaults
  description: Sages workflow 配置(由 /sages-init 创建)
spec:
  activeWorkflow: four-sages
  aliases:
    default: four-sages
    bugfix: bugfix
  workflowDir: ./.sages/workflows
  onSwitch: strict
  bootstrap:
    onMissingConfig: fallback-to-default
    onEmptyWorkspace: prompt-init
`;
			fs.writeFileSync(configPath, defaultConfig);

			// [M1] 复制 workflow 模板
			let copiedWorkflows: string[] = [];
			if (fs.existsSync(TEMPLATE_WORKFLOW_DIR)) {
				for (const file of fs.readdirSync(TEMPLATE_WORKFLOW_DIR)) {
					if (file.endsWith(".yaml")) {
						fs.copyFileSync(
							path.join(TEMPLATE_WORKFLOW_DIR, file),
							path.join(workflowsDir, file)
						);
						copiedWorkflows.push(file);
					}
				}
			}

			// 复制 prompts 目录(可选,如果存在)
			const userPromptsDir = path.join(sagesDir, "prompts");
			let copiedPrompts = 0;
			if (fs.existsSync(TEMPLATE_PROMPTS_DIR)) {
				fs.mkdirSync(userPromptsDir, { recursive: true });
				const copyDir = (src: string, dest: string) => {
					if (!fs.existsSync(src)) return;
					fs.mkdirSync(dest, { recursive: true });
					for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
						const srcPath = path.join(src, entry.name);
						const destPath = path.join(dest, entry.name);
						if (entry.isDirectory()) {
							copyDir(srcPath, destPath);
						} else {
							fs.copyFileSync(srcPath, destPath);
							copiedPrompts++;
						}
					}
				};
				copyDir(TEMPLATE_PROMPTS_DIR, userPromptsDir);
			}

			ctx.ui.notify(
				`[Sages] 已创建 .sages/\n` +
					`  workflow.yaml(activeWorkflow=four-sages)\n` +
					`  workflows/: ${copiedWorkflows.join(", ") || "(none)"}\n` +
					`  prompts/: ${copiedPrompts} 文件\n` +
					`运行 /sages-plan 开始 workflow;其它进度通过自然语言查询`,
				"info"
			);
		},
	});

	// ─── /sages-plan:唯一手动 gate ───
	pi.registerCommand("sages-plan", {
		description: "[Sages] 批准 plan(唯一手动 gate)",
		handler: async (_args, ctx) => {
			pi.events.emit("sages:plan-approved", { at: Date.now(), cwd: ctx.cwd });
			ctx.ui.notify("[Sages] plan approved. FSM 正在推进...", "info");
		},
	});
}
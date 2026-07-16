/**
 * Sages Tool - 仅保留必须由人类明确触发的 slash command (极简版)
 *
 * 移除 FSM 之后,sages 不再需要工作流配置 (.sages/workflow.yaml)、
 * 阶段提示 (pi/prompts/) 或 workflow 模板。/sages-init 只创建 workspace
 * 目录,/sages-plan 只是通知 (无 FSM 消费者)。
 *
 * 保留 2 个命令:
 * - /sages-init      创建 .sages/workspace/ (sage 工具的产出目录)
 * - /sages-plan      通知 (LLM 通过自然语言路由推进工作)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// package 根目录(extensions/ 的上一级)
const PACKAGE_ROOT = path.resolve(__dirname, "..");

// sages 运行时目录 — sage 工具 (fuxi / qiaochui / luban / gaoyao) 把
// draft.md / plan.md / execution.yaml / audit.md 等写到这里
const WORKSPACE_DIR = ".sages/workspace";

export default function (pi: ExtensionAPI) {
	// ─── /sages-init:创建 workspace 目录(一次性) ───
	pi.registerCommand("sages-init", {
		description: "[Sages] 创建 .sages/workspace/ 目录 (sage 工具的产出位置)",
		handler: async (_args, ctx) => {
			const workspacePath = path.join(ctx.cwd, WORKSPACE_DIR);
			if (fs.existsSync(workspacePath)) {
				ctx.ui.notify(
					`[Sages] ${WORKSPACE_DIR} 已存在,无需初始化`,
					"info",
				);
				return;
			}
			fs.mkdirSync(workspacePath, { recursive: true });
			ctx.ui.notify(
				`[Sages] 已创建 ${WORKSPACE_DIR}\n` +
					`sage 工具 (fuxi_design / qiaochui_review / luban_execute_task / gaoyao_audit 等)\n` +
					`现在可以开始使用 — 直接说 "design a thing" 即可,无需更多命令。`,
				"info",
			);
		},
	});

	// ─── /sages-plan:手动 gate 通知 (无消费者;LLM 通过自然语言推进) ───
	pi.registerCommand("sages-plan", {
		description: "[Sages] 手动 gate 通知 — sage 工具的响应已经隐含 plan 状态",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"[Sages] plan acknowledged. sage 工具 (fuxi_design / qiaochui_decompose) 通过观察周期 (observe cycle) 处理 plan 状态。",
				"info",
			);
		},
	});
}
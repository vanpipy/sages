/**
 * Sages Tool - 工作流级别 slash command 集合(修复版 v2)
 *
 * 修复内容(相对 v1):
 * - [M1] /sages-init 复制 workflow 模板文件(four-sages.yaml, bugfix.yaml) + prompts
 * - [M5] /sages-workflow 切换时检查 onSwitch: strict 策略
 * - [m3] /sages-workflow list 显示当前 active workflow
 *
 * 保留 4 个命令:
 * - /sages-init      初始化 .sages/workflow.yaml + 复制模板
 * - /sages-plan      批准 plan(唯一手动 gate)
 * - /sages-status    统一状态查询
 * - /sages-workflow  切换/列出 workflow
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// package 根目录(extensions/ 的上一级)
const PACKAGE_ROOT = path.resolve(__dirname, "..");

// 模板源路径(package 内)
const TEMPLATE_WORKFLOW_DIR = path.join(PACKAGE_ROOT, ".sages", "workflows");
const TEMPLATE_PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

// [m1] 终态 stage IDs——workflow 终止状态(不再自动推进)
// 推导来源:workflow YAML 中 `terminal: true` 的 stage id,目前是 "complete" 和 "idle"
const TERMINAL_STAGES = ["complete", "idle"] as const;
const isTerminalStage = (stage: string | undefined): boolean =>
	!!stage && (TERMINAL_STAGES as readonly string[]).includes(stage);

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
					`运行 /sages-plan 开始 workflow,或 /sages-status 查看状态`,
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

	// ─── /sages-status:统一状态查询 ───
	pi.registerCommand("sages-status", {
		description: "[Sages] 显示当前 workflow 状态",
		handler: async (_args, ctx) => {
			const status = await new Promise<unknown>((resolve) => {
				// [修复] pi.events.on() 返回 unsubscribe 函数,而非 off() 方法
				const unsubscribe = pi.events.on("sages:status-response", (payload: unknown) => {
					unsubscribe();
					resolve(payload);
				});
				pi.events.emit("sages:status-request", undefined);
				setTimeout(() => {
					unsubscribe();
					resolve({ error: "FSM 未响应(可能未加载)" });
				}, 1000);
			});

			const formatted = JSON.stringify(status, null, 2);
			console.log(`[sages-status]\n${formatted}`);
			ctx.ui.notify(`Sages status:\n${formatted}`, "info");
		},
	});

	// ─── /sages-workflow:切换/列出 workflow ───
	pi.registerCommand("sages-workflow", {
		description: "[Sages] 切换或列出 workflow 用法:/sages-workflow [name|list|current]",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const sagesDir = path.join(ctx.cwd, ".sages");
			const configPath = path.join(sagesDir, "workflow.yaml");
			const statePath = path.join(sagesDir, "workspace", "state.json");

			// ── 子命令:list ──
			if (trimmed === "list" || trimmed === "") {
				const workflowsDir = path.join(sagesDir, "workflows");
				if (!fs.existsSync(workflowsDir)) {
					ctx.ui.notify("[Sages] workflows/ 目录不存在", "warning");
					return;
				}
				const files = fs
					.readdirSync(workflowsDir)
					.filter((f) => f.endsWith(".yaml"))
					.map((f) => f.replace(/\.yaml$/, ""));

				// [m3] 标记当前 active
				let active = "";
				if (fs.existsSync(configPath)) {
					try {
						const config = yaml.load(fs.readFileSync(configPath, "utf-8")) as {
							spec: { activeWorkflow: string };
						};
						active = config.spec.activeWorkflow;
					} catch {
						/* ignore */
					}
				}

				const formatted = files
					.map((f) => (f === active ? `* ${f} (active)` : `  ${f}`))
					.join("\n");
				ctx.ui.notify(`[Sages] 可用 workflow:\n${formatted}`, "info");
				return;
			}

			// ── 子命令:current ──
			if (trimmed === "current") {
				if (!fs.existsSync(configPath)) {
					ctx.ui.notify("[Sages] .sages/workflow.yaml 不存在", "warning");
					return;
				}
				const config = yaml.load(fs.readFileSync(configPath, "utf-8")) as {
					spec: { activeWorkflow: string };
				};
				ctx.ui.notify(`[Sages] 当前 workflow: ${config.spec.activeWorkflow}`, "info");
				return;
			}

			// ── 子命令:切换 ──
			if (!fs.existsSync(configPath)) {
				ctx.ui.notify(
					"[Sages] .sages/workflow.yaml 不存在,先运行 /sages-init",
					"warning"
				);
				return;
			}

			// [M5] 检查 onSwitch: strict
			let config: { spec: { activeWorkflow: string; onSwitch?: string } };
			try {
				config = yaml.load(fs.readFileSync(configPath, "utf-8")) as {
					spec: { activeWorkflow: string; onSwitch?: string };
				};
			} catch (err) {
				ctx.ui.notify(`[Sages] workflow.yaml 解析失败: ${(err as Error).message}`, "error");
				return;
			}

			if (config.spec.onSwitch === "strict" && fs.existsSync(statePath)) {
				try {
					const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
						workflow?: { name: string };
						currentStage?: string;
					};
					// [m1] 使用常量判断终态,避免硬编码字符串
					if (!isTerminalStage(state.currentStage)) {
						ctx.ui.notify(
							`[Sages] strict 模式:workflow ${state.workflow?.name || "?"} ` +
								`在 ${state.currentStage || "?"} 阶段未完成,无法切换到 ${trimmed}。\n` +
								`先 /sages-plan 批准完成,或删除 .sages/workspace/state.json 重置`,
							"error"
						);
						return;
					}
				} catch {
					/* state 损坏也允许切换 */
				}
			}

			const workflowsDir = path.join(sagesDir, "workflows");
			const workflowFile = path.join(workflowsDir, `${trimmed}.yaml`);
			if (!fs.existsSync(workflowFile)) {
				ctx.ui.notify(`[Sages] workflow 不存在: ${trimmed}`, "error");
				return;
			}

			const oldWorkflow = config.spec.activeWorkflow;
			// activeWorkflow = trimmed (mutation below)
			config.spec.activeWorkflow = trimmed;

			const newYaml = yaml.dump(config, { lineWidth: 100 });
			fs.writeFileSync(configPath, newYaml);

			pi.events.emit("sages:workflow-switched", {
				from: oldWorkflow,
				to: trimmed,
				at: Date.now(),
			});

			ctx.ui.notify(
				`[Sages] workflow 已切换: ${oldWorkflow} → ${trimmed}\n` +
					`(FSM 正在重载...)`,
				"info"
			);
		},
	});
}
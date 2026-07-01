/**
 * Sages FSM Runtime (修复版 v2)
 *
 * 修复内容(相对 v1):
 * - [C1] 变量插值 ${workspace}/${planName}/${timestamp} 实现
 * - [C2] file-content-match 用 substring 匹配,避免正则语法错误
 * - [C3] onVerdict 字段实现:file-content-match 后解析 verdict
 * - [C4] file-exists 用绝对路径精确匹配,不用 basename
 * - [C5] 监听 sages:workflow-switched 重新加载 FSM
 * - [C6] prompt 文件缺失时抛错,不静默卡住
 * - [M2] trigger 字段在 transition 时检查
 * - [M3] qualityGates 在 stage 完成时执行
 * - [M5] onSwitch 策略由 /sages-workflow 命令实现
 * - [M6] 死锁检测(同 stage 访问 > 5 次强制终止)
 * - [M7] transition 验证 from → to 边在 workflow 图中存在
 * - [M8] workflow.version 统一为 string
 *
 * Source verification:
 * - pi 0.79.10: src/core/extensions/runner.ts:812 (emitToolResult)
 * - pi 0.79.10: src/core/agent-session.ts:438-444
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as yaml from "js-yaml";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	registerFuxiTools,
	registerQiaoChuiTools,
	registerLubanTools,
	registerGaoYaoTools,
} from "../src/tools/index.js";
import { validateWorkflow, validateWorkflowConfig } from "../src/workflow-schema.js";

// ────────────────────────────────────────────────────────────
// 运行时类型(简化)
// ────────────────────────────────────────────────────────────

type Stage = {
	id: string;
	sage?: string;
	prompt?: string;
	trigger?: Trigger;
	completion?: Completion;
	qualityGates?: QualityGate[];
	onComplete?: { transition?: string; inject?: string; log?: string };
	onFail?: { transition?: string; inject?: string };
	onVerdict?: Record<string, { transition: string; inject?: string }>;
	action?: { type: string; command: string };
	terminal?: boolean;
	onEnter?: { notify?: string };
};

type Trigger =
	| { type: "state-absent"; path?: string }
	| { type: "state-field"; path?: string; field?: string; value?: unknown; op?: string }
	| { type: "file-exists"; path?: string; minSize?: number }
	| { type: "files-exist"; files?: string[] }
	| { type: "file-absent"; path?: string }
	| { type: "command"; command?: string };

type Completion =
	| { type: "file-exists"; path?: string; minSize?: number; schema?: string }
	| { type: "files-exist"; files?: string[]; schema?: string }
	| { type: "state-field"; path?: string; field?: string; op?: string; value?: unknown }
	| { type: "file-content-match"; path?: string; pattern?: string };

type QualityGate = {
	name: string;
	metric: string;
	command?: string;
	path?: string;
	enforcement: "advisory" | "soft-mandatory" | "hard-mandatory";
};

type Workflow = {
	apiVersion: string;
	kind: "Workflow";
	metadata: { name: string; description?: string; version?: number };
	spec: {
		triggers?: Array<{ event: string; patterns?: string[] }>;
		defaults?: { workspace?: string; timeout?: string; onFailure?: { strategy: string } };
		// [重构] plan 阶段自动通过——默认 true
		autoApprovePlans?: boolean;
		stages: Stage[];
	};
};

type WorkflowConfig = {
	apiVersion: string;
	kind: "WorkflowConfig";
	metadata: { name: string };
	spec: {
		activeWorkflow: string;
		aliases?: Record<string, string>;
		workflowDir?: string;
		onSwitch?: "strict" | "discard" | "migrate";
		bootstrap?: {
			onMissingConfig?: "fallback-to-default" | "error";
			onEmptyWorkspace?: "prompt-init" | "auto-init";
		};
	};
};

type StateJson = {
	planName?: string;
	phase?: string;
	currentStage?: string;
	workflow?: { name: string; version: string };
	request?: string;
	score?: number;
	executeStatus?: string;
	auditVerdict?: string;
	history?: Array<{ from: string; to: string; evidence: string; at: number }>;
	[key: string]: unknown;
};

type TransitionContext = {
	from: string;
	to: string;
	evidence: string;
	at: number;
};

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────

const MAX_VISITS_PER_STAGE = 5; // [M6] 死锁阈值

// ────────────────────────────────────────────────────────────
// FSM 引擎
// ────────────────────────────────────────────────────────────

class SagesFSM {
	private workflow!: Workflow;
	private config!: WorkflowConfig;
	private state: StateJson = {};
	private workspace = ".sages/workspace";
	private cwd = process.cwd();
	private active = false;
	private manualApproval = false; // [重构] /sages-plan 手动批准门
	private ctx: { ui?: { notify?: (text: string, type?: string) => void } } = {};

	// [m2] 统一的通知接口——优先 UI,降级 console
	private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (this.ctx.ui?.notify) {
			this.ctx.ui.notify(`[Sages] ${message}`, type);
		} else if (type === "error") {
			console.error(`[Sages] ${message}`);
		} else if (type === "warning") {
			console.warn(`[Sages] ${message}`);
		} else {
			console.log(`[Sages] ${message}`);
		}
	}

	// ─── 变量插值 [C1] ───
	private substituteVars(template: string, extra?: Record<string, string>): string {
		if (!template) return template;
		const ctx = {
			workspace: this.workspace,
			planName: this.state.planName || "unnamed",
			timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
			workflowName: this.workflow?.metadata?.name || "unknown",
			...extra,
		};
		return template.replace(/\$\{(\w+)\}/g, (_, key) => ctx[key as keyof typeof ctx] || `\${${key}}`);
	}

	private resolvePath(template: string): string {
		const substituted = this.substituteVars(template);
		if (path.isAbsolute(substituted)) return substituted;
		return path.join(this.cwd, substituted);
	}

	// ─── 加载配置 ───
	load(cwd: string): { loaded: boolean; reason?: string } {
		this.cwd = cwd;
		const configPath = path.join(cwd, ".sages", "workflow.yaml");

		// 缺失配置 → fallback to default
		if (!fs.existsSync(configPath)) {
			this.loadDefaultWorkflow();
			return { loaded: true, reason: "config-missing-using-default" };
		}

		try {
			const configRaw = fs.readFileSync(configPath, "utf-8");
			const configParsed = yaml.load(configRaw) as unknown;

			const configCheck = validateWorkflowConfig(configParsed);
			if (!configCheck.valid) {
				return { loaded: false, reason: `config-schema-invalid: ${configCheck.errors.join(", ")}` };
			}
			this.config = configParsed as WorkflowConfig;

			if (!this.config.spec?.activeWorkflow) {
				return { loaded: false, reason: "config-missing-activeWorkflow" };
			}

			const alias = this.config.spec.aliases?.[this.config.spec.activeWorkflow];
			const workflowName = alias || this.config.spec.activeWorkflow;
			const workflowDir = this.config.spec.workflowDir || "./.sages/workflows";
			const workflowPath = path.join(cwd, workflowDir, `${workflowName}.yaml`);

			if (!fs.existsSync(workflowPath)) {
				return { loaded: false, reason: `workflow-not-found: ${workflowPath}` };
			}

			const workflowRaw = fs.readFileSync(workflowPath, "utf-8");
			const workflowParsed = yaml.load(workflowRaw) as unknown;

			const workflowCheck = validateWorkflow(workflowParsed);
			if (!workflowCheck.valid) {
				return { loaded: false, reason: `workflow-schema-invalid: ${workflowCheck.errors.join(", ")}` };
			}
			this.workflow = workflowParsed as Workflow;
			this.workspace = this.workflow.spec.defaults?.workspace || ".sages/workspace";
			return { loaded: true };
		} catch (err) {
			return { loaded: false, reason: `load-error: ${(err as Error).message}` };
		}
	}

	private loadDefaultWorkflow() {
		this.workflow = {
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "Workflow",
			metadata: { name: "four-sages-default", version: 1 },
			spec: {
				stages: [
					{ id: "design", sage: "fuxi", trigger: { type: "state-absent", path: "draft.md" } },
					{ id: "review", sage: "qiaochui", trigger: { type: "file-exists", path: "draft.md" } },
					{ id: "complete", terminal: true },
				],
			},
		};
	}

	// ─── 加载/保存 state ───
	loadState(): { ok: boolean; reason?: string } {
		const statePath = this.resolvePath(path.join(this.workspace, "state.json"));
		// [m2] 区分文件不存在 vs 其他错误
		if (!fs.existsSync(statePath)) {
			this.state = {
				workflow: {
					name: this.workflow.metadata.name,
					version: String(this.workflow.metadata.version || 1),
				},
			};
			return { ok: true, reason: "state-not-found-using-default" };
		}

		try {
			const raw = fs.readFileSync(statePath, "utf-8");
			const parsed = JSON.parse(raw) as StateJson;
			// [M8] workflow.version 统一为 string
			if (!parsed.workflow) {
				parsed.workflow = {
					name: "legacy",
					version: "0.0.0",
				};
			} else if (typeof parsed.workflow.version === "number") {
				parsed.workflow.version = String(parsed.workflow.version);
			}
			this.state = parsed;
			return { ok: true };
		} catch (err) {
			// JSON 损坏 或 IO 错误 —— 报错但不静默覆盖
			const reason = (err as Error).message;
			this.notify(`state.json 加载失败: ${reason}`, "error");
			// 使用默认但不保存(避免覆盖损坏文件)
			this.state = {
				workflow: {
					name: this.workflow.metadata.name,
					version: String(this.workflow.metadata.version || 1),
				},
			};
			return { ok: false, reason: `state-corrupt: ${reason}` };
		}
	}

	saveState(): void {
		const statePath = this.resolvePath(path.join(this.workspace, "state.json"));
		try {
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			// [M8] 写入时也确保 version 是 string
			if (this.state.workflow && typeof this.state.workflow.version === "number") {
				this.state.workflow.version = String(this.state.workflow.version);
			}
			fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2));
		} catch (err) {
			this.notify(`saveState failed: ${(err as Error).message}`, "error");
		}
	}

	// ─── [M2] Trigger 检查 ───
	private isTriggerSatisfied(trigger: Trigger | undefined): boolean {
		if (!trigger) return true;

		switch (trigger.type) {
			case "state-absent": {
				if (!trigger.path) return true;
				const fullPath = this.resolvePath(trigger.path);
				return !fs.existsSync(fullPath);
			}
			case "file-absent": {
				if (!trigger.path) return true;
				const fullPath = this.resolvePath(trigger.path);
				return !fs.existsSync(fullPath);
			}
			case "file-exists": {
				if (!trigger.path) return true;
				const fullPath = this.resolvePath(trigger.path);
				return fs.existsSync(fullPath);
			}
			case "files-exist": {
				if (!trigger.files) return true;
				return trigger.files.every((f) => fs.existsSync(this.resolvePath(f)));
			}
			case "state-field": {
				if (!trigger.path || !trigger.field) return true;
				const fullPath = this.resolvePath(trigger.path);
				if (!fs.existsSync(fullPath)) return false;
				try {
					const data = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
					const v = data[trigger.field];
					if (trigger.op === ">=") return (v as number) >= (trigger.value as number);
					if (trigger.op === "==") return v === trigger.value;
					if (trigger.op === "!=") return v !== trigger.value;
					return v === trigger.value;
				} catch {
					return false;
				}
			}
			case "command":
				// [重构] command 触发器受 autoApprovePlans 控制:
				//   - autoApprovePlans !== false(默认 true): 自动通过
				//   - autoApprovePlans === false: 需要用户在 /sages-plan 中手动批准
				if (this.workflow.spec.autoApprovePlans !== false) {
					return true;
				}
				return this.manualApproval;
			default:
				return true;
		}
	}

	// ─── Stage 完成检测 ───
	private isStageComplete(
		stage: Stage,
		evidence: { toolName: string; path: string; content?: string }
	): boolean {
		const c = stage.completion;
		if (!c) return false;

		switch (c.type) {
			case "file-exists": {
				if (!c.path) return false;
				const expectedPath = this.resolvePath(c.path);
				// [C4] 严格路径匹配,不用 basename
				if (path.resolve(evidence.path) !== path.resolve(expectedPath)) return false;
				if (c.minSize && (evidence.content?.length || 0) < c.minSize) return false;
				return true;
			}
			case "files-exist": {
				if (!c.files) return false;
				// 检查所有文件存在
				return c.files.every((f) => fs.existsSync(this.resolvePath(f)));
			}
			case "state-field": {
				if (!c.path || !c.field) return false;
				const fullPath = this.resolvePath(c.path);
				if (!fs.existsSync(fullPath)) return false;
				try {
					const data = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
					const v = data[c.field];
					if (c.op === ">=") return (v as number) >= (c.value as number);
					if (c.op === "==") return v === c.value;
					return v === c.value;
				} catch {
					return false;
				}
			}
			case "file-content-match": {
				if (!c.path || !c.pattern) return false;
				const fullPath = this.resolvePath(c.path);
				if (!fs.existsSync(fullPath)) return false;
				const content = fs.readFileSync(fullPath, "utf-8");
				// [C2] 用 substring 匹配,避免正则语法错误
				return content.includes(c.pattern);
			}
			default:
				return false;
		}
	}

	// ─── [C3] Verdict 提取 ───
	private extractVerdict(content: string): "PASS" | "REJECTED" | "NEEDS_CHANGES" | null {
		const match = content.match(/\*\*Verdict\*\*:\s*(\w+)/);
		if (!match) return null;
		const v = match[1];
		if (v === "PASS" || v === "REJECTED" || v === "NEEDS_CHANGES") return v;
		return null;
	}

	// ─── [M3] QualityGate 执行 ───
	private runQualityGates(stage: Stage, ctx: ExtensionAPI): { passed: boolean; failed: string[] } {
		if (!stage.qualityGates || stage.qualityGates.length === 0) {
			return { passed: true, failed: [] };
		}
		const failed: string[] = [];
		for (const gate of stage.qualityGates) {
			let ok = true;
			if (gate.metric === "file-exists" && gate.path) {
				ok = fs.existsSync(this.resolvePath(gate.path));
			} else if (gate.metric === "test-result" && gate.command) {
				try {
					execSync(gate.command, {
						cwd: this.cwd,
						stdio: "pipe",
						timeout: 60000,
					});
					ok = true;
				} catch {
					ok = false;
				}
			}
			if (!ok) {
				failed.push(gate.name);
				if (gate.enforcement === "hard-mandatory") {
					return { passed: false, failed: [gate.name] };
				}
			}
		}
		return { passed: failed.length === 0, failed };
	}

	// ─── [M6] 死锁检测 ───
	private getVisitCount(stageId: string): number {
		return this.state.history?.filter((h) => h.to === stageId).length || 0;
	}

	// ─── Stage 推进 ───
	advance(
		evidence: { toolName: string; path: string; content?: string },
		pi: ExtensionAPI
	): boolean {
		if (!this.active) return false;
		const currentId = this.state.currentStage || "idle";
		const currentStage = this.workflow.spec.stages.find((s) => s.id === currentId);
		if (!currentStage) return false;

		if (this.isStageComplete(currentStage, evidence)) {
			// [M3] 先跑 qualityGates
			const gateResult = this.runQualityGates(currentStage, pi);
			if (!gateResult.passed) {
				this.notify(
					`stage ${currentStage.id} qualityGates 失败: ${gateResult.failed.join(", ")}`,
					"error"
				);
				return false;
			}

			// [C3] onVerdict 优先:如果当前 stage 有 onVerdict 且 evidence 含 content
			if (currentStage.onVerdict && evidence.content) {
				const verdict = this.extractVerdict(evidence.content);
				if (verdict && currentStage.onVerdict[verdict]) {
					const branch = currentStage.onVerdict[verdict];
					// [修复] 将 verdict 写入 state.json，供下一 stage 的 trigger 依赖
					this.state.auditVerdict = verdict;
					return this.transition(branch.transition, evidence, pi, branch.inject);
				}
			}

			// 普通 onComplete
			const target = currentStage.onComplete?.transition || "complete";
			return this.transition(target, evidence, pi, currentStage.onComplete?.inject);
		}
		return false;
	}

	transition(
		toStage: string,
		evidence: { toolName?: string; path?: string; content?: string },
		pi: ExtensionAPI,
		injectMsg?: string
	): boolean {
		const from = this.state.currentStage || "idle";
		const target = this.workflow.spec.stages.find((s) => s.id === toStage);
		if (!target) {
			this.notify(`transition target not found: ${toStage}`, "error");
			return false;
		}

		// [M7] 验证 from → to 边是否合法
		const currentStage = this.workflow.spec.stages.find((s) => s.id === from);
		if (currentStage && from !== "idle") {
			const validTransitions = [
				currentStage.onComplete?.transition,
				currentStage.onFail?.transition,
				...Object.values(currentStage.onVerdict || {}).map((v) => v.transition),
			].filter(Boolean);
			if (validTransitions.length > 0 && !validTransitions.includes(toStage)) {
				this.notify(
					`invalid transition ${from} → ${toStage} (current stage's transitions do not target this)`,
					"error"
				);
				return false;
			}
		}

		// [M2] 检查 target stage 的 trigger
		// [修复] 先保存 state,保证 trigger 检查能读到刚设置的字段
		this.saveState();
		if (!this.isTriggerSatisfied(target.trigger)) {
			this.notify(
				`${toStage} 的 trigger 未满足:${JSON.stringify(target.trigger)}`,
				"warning"
			);
			return false;
		}

		// [M6] 死锁检测
		const visits = this.getVisitCount(toStage);
		if (visits >= MAX_VISITS_PER_STAGE) {
			this.notify(
				`${toStage} 访问 ${visits} 次(>${MAX_VISITS_PER_STAGE}),可能死锁,终止`,
				"error"
			);
			this.active = false;
			return false;
		}

		// [C6] 验证 prompt 文件存在
		let promptText: string | null = null;
		if (target.prompt) {
			const promptPath = this.resolvePath(target.prompt);
			if (!fs.existsSync(promptPath)) {
				const err = `prompt file not found: ${promptPath}`;
				this.notify(err, "error");
				return false; // 不进入下一阶段
			}
			promptText = fs.readFileSync(promptPath, "utf-8");
		}

		// 记录转换
		const transitionEntry: TransitionContext = {
			from,
			to: toStage,
			evidence: `${evidence.toolName || "manual"}: ${evidence.path || "n/a"}`,
			at: Date.now(),
		};
		this.state.currentStage = toStage;
		this.state.history = this.state.history || [];
		this.state.history.push(transitionEntry);
		this.saveState();

		// [重构] 转换后消费手动批准——下一次需要重新批准
		this.manualApproval = false;

		// 持久化到 session
		pi.appendEntry("sages-fsm-transition", transitionEntry);

		// 日志
		if (target.onComplete?.log) {
			this.notify(target.onComplete.log);
		}
		if (target.onEnter?.notify) {
			this.notify(target.onEnter.notify);
		}

		// 注入 prompt
		if (promptText) {
			pi.sendUserMessage(`[Sages FSM] 进入 ${toStage} 阶段。\n\n${promptText}`, {
				deliverAs: "followUp",
			});
		}

		// 注入 inject 消息(transition 时的额外提示)
		if (injectMsg) {
			pi.sendUserMessage(`[Sages FSM] ${injectMsg}`, { deliverAs: "followUp" });
		}

		// terminal
		if (target.terminal) {
			this.active = false;
		}

		// 执行 action(如果定义)
		if (target.action) {
			this.executeAction(target.action, pi);
		}

		this.notify(`${from} → ${toStage}`);
		return true;
	}

	private executeAction(action: { type: string; command: string }, _pi: ExtensionAPI): void {
		if (action.type !== "shell") {
			this.notify(`unknown action type: ${action.type}`, "warning");
			return;
		}
		const cmd = this.substituteVars(action.command);
		try {
			const output = execSync(cmd, {
				cwd: this.cwd,
				stdio: "pipe",
				timeout: 30000,
			});
			this.notify(`action output: ${output.toString().slice(0, 200)}`);
		} catch (err) {
			this.notify(`action failed: ${(err as Error).message}`, "error");
		}
	}

	// ─── 启动 / 恢复 ───
	start(pi: ExtensionAPI): void {
		this.active = true;
		// [M1] 运行时防御:stages 为空时保护
		const firstStage = this.workflow.spec.stages[0];
		if (!firstStage) {
			const err = "workflow has no stages";
			this.notify(err, "error");
			this.active = false;
			return;
		}
		const stage = this.state.currentStage || firstStage.id;
		this.state.currentStage = stage;
		this.saveState();
		this.notify(
			`workflow '${this.workflow.metadata.name}' started at stage '${stage}'`
		);

		const currentStageDef = this.workflow.spec.stages.find((s) => s.id === stage);
		if (currentStageDef?.prompt) {
			const promptPath = this.resolvePath(currentStageDef.prompt);
			if (fs.existsSync(promptPath)) {
				const promptText = fs.readFileSync(promptPath, "utf-8");
				pi.sendUserMessage(
					`[Sages FSM] workflow 启动,当前阶段: ${stage}\n\n${promptText}`,
					{ deliverAs: "followUp" }
				);
			} else {
				this.ctx.ui?.notify?.(
					`[Sages FSM] prompt 缺失,workflow 暂停:${promptPath}`,
					"error"
				);
			}
		}
	}

	getStatus(): object {
		return {
			workflow: this.workflow?.metadata.name,
			currentStage: this.state.currentStage,
			history: this.state.history?.slice(-5) || [],
			score: this.state.score,
			executeStatus: this.state.executeStatus,
			auditVerdict: this.state.auditVerdict,
		};
	}

	// [重构] /sages-plan 手动批准——被 EventBus 监听器调用
	approveCurrentStage(): void {
		this.manualApproval = true;
	}
}

// ────────────────────────────────────────────────────────────
// Extension 入口
// ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const fsm = new SagesFSM();
	let savedCtx: { cwd: string; ui?: { notify?: (text: string, type?: string) => void } } = {
		cwd: process.cwd(),
	};

	// 注册 sage 工具(LLM 用)
	registerFuxiTools(pi);
	registerQiaoChuiTools(pi);
	registerLubanTools(pi);
	registerGaoYaoTools(pi);

	// session_start
	pi.on("session_start", async (_event, ctx) => {
		savedCtx = { cwd: ctx.cwd, ui: ctx.ui as { notify?: (text: string, type?: string) => void } };
		(fsm as unknown as { ctx: typeof savedCtx }).ctx = savedCtx;

		const result = fsm.load(ctx.cwd);
		if (!result.loaded) {
			ctx.ui.notify(`[Sages] workflow 加载失败: ${result.reason}`, "error");
			return;
		}

		fsm.loadState();
		fsm.start(pi);
		const status = fsm.getStatus() as { workflow?: string };
		ctx.ui.notify(`Sages workflow loaded: ${status.workflow}`, "info");
	});

	// [C5] 监听 workflow 切换事件,重新加载 FSM
	pi.events.on("sages:workflow-switched", async (payload) => {
		const event = payload as { from: string; to: string; at: number };
		if (!savedCtx.cwd) return;
		const result = fsm.load(savedCtx.cwd);
		if (result.loaded) {
			fsm.loadState();
			fsm.start(pi);
			savedCtx.ui?.notify?.(`[Sages] workflow 已切换到: ${event.to}`, "info");
		} else {
			savedCtx.ui?.notify?.(`[Sages] 切换失败: ${result.reason}`, "error");
		}
	});

	// tool_result
	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const path_ = (event.input as { path?: string }).path;
		const content = (event.input as { content?: string }).content;
		if (!path_) return;

		fsm.advance({ toolName: event.toolName, path: path_, content }, pi);
	});

	// EventBus: status 请求响应
	pi.events.on("sages:status-request", () => {
		pi.events.emit("sages:status-response", fsm.getStatus());
	});

	// [重构] 监听 /sages-plan 手动批准
	pi.events.on("sages:plan-approved", () => {
		fsm.approveCurrentStage();
		// 手动批准后立即重新检查当前 stage——若 plan 阶段完成,可推进
		const ws = fsm["workspace"] || ".sages/workspace";
		const planMd = path.join(savedCtx.cwd, ws, "plan.md");
		const execYaml = path.join(savedCtx.cwd, ws, "execution.yaml");
		if (fs.existsSync(planMd) && fs.existsSync(execYaml)) {
			fsm.advance(
				{ toolName: "write", path: planMd, content: fs.readFileSync(planMd, "utf-8") },
				pi,
			);
		}
	});
}

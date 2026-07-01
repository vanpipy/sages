/**
 * Workflow YAML Schema(typebox 校验)
 *
 * 校验 .sages/workflow.yaml (WorkflowConfig) 和 .sages/workflows/{name}.yaml (Workflow)
 *
 * 用 typebox 而非 JSON Schema:
 * - 复用现有 typebox 依赖
 * - 编译时类型派生
 * - 与 LLM tool 参数 schema 同源
 */

import { Type, type Static } from "typebox";

// ──────────────────────────────────────────────
// 基础类型
// ──────────────────────────────────────────────

// 注意:typebox 的 Type.Union 不自动按字段名做 discriminator,
// 所以这里用宽松的 Type.Object 包含所有可能的字段,
// 运行时由 FSM 根据 type 字段选择具体逻辑。
const Trigger = Type.Object({
	type: Type.Union([
		Type.Literal("state-absent"),
		Type.Literal("state-field"),
		Type.Literal("file-exists"),
		Type.Literal("files-exist"),
		Type.Literal("file-absent"),
		Type.Literal("command"),
	]),
	path: Type.Optional(Type.String()),
	files: Type.Optional(Type.Array(Type.String())),
	field: Type.Optional(Type.String()),
	value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
	op: Type.Optional(Type.Union([Type.Literal(">="), Type.Literal("=="), Type.Literal("!=")])),
	minSize: Type.Optional(Type.Number({ minimum: 0 })),
	command: Type.Optional(Type.String({ pattern: "^/" })),
});

const Completion = Type.Object({
	type: Type.Union([
		Type.Literal("file-exists"),
		Type.Literal("files-exist"),
		Type.Literal("state-field"),
		Type.Literal("file-content-match"),
	]),
	path: Type.Optional(Type.String()),
	files: Type.Optional(Type.Array(Type.String())),
	field: Type.Optional(Type.String()),
	value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
	op: Type.Optional(Type.Union([Type.Literal(">="), Type.Literal("=="), Type.Literal("!=")])),
	minSize: Type.Optional(Type.Number({ minimum: 0 })),
	schema: Type.Optional(Type.String()),
	pattern: Type.Optional(Type.String()),
});

const QualityGate = Type.Object({
	name: Type.String(),
	metric: Type.String(),
	command: Type.Optional(Type.String()),
	enforcement: Type.Union([
		Type.Literal("advisory"),
		Type.Literal("soft-mandatory"),
		Type.Literal("hard-mandatory"),
	]),
});

const OnComplete = Type.Object({
	transition: Type.Optional(Type.String()),
	inject: Type.Optional(Type.String()),
	log: Type.Optional(Type.String()),
});

const OnFail = Type.Object({
	transition: Type.Optional(Type.String()),
	inject: Type.Optional(Type.String()),
});

const OnVerdict = Type.Record(
	Type.String(),
	Type.Object({
		transition: Type.String(),
		inject: Type.Optional(Type.String()),
	}),
);

const Action = Type.Object({
	type: Type.String(),
	command: Type.String(),
});

// ──────────────────────────────────────────────
// Stage
// ──────────────────────────────────────────────

const Stage = Type.Object({
	id: Type.String({ pattern: "^[a-zA-Z_][a-zA-Z0-9_-]*$" }),
	sage: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String()),
	trigger: Type.Optional(Trigger),
	completion: Type.Optional(Completion),
	qualityGates: Type.Optional(Type.Array(QualityGate)),
	onComplete: Type.Optional(OnComplete),
	onFail: Type.Optional(OnFail),
	onVerdict: Type.Optional(OnVerdict),
	action: Type.Optional(Action),
	terminal: Type.Optional(Type.Boolean()),
	onEnter: Type.Optional(Type.Object({ notify: Type.Optional(Type.String()) })),
});

// ──────────────────────────────────────────────
// Workflow(完整定义)
// ──────────────────────────────────────────────

export const WorkflowSchema = Type.Object({
	apiVersion: Type.Literal("sages.io/workflow-v1alpha1"),
	kind: Type.Literal("Workflow"),
	metadata: Type.Object({
		name: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
		description: Type.Optional(Type.String()),
		author: Type.Optional(Type.String()),
		version: Type.Optional(Type.Number({ minimum: 1 })),
	}),
	spec: Type.Object({
		triggers: Type.Optional(
			Type.Array(
				Type.Object({
					event: Type.String(),
					patterns: Type.Optional(Type.Array(Type.String())),
				}),
			),
		),
		defaults: Type.Optional(
			Type.Object({
				workspace: Type.Optional(Type.String()),
				timeout: Type.Optional(Type.String()),
				onFailure: Type.Optional(Type.Object({ strategy: Type.String() })),
			}),
		),
		stages: Type.Array(Stage, { minItems: 1 }),
	}),
});

export type Workflow = Static<typeof WorkflowSchema>;

// ──────────────────────────────────────────────
// WorkflowConfig(用户配置)
// ──────────────────────────────────────────────

export const WorkflowConfigSchema = Type.Object({
	apiVersion: Type.Literal("sages.io/workflow-v1alpha1"),
	kind: Type.Literal("WorkflowConfig"),
	metadata: Type.Object({
		name: Type.String(),
		description: Type.Optional(Type.String()),
	}),
	spec: Type.Object({
		activeWorkflow: Type.String(),
		aliases: Type.Optional(Type.Record(Type.String(), Type.String())),
		workflowDir: Type.Optional(Type.String()),
		onSwitch: Type.Optional(
			Type.Union([Type.Literal("strict"), Type.Literal("discard"), Type.Literal("migrate")]),
		),
		bootstrap: Type.Optional(
			Type.Object({
				onMissingConfig: Type.Optional(
					Type.Union([Type.Literal("fallback-to-default"), Type.Literal("error")]),
				),
				onEmptyWorkspace: Type.Optional(
					Type.Union([Type.Literal("prompt-init"), Type.Literal("auto-init")]),
				),
			}),
		),
	}),
});

export type WorkflowConfig = Static<typeof WorkflowConfigSchema>;

// ──────────────────────────────────────────────
// 校验辅助函数
// ──────────────────────────────────────────────

import { Value } from "typebox/value";

export function validateWorkflow(data: unknown): { valid: boolean; errors: string[] } {
	const errors = [...Value.Errors(WorkflowSchema, data)];
	return {
		valid: errors.length === 0,
		errors: errors.map((e) => `${e.instancePath || "/"}: ${e.message}`),
	};
}

export function validateWorkflowConfig(data: unknown): { valid: boolean; errors: string[] } {
	const errors = [...Value.Errors(WorkflowConfigSchema, data)];
	return {
		valid: errors.length === 0,
		errors: errors.map((e) => `${e.instancePath || "/"}: ${e.message}`),
	};
}
/**
 * Workflow Schema 校验测试
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { validateWorkflow, validateWorkflowConfig } from "../src/workflow-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..");

describe("Workflow Schema: 合法文件", () => {
	it("four-sages.yaml 通过校验", () => {
		const raw = fs.readFileSync(
			path.join(PI_ROOT, ".sages", "workflows", "four-sages.yaml"),
			"utf-8",
		);
		const parsed = yaml.load(raw);
		const result = validateWorkflow(parsed);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("bugfix.yaml 通过校验", () => {
		const raw = fs.readFileSync(
			path.join(PI_ROOT, ".sages", "workflows", "bugfix.yaml"),
			"utf-8",
		);
		const parsed = yaml.load(raw);
		const result = validateWorkflow(parsed);
		expect(result.valid).toBe(true);
	});

	it("workflow.yaml 通过校验", () => {
		const raw = fs.readFileSync(
			path.join(PI_ROOT, ".sages", "workflow.yaml"),
			"utf-8",
		);
		const parsed = yaml.load(raw);
		const result = validateWorkflowConfig(parsed);
		expect(result.valid).toBe(true);
	});
});

describe("Workflow Schema: 非法文件", () => {
	it("缺少 apiVersion 报错", () => {
		const result = validateWorkflow({
			kind: "Workflow",
			metadata: { name: "test" },
			spec: { stages: [] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("kind 不是 Workflow 报错", () => {
		const result = validateWorkflow({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "NotWorkflow",
			metadata: { name: "test" },
			spec: { stages: [] },
		});
		expect(result.valid).toBe(false);
	});

	it("stages 为空数组报错", () => {
		const result = validateWorkflow({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "Workflow",
			metadata: { name: "test" },
			spec: { stages: [] },
		});
		expect(result.valid).toBe(false);
	});

	it("stage id 包含非法字符报错", () => {
		const result = validateWorkflow({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "Workflow",
			metadata: { name: "test" },
			spec: {
				stages: [
					{ id: "Invalid ID", trigger: { type: "file-exists", path: "x" } },
				],
			},
		});
		expect(result.valid).toBe(false);
	});

	it("WorkflowConfig 缺 activeWorkflow 报错", () => {
		const result = validateWorkflowConfig({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "WorkflowConfig",
			metadata: { name: "test" },
			spec: {},
		});
		expect(result.valid).toBe(false);
	});

	it("onSwitch 非法值报错", () => {
		const result = validateWorkflowConfig({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "WorkflowConfig",
			metadata: { name: "test" },
			spec: {
				activeWorkflow: "four-sages",
				onSwitch: "invalid-mode",
			},
		});
		expect(result.valid).toBe(false);
	});
});

describe("Workflow Schema: 真实错误捕获", () => {
	it("stage 缺 id 报错", () => {
		const result = validateWorkflow({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "Workflow",
			metadata: { name: "test" },
			spec: {
				stages: [
					{ trigger: { type: "file-exists", path: "x" } }, // 缺 id
				],
			},
		});
		expect(result.valid).toBe(false);
	});

	it("trigger 类型非法报错", () => {
		const result = validateWorkflow({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "Workflow",
			metadata: { name: "test" },
			spec: {
				stages: [
					{
						id: "test",
						trigger: { type: "unknown-type", path: "x" },
					},
				],
			},
		});
		expect(result.valid).toBe(false);
	});

	it("qualityGate enforcement 非法值报错", () => {
		const result = validateWorkflow({
			apiVersion: "sages.io/workflow-v1alpha1",
			kind: "Workflow",
			metadata: { name: "test" },
			spec: {
				stages: [
					{
						id: "test",
						qualityGates: [
							{
								name: "g1",
								metric: "file-size",
								enforcement: "super-strict", // 非法值
							},
						],
					},
				],
			},
		});
		expect(result.valid).toBe(false);
	});
});
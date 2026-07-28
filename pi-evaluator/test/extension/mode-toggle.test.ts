/**
 * pi-evaluator/test/extension/mode-toggle.test.ts
 *
 * RED-first: tests fail before src/extension.ts exists, pass after.
 *
 * Strategy: build a fake `pi` object that captures every `pi.on()` / `pi.registerTool()`
 * call. Fire captured handlers with synthesized events. Assert:
 *   1. register(pi) registers exactly 2 tools (eval_score, eval_trend)
 *   2. register(pi) subscribes to "session_start" AND "before_agent_start"
 *   3. session_start with rewardMode=true → state.mode becomes "on"
 *   4. session_start with rewardMode=false (or missing) → state.mode stays "off"
 *   5. session_start twice in a row → state.mode reflects the SECOND read (no carryover)
 *   6. before_agent_start with mode=off → returns nothing (does NOT touch systemPrompt)
 *   7. before_agent_start with mode=on → returns { systemPrompt: "<orig>\\n\\n<REWARD…>" }
 *
 * readSagesRewardMode() is mocked by overriding `process.env.HOME` to point
 * at a tempdir (the real env-driven wrapper works that way).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import registerEvaluatorExtension from "../../src/extension.ts";
import { createEvalState } from "../../src/state.ts";
import { REWARD_MODE_SYSTEM_PROMPT } from "../../src/prompts.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
};

interface FakePi {
	registeredTools: ToolDefinition[];
	eventHandlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown | Promise<unknown>>>;
	registerTool: (tool: ToolDefinition) => void;
	on: (
		event: string,
		handler: (event: unknown, ctx?: unknown) => unknown | Promise<unknown>,
	) => void;
	emit: (event: string, payload?: unknown) => Promise<unknown[]>;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown | Promise<unknown>>>();
	const registeredTools: ToolDefinition[] = [];
	return {
		registeredTools,
		eventHandlers: handlers,
		registerTool(tool) {
			registeredTools.push(tool);
		},
		on(event, handler) {
			const arr = handlers.get(event) ?? [];
			arr.push(handler);
			handlers.set(event, arr);
		},
		async emit(event, payload) {
			const arr = handlers.get(event) ?? [];
			const out: unknown[] = [];
			for (const h of arr) {
				out.push(await h(payload ?? {}, {}));
			}
			return out;
		},
	};
}

// ── Mode-toggle env helpers ──────────────────────────────────────────────────

let homeDir: string;
let originalHome: string | undefined;

function setRewardModeInSettings(value: unknown): void {
	mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
	const payload = value === undefined ? { packages: [] } : { sages: { rewardMode: value } };
	writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), JSON.stringify(payload), "utf8");
}

beforeEach(() => {
	originalHome = process.env.HOME;
	homeDir = join(tmpdir(), `pi-evaluator-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(homeDir, { recursive: true });
	process.env.HOME = homeDir;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(homeDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("register() — registration", () => {
	test("registers exactly two tools: eval_score and eval_trend", () => {
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);
		const names = pi.registeredTools.map((t) => t.name).sort();
		expect(names).toEqual(["eval_score", "eval_trend"]);
	});

	test("each registered tool has label, description, parameters, execute", () => {
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);
		for (const t of pi.registeredTools) {
			expect(typeof t.label).toBe("string");
			expect(t.label.length).toBeGreaterThan(0);
			expect(typeof t.description).toBe("string");
			expect(t.description.length).toBeGreaterThan(0);
			expect(t.parameters).toBeDefined();
			expect(typeof t.execute).toBe("function");
		}
	});

	test("subscribes to session_start and before_agent_start (at minimum)", () => {
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);
		expect(pi.eventHandlers.has("session_start")).toBe(true);
		expect(pi.eventHandlers.has("before_agent_start")).toBe(true);
	});
});

describe("register() — session_start reads rewardMode", () => {
	test("rewardMode=true → state.mode becomes on", async () => {
		setRewardModeInSettings(true);
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);

		const scoreTool = pi.registeredTools.find((t) => t.name === "eval_score");
		expect(scoreTool).toBeDefined();
		const before = await scoreTool!.execute("id", {} as never, undefined, undefined, {} as never);
		const beforeJson = JSON.parse(before.content[0]!.text);
		expect(beforeJson.status).toBe("blocked"); // default OFF state before session_start

		await pi.emit("session_start", { type: "session_start", reason: "startup" });

		const after = await scoreTool!.execute("id", {} as never, undefined, undefined, {} as never);
		const afterJson = JSON.parse(after.content[0]!.text);
		expect(afterJson.status).toBe("ok");
	});

	test("rewardMode=false → state.mode remains off", async () => {
		setRewardModeInSettings(false);
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);

		await pi.emit("session_start", { type: "session_start", reason: "startup" });

		const scoreTool = pi.registeredTools.find((t) => t.name === "eval_score")!;
		const out = await scoreTool.execute("id", {} as never, undefined, undefined, {} as never);
		const j = JSON.parse(out.content[0]!.text);
		expect(j.status).toBe("blocked");
	});

	test("rewardMode key missing → state.mode remains off", async () => {
		setRewardModeInSettings(undefined);
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);

		await pi.emit("session_start", { type: "session_start", reason: "startup" });

		const scoreTool = pi.registeredTools.find((t) => t.name === "eval_score")!;
		const out = await scoreTool.execute("id", {} as never, undefined, undefined, {} as never);
		const j = JSON.parse(out.content[0]!.text);
		expect(j.status).toBe("blocked");
	});

	test("two session_start events → state reflects the LAST read (no carryover)", async () => {
		setRewardModeInSettings(true);
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);
		await pi.emit("session_start", { type: "session_start", reason: "startup" });
		// Now flip settings to false and re-emit
		setRewardModeInSettings(false);
		await pi.emit("session_start", { type: "session_start", reason: "startup" });

		const scoreTool = pi.registeredTools.find((t) => t.name === "eval_score")!;
		const out = await scoreTool.execute("id", {} as never, undefined, undefined, {} as never);
		const j = JSON.parse(out.content[0]!.text);
		expect(j.status).toBe("blocked");
	});
});

describe("register() — before_agent_start", () => {
	test("mode off → handler returns undefined (does not modify systemPrompt)", async () => {
		setRewardModeInSettings(false);
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);
		await pi.emit("session_start", { type: "session_start", reason: "startup" });

		const handlers = pi.eventHandlers.get("before_agent_start")!;
		const result = await handlers[0]!({
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "ORIGINAL SYSTEM PROMPT",
		});
		expect(result).toBeUndefined();
	});

	test("mode on → handler returns { systemPrompt: original + REWARD_MODE_SYSTEM_PROMPT }", async () => {
		setRewardModeInSettings(true);
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);
		await pi.emit("session_start", { type: "session_start", reason: "startup" });

		const handlers = pi.eventHandlers.get("before_agent_start")!;
		const result = await handlers[0]!({
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "ORIGINAL SYSTEM PROMPT",
		});
		expect(result).toBeDefined();
		const r = result as { systemPrompt?: string };
		expect(typeof r.systemPrompt).toBe("string");
		expect(r.systemPrompt).toContain("ORIGINAL SYSTEM PROMPT");
		expect(r.systemPrompt).toContain(REWARD_MODE_SYSTEM_PROMPT);
	});

	test("mode on but original prompt is empty → still returns the augmentation (no crash)", async () => {
		setRewardModeInSettings(true);
		const pi = makeFakePi();
		registerEvaluatorExtension(pi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);
		await pi.emit("session_start", { type: "session_start", reason: "startup" });

		const handlers = pi.eventHandlers.get("before_agent_start")!;
		const result = await handlers[0]!({
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "",
		});
		const r = result as { systemPrompt?: string };
		expect(typeof r.systemPrompt).toBe("string");
		expect(r.systemPrompt).toContain(REWARD_MODE_SYSTEM_PROMPT);
	});
});

describe("createEvalState / tool wiring sanity", () => {
	test("createEvalState default is mode off / no workflow (re-export sanity)", () => {
		const s = createEvalState();
		expect(s.mode).toBe("off");
		expect(s.active_workflow).toBeNull();
	});
});

/**
 * registered-tool-wrapper.test.ts — GC-2026-090.
 *
 * Pins the contract of `wrapRegisteredTool`, the shared helper extracted
 * from the copy-pasted wrappers in 8 orchestrator tools (task_dispatch,
 * dag_synthesize, goal_contract_create, orchestrator_audit, subagent_*).
 *
 * The helper preserves the GC-2026-089 semantics:
 *   1. Awaits the execute call (so async resolves before JSON.stringify).
 *   2. Pass-through if result already has `Array.isArray(result.content)`
 *      (legacy ToolResult shape returned by some execute* functions).
 *   3. Otherwise wraps in
 *      `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
 *         details: result }`.
 *   4. On exception returns
 *      `{ content: [{ type: "text", text: "<toolName> error: <message>" }],
 *         details: { status: "error", error: <message> } }`.
 *
 * Run: cd pi-orchestrator && bun test ./test/tools/orchestrator/registered-tool-wrapper.test.ts
 */

import { describe, expect, it } from "bun:test";

import { wrapRegisteredTool, type ToolResult } from "@/registered-tool-wrapper.js";

// ───────────────────────────────────────────────────────────────────────
// Result-shape helpers
// ───────────────────────────────────────────────────────────────────────

interface ResultShape {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
}

function getText(result: unknown): string {
	const r = result as ResultShape;
	return r.content?.[0]?.text ?? "";
}

// ───────────────────────────────────────────────────────────────────────
// 1. Sync execute returning plain object
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — sync plain object", () => {
	it("wraps a synchronous plain-object return in canonical ToolResult shape", async () => {
		const execute = wrapRegisteredTool("foo_tool", (_params, _ctx) => ({
			ok: true,
			value: 42,
		}));

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		// details must equal the original return value (object identity is
		// not preserved, but deep equality is)
		expect(result.details).toEqual({ ok: true, value: 42 });
		// text must be parseable JSON of the original
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed).toEqual({ ok: true, value: 42 });
	});
});

// ───────────────────────────────────────────────────────────────────────
// 2. Async execute returning plain object
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — async plain object", () => {
	it("awaits an async execute before stringifying", async () => {
		const execute = wrapRegisteredTool(
			"async_tool",
			async (_params, _ctx) => {
				// Force the promise to settle after a microtask
				await new Promise((r) => setTimeout(r, 5));
				return { ok: true, resolved: "yes" };
			},
		);

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		expect(result.details).toEqual({ ok: true, resolved: "yes" });
		// If we had forgotten the await, content[0].text would be "{}" —
		// because JSON.stringify(Promise) === "{}".
		expect(result.content[0].text).not.toBe("{}");
		expect(result.content[0].text).toContain("resolved");
	});
});

// ───────────────────────────────────────────────────────────────────────
// 3. Sync execute throwing
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — sync throw", () => {
	it("returns an error block on synchronous throw", async () => {
		const execute = wrapRegisteredTool("boom_sync", () => {
			throw new Error("kaboom sync");
		});

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		// Error text contains the tool name AND the underlying message
		expect(result.content[0].text).toContain("boom_sync");
		expect(result.content[0].text).toContain("kaboom sync");
		expect(result.details).toEqual({
			status: "error",
			error: "kaboom sync",
		});
	});

	it("coerces non-Error thrown values to strings", async () => {
		const execute = wrapRegisteredTool("thrower", () => {
			// Simulate legacy code path: throw "string literal"
			throw "literal-string-error";
		});

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		expect(result.content[0].text).toContain("literal-string-error");
		expect(result.details).toEqual({
			status: "error",
			error: "literal-string-error",
		});
	});
});

// ───────────────────────────────────────────────────────────────────────
// 4. Async execute rejecting
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — async rejection", () => {
	it("returns an error block when async execute rejects", async () => {
		const execute = wrapRegisteredTool("boom_async", async () => {
			throw new Error("kaboom async");
		});

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		expect(result.content[0].text).toContain("boom_async");
		expect(result.content[0].text).toContain("kaboom async");
		expect(result.details).toEqual({
			status: "error",
			error: "kaboom async",
		});
	});
});

// ───────────────────────────────────────────────────────────────────────
// 5. Execute returning legacy ToolResult shape — pass-through
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — legacy ToolResult pass-through", () => {
	it("does NOT double-wrap when execute returns a ToolResult-shaped object", async () => {
		const legacyShape: ToolResult = {
			content: [{ type: "text", text: "PRE-WRAPPED" }],
			details: { already: "wrapped" },
		};

		const execute = wrapRegisteredTool(
			"legacy_tool",
			() => legacyShape,
		);

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		// Identity preserved — same object reference, not re-stringified
		expect(result).toBe(legacyShape);
		expect(result.content[0].text).toBe("PRE-WRAPPED");
	});

	it("pass-through also works for async legacy execute", async () => {
		const legacyShape: ToolResult = {
			content: [{ type: "text", text: "ASYNC-PRE-WRAPPED" }],
		};

		const execute = wrapRegisteredTool(
			"async_legacy",
			async () => legacyShape,
		);

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		expect(result).toBe(legacyShape);
	});
});

// ───────────────────────────────────────────────────────────────────────
// 6. Execute returning null
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — null return", () => {
	it("wraps a null return as the JSON literal 'null'", async () => {
		const execute = wrapRegisteredTool("null_tool", () => null);

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		expect(result.content[0].text).toBe("null");
		// details is the original null
		expect(result.details).toBeNull();
	});
});

// ───────────────────────────────────────────────────────────────────────
// 7. Execute returning undefined
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — undefined return", () => {
	it("wraps undefined — text is undefined, details is undefined", async () => {
		const execute = wrapRegisteredTool("void_tool", () => undefined);

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		// JSON.stringify(undefined) === undefined (the property is dropped
		// from objects, but at the top level the expression evaluates to
		// undefined). We assert the observable behavior: details is
		// undefined, and the text field reflects what the helper chose.
		expect(result.details).toBeUndefined();
		// content is still a single-element text array — the renderer
		// must NEVER see undefined content
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
	});
});

// ───────────────────────────────────────────────────────────────────────
// 8. Tool name in error message
// ───────────────────────────────────────────────────────────────────────

describe("wrapRegisteredTool — error message includes tool name", () => {
	it("prefixes error text with '<toolName> error:'", async () => {
		const execute = wrapRegisteredTool(
			"uniquely_named_tool",
			() => {
				throw new Error("nope");
			},
		);

		const result = (await execute(
			"id",
			{},
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as ToolResult;

		// The exact format matches the GC-2026-089 inline wrappers:
		//   `${toolName} error: ${message}`
		expect(result.content[0].text).toBe("uniquely_named_tool error: nope");
	});
});

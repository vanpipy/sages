/**
 * Functional test: sages_outline.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { installMockBridge, MockPi } from "./_mock-bridge.js";

describe("sages_outline — execute()", () => {
	let bridge: ReturnType<typeof installMockBridge>;
	let pi: MockPi;

	beforeEach(async () => {
		bridge = installMockBridge();
		pi = new MockPi();
		const mod = await import("../../src/tools/wrap/outline.js");
		mod.registerSagesOutline(
			pi as unknown as Parameters<typeof mod.registerSagesOutline>[0],
		);
	});

	afterEach(() => bridge.uninstall());

	test("forwards path to bridge.outline", async () => {
		bridge.on("outline", async () => ({
			success: true,
			text: "E fn main\n- fn helper",
		}));

		await pi.tools["sages_outline"].execute("call-1", { path: "src/main.ts" });

		expect(bridge.calls).toHaveLength(1);
		expect(bridge.calls[0].command).toBe("outline");
		expect(bridge.calls[0].params.file).toBe("src/main.ts");
	});

	test("returns bridge text as content", async () => {
		bridge.on("outline", async () => ({
			success: true,
			text: "E class Foo\n  E method bar",
		}));

		const result = await pi.tools["sages_outline"].execute("call-1", {
			path: "src/foo.ts",
		});

		expect(result.content[0].text).toBe("E class Foo\n  E method bar");
	});

	test("falls back to (empty) when bridge returns no text", async () => {
		bridge.on("outline", async () => ({ success: true, text: "" }));

		const result = await pi.tools["sages_outline"].execute("call-1", {
			path: "empty.ts",
		});

		expect(result.content[0].text).toBe("(empty)");
	});
});
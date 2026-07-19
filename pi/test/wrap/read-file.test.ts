/**
 * Functional test: sages_read_file.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { installMockBridge, MockPi } from "./_mock-bridge.js";

describe("sages_read_file — execute()", () => {
	let bridge: ReturnType<typeof installMockBridge>;
	let pi: MockPi;

	beforeEach(async () => {
		bridge = installMockBridge();
		pi = new MockPi();
		const mod = await import("../../src/tools/wrap/read-file.js");
		mod.registerSagesReadFile(
			pi as unknown as Parameters<typeof mod.registerSagesReadFile>[0],
		);
	});

	afterEach(() => bridge.uninstall());

	test("forwards path + offset + limit to bridge.read", async () => {
		bridge.on("read", async () => ({
			success: true,
			content: "line 10\nline 11\nline 12",
		}));

		await pi.tools["sages_read_file"].execute("call-1", {
			path: "src/foo.ts",
			offset: 10,
			limit: 3,
		});

		expect(bridge.calls).toHaveLength(1);
		expect(bridge.calls[0].command).toBe("read");
		expect(bridge.calls[0].params.file).toBe("src/foo.ts");
		expect(bridge.calls[0].params.offset).toBe(10);
		expect(bridge.calls[0].params.limit).toBe(3);
	});

	test("returns bridge content as content text", async () => {
		bridge.on("read", async () => ({ success: true, content: "hello world" }));

		const result = await pi.tools["sages_read_file"].execute("call-1", {
			path: "anywhere.txt",
		});

		expect(result.content[0].text).toBe("hello world");
	});
});
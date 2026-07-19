/**
 * Functional test: sages_search.
 *
 * Verifies that sages_search.execute():
 *   - forwards pattern + path + max to bridge.grep
 *   - returns the bridge's `text` as content (or "(no matches)" if empty)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { installMockBridge, MockPi } from "./_mock-bridge.js";

describe("sages_search — execute()", () => {
	let bridge: ReturnType<typeof installMockBridge>;
	let pi: MockPi;

	beforeEach(async () => {
		bridge = installMockBridge();
		pi = new MockPi();
		const mod = await import("../../src/tools/wrap/search.js");
		mod.registerSagesSearch(
			pi as unknown as Parameters<typeof mod.registerSagesSearch>[0],
		);
	});

	afterEach(() => {
		bridge.uninstall();
	});

	test("forwards pattern + path + max to bridge.grep", async () => {
		bridge.on("grep", async () => ({ success: true, text: "3 matches" }));

		await pi.tools["sages_search"].execute("call-1", {
			pattern: "TODO",
			path: "src/",
			max: 25,
		});

		expect(bridge.calls).toHaveLength(1);
		expect(bridge.calls[0].command).toBe("grep");
		expect(bridge.calls[0].params.pattern).toBe("TODO");
		expect(bridge.calls[0].params.path).toBe("src/");
		expect(bridge.calls[0].params.max).toBe(25);
	});

	test("returns bridge text as content", async () => {
		bridge.on("grep", async () => ({
			success: true,
			text: "match found at line 42",
		}));

		const result = await pi.tools["sages_search"].execute("call-1", {
			pattern: "foo",
		});

		expect(result.content[0].text).toBe("match found at line 42");
		expect(result.isError).toBeUndefined();
	});

	test("falls back to (no matches) when bridge returns empty text", async () => {
		bridge.on("grep", async () => ({ success: true, text: "" }));

		const result = await pi.tools["sages_search"].execute("call-1", {
			pattern: "nonexistent-pattern-xyz",
		});

		expect(result.content[0].text).toBe("(no matches)");
	});

	test("path defaults to '.' when omitted", async () => {
		bridge.on("grep", async () => ({ success: true, text: "ok" }));

		await pi.tools["sages_search"].execute("call-1", { pattern: "TODO" });

		expect(bridge.calls[0].params.path).toBe(".");
	});
});
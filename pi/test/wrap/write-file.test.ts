/**
 * Functional test: sages_write_file.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { installMockBridge, MockPi } from "./_mock-bridge.js";

describe("sages_write_file — execute()", () => {
	let bridge: ReturnType<typeof installMockBridge>;
	let pi: MockPi;

	beforeEach(async () => {
		bridge = installMockBridge();
		pi = new MockPi();
		const mod = await import("../../src/tools/wrap/write-file.js");
		mod.registerSagesWriteFile(
			pi as unknown as Parameters<typeof mod.registerSagesWriteFile>[0],
		);
	});

	afterEach(() => bridge.uninstall());

	test("forwards path + content to bridge.write", async () => {
		bridge.on("write", async () => ({
			success: true,
			created: false,
			syntax_valid: true,
			backup_id: "bak-123",
		}));

		await pi.tools["sages_write_file"].execute("call-1", {
			path: "src/foo.ts",
			content: "export const x = 1;\n",
		});

		expect(bridge.calls).toHaveLength(1);
		expect(bridge.calls[0].command).toBe("write");
		expect(bridge.calls[0].params.file).toBe("src/foo.ts");
		expect(bridge.calls[0].params.content).toBe("export const x = 1;\n");
	});

	test("returns JSON with snapshot_path + aft_backup_id + undo_hint", async () => {
		bridge.on("write", async () => ({
			success: true,
			created: false,
			syntax_valid: true,
			backup_id: "bak-456",
		}));

		const result = await pi.tools["sages_write_file"].execute("call-1", {
			path: "src/foo.ts",
			content: "// hello\n",
		});

		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(true);
		expect(payload.path).toBe("src/foo.ts");
		expect(payload.snapshot_path).toBeDefined();
		expect(payload.aft_backup_id).toBe("bak-456");
		expect(payload.undo_hint).toContain("cp ");
	});

	test("reports syntax_valid=false from bridge response", async () => {
		bridge.on("write", async () => ({
			success: true,
			created: false,
			syntax_valid: false,
			backup_id: "bak-789",
		}));

		const result = await pi.tools["sages_write_file"].execute("call-1", {
			path: "src/broken.ts",
			content: "this is not typescript",
		});

		const payload = JSON.parse(result.content[0].text);
		expect(payload.syntax_valid).toBe(false);
	});
});
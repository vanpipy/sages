/**
 * Tests for the shared deprecation-stub registrar.
 *
 * The 3 role-tool files (fuxi-tools, luban/index, gaoyao/tools) used to
 * inline an identical 21-line loop. After extraction, this test pins down
 * the contract every caller relies on:
 *   - name is registered as a tool
 *   - description embeds deprecationNote + hint
 *   - execute() returns isError with a JSON payload exposing
 *     success:false, deprecated:true, hint, replacement
 */

import { describe, it, expect } from "bun:test";
import { registerDeprecationStubs, type DeprecationStub } from "../src/tools/deprecation-stubs.js";

interface RegisteredTool {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	execute?: (id: string, params: unknown) => Promise<unknown>;
}

class MockPi {
	tools: RegisteredTool[] = [];
	registerTool = (tool: RegisteredTool) => {
		this.tools.push(tool);
	};
}

describe("registerDeprecationStubs", () => {
	it("registers one tool per stub with the expected metadata", () => {
		const pi = new MockPi();
		const stubs: DeprecationStub[] = [
			{
				name: "fuxi_request",
				hint: "Use fuxi_design instead.",
				deprecationNote: "merged into fuxi_design",
			},
			{
				name: "luban_get_status",
				hint: "Use luban_execute_task.",
				deprecationNote: "status merged into response",
			},
		];
		registerDeprecationStubs(pi as any, stubs);

		expect(pi.tools).toHaveLength(2);

		const fuxi = pi.tools.find((t) => t.name === "fuxi_request")!;
		expect(fuxi.label).toBe("[Deprecated] fuxi_request");
		expect(fuxi.description).toContain("DEPRECATED (merged into fuxi_design)");
		expect(fuxi.description).toContain("Use fuxi_design instead.");
	});

	it("execute() returns isError with redirect payload", async () => {
		const pi = new MockPi();
		registerDeprecationStubs(pi as any, [
			{
				name: "fuxi_get_status",
				hint: "Use fuxi_design.",
				deprecationNote: "merged into fuxi_design",
			},
		]);

		const tool = pi.tools[0]!;
		const response = (await tool.execute!("call-1", {})) as {
			content: Array<{ type: string; text: string }>;
			isError: boolean;
			details: { deprecated: boolean; replacement: string };
		};

		expect(response.isError).toBe(true);
		expect(response.details.deprecated).toBe(true);
		// Byte-compat with the previous inline loop: details.replacement
		// carried the full hint string. The parsed tool name is exposed
		// only inside the JSON content payload.
		expect(response.details.replacement).toBe("Use fuxi_design.");

		const payload = JSON.parse(response.content[0]!.text);
		expect(payload.success).toBe(false);
		expect(payload.deprecated).toBe(true);
		expect(payload.error).toContain("fuxi_get_status is deprecated");
		expect(payload.hint).toBe("Use fuxi_design.");
		expect(payload.replacement).toBe("fuxi_design");
	});

	it("handles hints without a `Use X` prefix (replacement is null)", async () => {
		const pi = new MockPi();
		registerDeprecationStubs(pi as any, [
			{
				name: "gaoyao_check_security",
				hint: "Security moved to the CASTRATION phase.",
				deprecationNote: "merged into CASTRATION",
			},
		]);

		const tool = pi.tools[0]!;
		const response = (await tool.execute!("call-2", {})) as {
			content: Array<{ type: string; text: string }>;
		};
		const payload = JSON.parse(response.content[0]!.text);
		expect(payload.replacement).toBeNull();
	});

	it("empty stubs array is a no-op", () => {
		const pi = new MockPi();
		registerDeprecationStubs(pi as any, []);
		expect(pi.tools).toHaveLength(0);
	});
});
/**
 * Tests for aft/index.ts — public API surface.
 *
 * Verifies that all expected exports exist (compile-time) and that
 * AftBinaryNotFoundError has the correct shape.
 */

import { describe, test, expect } from "bun:test";
import * as Aft from "../../src/tools/aft/index.js";

describe("aft/index.ts (public API)", () => {
	test("exposes the expected public surface", () => {
		expect(typeof Aft.resolveAftBinary).toBe("function");
		expect(Aft.AftBinaryNotFoundError).toBeDefined();
		expect(typeof Aft.snapshot).toBe("function");
		expect(typeof Aft.restoreFromSnapshot).toBe("function");
		expect(typeof Aft.ensureConfigured).toBe("function");
		expect(typeof Aft.warmupCallgraph).toBe("function");
		expect(typeof Aft.aftErrorFromResponse).toBe("function");
		expect(typeof Aft.retryHintFor).toBe("function");
	});

	test("AftBinaryNotFoundError includes remediation hint", () => {
		const err = new Aft.AftBinaryNotFoundError("test");
		expect(err.message).toContain("npx @cortexkit/aft@latest setup");
	});

	test("AftErrorCodes is exported as a string enum", () => {
		expect(Aft.AftErrorCodes.CALLGRAPH_BUILDING).toBe("callgraph_building");
		expect(Aft.AftErrorCodes.NOT_CONFIGURED).toBe("not_configured");
	});
});

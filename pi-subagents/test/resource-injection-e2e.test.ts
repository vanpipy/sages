/**
 * resource-injection-e2e.test.ts — GC-2026-064 T3 (PoC advisory hook).
 *
 * Pins the contract for `augmentToolResultWithAdvisory`: when the monitor's
 * `shouldAdvis(snap)` returns true, the formatted `[sages resource: ...]`
 * advisory is prepended to the tool-result string. When the snapshot is
 * below threshold, the result is returned unchanged — no string
 * concatenation, no benchmark regression in the calm path.
 *
 * SC5 + SC6 of GC-2026-064.
 *
 * Test isolation: each `it` resets the monitor's mock snapshot to `null` so
 * Bun's test-order scheduling cannot leak state across cases.
 */

import { describe, expect, it, afterEach } from "vitest";

import { augmentToolResultWithAdvisory } from "../src/agent-runner.js";
import {
	ResourceMonitor,
	type ResourceSnapshot,
} from "../src/resource-monitor.js";

const highSnap: ResourceSnapshot = {
	rssMB: 14000,
	heapUsedMB: 1000,
	freeMemMB: 500,
	totalMemMB: 16000,
	loadAvg1: 3.9,
	cpuCount: 4,
	childrenCount: 8,
	timestamp: 1700000000000,
};

const lowSnap: ResourceSnapshot = {
	rssMB: 200,
	heapUsedMB: 50,
	freeMemMB: 12000,
	totalMemMB: 16000,
	loadAvg1: 0.5,
	cpuCount: 4,
	childrenCount: 0,
	timestamp: 1700000000000,
};

describe("resource-injection-e2e (GC-2026-064 T3)", () => {
	const monitor = new ResourceMonitor();

	afterEach(() => {
		// Reset the monitor's mock so cross-test leakage cannot happen.
		monitor.__setMockSnapshot(null);
	});

	it("(a) high pressure — shouldAdvis true → tool result envelope contains [sages resource:", () => {
		monitor.__setMockSnapshot(highSnap);
		const resultStr = "ls: cannot access 'foo': No such file or directory";
		const out = augmentToolResultWithAdvisory(resultStr, monitor, highSnap);
		expect(out).toMatch(/\[sages resource:/);
		// and the original tool result is preserved
		expect(out).toContain(resultStr);
		// advisory comes first, then a single newline separator, then result
		expect(out.startsWith("[sages resource:")).toBe(true);
		const nlIdx = out.indexOf("\n");
		expect(nlIdx).toBeGreaterThan(0);
		expect(out.slice(nlIdx + 1)).toBe(resultStr);
	});

	it("(b) low pressure — shouldAdvis false → tool result envelope does NOT contain [sages resource:", () => {
		monitor.__setMockSnapshot(lowSnap);
		const resultStr = "hello world\nfoo bar\n";
		const out = augmentToolResultWithAdvisory(resultStr, monitor, lowSnap);
		expect(out).not.toMatch(/\[sages resource:/);
		// and the result is returned verbatim — no concat, no copy.
		expect(out).toBe(resultStr);
	});
});

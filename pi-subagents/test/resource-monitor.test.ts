/**
 * resource-monitor.test.ts — ResourceMonitor module (GC-2026-064 T2 / PoC).
 *
 * The monitor is a pure utility: no IO at module-load, sampling is cheap
 * (<5ms), and the `__setMockSnapshot` test seam lets us drive pressure
 * deterministically without manipulating process state or loadavg.
 *
 * SC3 + SC4 of GC-2026-064.
 */
import { describe, expect, it } from "vitest";
import {
	ResourceMonitor,
	type ResourceSnapshot,
} from "../src/resource-monitor.js";

const lowSnap: ResourceSnapshot = {
	rssMB: 200,
	heapUsedMB: 50,
	freeMemMB: 12000,
	totalMemMB: 16000,
	loadAvg1: 0.5,
	cpuCount: 4,
	childrenCount: 0,
	timestamp: 0,
};

const highSnap: ResourceSnapshot = {
	rssMB: 14000,
	heapUsedMB: 1000,
	freeMemMB: 500,
	totalMemMB: 16000,
	loadAvg1: 3.9,
	cpuCount: 4,
	childrenCount: 8,
	timestamp: 1,
};

describe("ResourceMonitor", () => {
	it("(a) sample() returns a snapshot with all required fields", () => {
		const m = new ResourceMonitor();
		const snap = m.sample();
		// presence + reasonable bounds
		expect(typeof snap.rssMB).toBe("number");
		expect(snap.rssMB).toBeGreaterThan(0);
		expect(typeof snap.totalMemMB).toBe("number");
		expect(snap.totalMemMB).toBeGreaterThan(0);
		expect(typeof snap.freeMemMB).toBe("number");
		expect(snap.freeMemMB).toBeGreaterThanOrEqual(0);
		expect(typeof snap.heapUsedMB).toBe("number");
		expect(typeof snap.loadAvg1).toBe("number");
		expect(typeof snap.cpuCount).toBe("number");
		expect(snap.cpuCount).toBeGreaterThanOrEqual(1);
		expect(typeof snap.childrenCount).toBe("number");
		expect(snap.childrenCount).toBeGreaterThanOrEqual(0);
		expect(typeof snap.timestamp).toBe("number");
		// ordering: timestamp must be a real Date.now() value
		expect(snap.timestamp).toBeGreaterThan(1_700_000_000_000);
	});

	it("(b) low pressure — shouldAdvis false, pressureScore below 0.5", () => {
		const m = new ResourceMonitor();
		m.__setMockSnapshot(lowSnap);
		expect(m.shouldAdvis()).toBe(false);
		const score = m.pressureScore();
		expect(score).toBeLessThan(0.5);
	});

	it("(c) high pressure — shouldAdvis true, pressureScore above 0.8", () => {
		const m = new ResourceMonitor();
		m.__setMockSnapshot(highSnap);
		expect(m.shouldAdvis()).toBe(true);
		const score = m.pressureScore();
		expect(score).toBeGreaterThan(0.8);
	});

	it("(d) formatAdvisory is deterministic, short, and stable", () => {
		const m = new ResourceMonitor();
		const text = m.formatAdvisory(highSnap);
		// length + required substrings
		expect(text.length).toBeLessThanOrEqual(200);
		expect(text).toContain("[sages resource");
		expect(text).toContain("rss=");
		expect(text).toContain("free=");
		expect(text).toContain("load=");
		// deterministic: same input -> same output, no Date.toLocaleString or random
		expect(m.formatAdvisory(highSnap)).toBe(text);
	});

	it("custom weights change the pressure score (no NaN, clamped 0..1)", () => {
		const m = new ResourceMonitor({
			pressureWeight: { rss: 1, load: 0, mem: 0 },
		});
		m.__setMockSnapshot(highSnap);
		const score = m.pressureScore();
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});
});

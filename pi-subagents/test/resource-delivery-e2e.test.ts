/**
 * resource-delivery-e2e.test.ts — GC-2026-066 T1.
 *
 * Closes the SC6 *intent* gap from GC-2026-064 T3. The T3 commit captured
 * `pendingAdvisoryText` in `runAgent`'s `tool_execution_start` handler and
 * cleared it at `tool_execution_end` without ever delivering it to the LLM
 * (pi-coding-agent owns the tool-result envelope — T3's helper
 * `augmentToolResultWithAdvisory` therefore never ran against a real
 * envelope). This file pins the polarity contract for the chosen delivery
 * path (Path A — `session.steer(...)`, see comment block in agent-runner.ts).
 *
 * `session.steer()` from `@earendil-works/pi-coding-agent` is documented as:
 *   "Queue a steering message while the agent is running. Delivered after
 *    the current assistant turn finishes executing its tool calls, before
 *    the next LLM call."
 * That matches our need exactly: between `tool_execution_end` and the
 * next LLM call, the captured advisory lands as a user-side note that the
 * LLM sees on its next model call. Calm path stays alloc-free (no string
 * concat, no `session.steer(...)` call) — the threshold gate is the same
 * `monitor.shouldAdvis(snap)` already used by the capture side.
 *
 * Polarity pinned here:
 *   - capture high → returns formatted advisory matching `[sages resource:`
 *   - capture low  → returns undefined
 *   - deliver with text → `session.steer` invoked once with that text
 *   - deliver undefined → `session.steer` NOT invoked
 */

import { describe, expect, it, afterEach, vi } from "vitest";

import {
	captureToolStartAdvisory,
	deliverPendingAdvisory,
} from "../src/agent-runner.js";
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

describe("resource-delivery-e2e (GC-2026-066 T1)", () => {
	const monitor = new ResourceMonitor();

	afterEach(() => {
		monitor.__setMockSnapshot(null);
	});

	it("(a) capture high pressure → returns formatted [sages resource:...] string", () => {
		monitor.__setMockSnapshot(highSnap);
		const out = captureToolStartAdvisory(monitor);
		expect(out).toBeDefined();
		expect(out).toMatch(/^\[sages resource:/);
	});

	it("(b) capture low pressure → returns undefined (calm-path alloc-free)", () => {
		monitor.__setMockSnapshot(lowSnap);
		const out = captureToolStartAdvisory(monitor);
		expect(out).toBeUndefined();
	});

	it("(c) deliver with text → session.steer invoked once with that text", () => {
		const steer = vi.fn(async (_text: string) => {});
		const advisory = "[sages resource: score=0.91 ...]";
		deliverPendingAdvisory({ steer }, advisory);
		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledWith(advisory);
	});

	it("(d) deliver with undefined → session.steer NOT invoked", () => {
		const steer = vi.fn(async (_text: string) => {});
		deliverPendingAdvisory({ steer }, undefined);
		expect(steer).not.toHaveBeenCalled();
	});

	it("(e) round-trip — capture-then-deliver: high → captured string is exactly what steer receives", () => {
		monitor.__setMockSnapshot(highSnap);
		const captured = captureToolStartAdvisory(monitor);
		expect(captured).toBeDefined();
		const steer = vi.fn(async (_text: string) => {});
		deliverPendingAdvisory({ steer }, captured);
		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledWith(captured);
	});

	it("(f) round-trip — capture-then-deliver: low → capture is undefined, steer is not called", () => {
		monitor.__setMockSnapshot(lowSnap);
		const captured = captureToolStartAdvisory(monitor);
		expect(captured).toBeUndefined();
		const steer = vi.fn(async (_text: string) => {});
		deliverPendingAdvisory({ steer }, captured);
		expect(steer).not.toHaveBeenCalled();
	});
});
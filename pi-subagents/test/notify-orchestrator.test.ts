/**
 * notify-orchestrator.test.ts — GC-2026-070 mechanism: orchestrator push notification.
 *
 * Pins the behavior of `notifyOrchestrator(pi, diagnostic)`:
 *   - success outcomes are silent (no appendEntry call)
 *   - actionable outcomes (needs-work / aborted / error / stalled / crashed)
 *     produce one `system` entry with cause + remaining budget
 *   - retryBudgetLeft undefined → "no retry budget" suffix
 *   - throws in appendEntry are swallowed (must never propagate)
 *
 * Uses a fake `pi` recorder (no live session).
 */

import { describe, expect, it } from "bun:test";

import {
	notifyOrchestrator,
	type DiagnosticJsonV1,
} from "../src/diagnostic.js";

interface FakePi {
	appendEntry: (channel: string, data: unknown) => void;
	calls: Array<{ channel: string; data: unknown }>;
}

function makeFakePi(opts: { throwOnAppend?: boolean } = {}): FakePi {
	const calls: Array<{ channel: string; data: unknown }> = [];
	return {
		calls,
		appendEntry(channel, data) {
			if (opts.throwOnAppend) throw new Error("appendEntry boom");
			calls.push({ channel, data });
		},
	};
}

function baseDiagnostic(overrides: Partial<DiagnosticJsonV1> = {}): DiagnosticJsonV1 {
	return {
		schemaVersion: "v1",
		emittedAt: "2026-08-25T22:00:00.000Z",
		dispatchId: "developer-12345",
		context: { taskId: "T1" },
		subagentType: "developer",
		outcome: "needs-work",
		cause: "verification-failed",
		detail: "FAIL: test_foo.test.ts:42 expected 'bar', got 'baz'",
		...overrides,
	};
}

describe("notifyOrchestrator", () => {
	it("is silent on success outcome", () => {
		const pi = makeFakePi();
		notifyOrchestrator(pi, baseDiagnostic({ outcome: "success" }));
		expect(pi.calls).toEqual([]);
	});

	it("pushes a system entry on needs-work with retry budget", () => {
		const pi = makeFakePi();
		notifyOrchestrator(pi, baseDiagnostic({ retryBudgetLeft: 1 }));
		expect(pi.calls.length).toBe(1);
		expect(pi.calls[0]!.channel).toBe("system");
		const line = pi.calls[0]!.data as string;
		expect(line).toContain("[subagent-failure]");
		expect(line).toContain("verification-failed");
		expect(line).toContain("1 retry(s) left");
		expect(line).toContain("developer");
	});

	it("uses 'no retry budget' when retryBudgetLeft is undefined", () => {
		const pi = makeFakePi();
		notifyOrchestrator(pi, baseDiagnostic({ retryBudgetLeft: undefined }));
		expect(pi.calls.length).toBe(1);
		const line = pi.calls[0]!.data as string;
		expect(line).toContain("no retry budget");
	});

	it("uses '0 retry(s) left' when budget is exhausted (closed-loop signal)", () => {
		const pi = makeFakePi();
		notifyOrchestrator(pi, baseDiagnostic({ retryBudgetLeft: 0 }));
		expect(pi.calls.length).toBe(1);
		const line = pi.calls[0]!.data as string;
		expect(line).toContain("0 retry(s) left");
	});

	it("notifies on every actionable outcome (not just needs-work)", () => {
		const outcomes = ["needs-work", "aborted", "stalled", "error", "crashed"] as const;
		for (const outcome of outcomes) {
			const pi = makeFakePi();
			notifyOrchestrator(pi, baseDiagnostic({ outcome }));
			expect(pi.calls.length).toBe(1);
		}
	});

	it("truncates detail at 200 chars so the system entry stays small", () => {
		const pi = makeFakePi();
		const longDetail = "x".repeat(500);
		notifyOrchestrator(pi, baseDiagnostic({ detail: longDetail }));
		const line = pi.calls[0]!.data as string;
		const detailStart = line.indexOf("Detail: ") + "Detail: ".length;
		const detailSection = line.slice(detailStart);
		expect(detailSection.length).toBeLessThanOrEqual(200);
	});

	it("swallows appendEntry exceptions (must not propagate)", () => {
		const pi = makeFakePi({ throwOnAppend: true });
		expect(() => {
			notifyOrchestrator(pi, baseDiagnostic());
		}).not.toThrow();
	});

	it("includes subagentType and dispatchId so the orchestrator can correlate", () => {
		const pi = makeFakePi();
		notifyOrchestrator(
			pi,
			baseDiagnostic({
				subagentType: "auditor",
				dispatchId: "abc-123",
			}),
		);
		const line = pi.calls[0]!.data as string;
		expect(line).toContain("auditor abc-123");
	});
});
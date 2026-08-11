/**
 * diagnostic.test.ts — GC-2026-044 T2 / mechanism 1.4.
 *
 * Covers design §6.7 (the five RED cases). The last block covers the
 * agent-runner wiring with a stub writer, per the task brief: the runner
 * itself needs a live pi session to exercise, so the unit under test is
 * `diagnosticForRunResult` — the pure classifier that decides whether a
 * RunResult deserves a diagnostic and which cause it carries.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	DiagnosticInvalid,
	diagnosticForRunResult,
	pruneOldDiagnostics,
	readDiagnostic,
	writeDiagnostic,
} from "../src/diagnostic.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "diagnostic-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** Minimal valid diagnostic payload; individual tests override fields. */
function base(overrides: Record<string, unknown> = {}) {
	return {
		dispatchId: "GC-2026-044-T2-1",
		context: { dagId: "DAG-2026-044", taskId: "T2" },
		subagentType: "developer",
		outcome: "aborted" as const,
		cause: "subagent-timeout",
		detail: "Sub-agent hit the hard turn limit.",
		dir,
		...overrides,
	};
}

describe("writeDiagnostic (design §6.7)", () => {
	it("T-DIAG-01: rejects a cause that is not in the failure catalog", () => {
		// design §6.7.1 — RED case.
		expect(() => writeDiagnostic(base({ cause: "not-a-real-cause" }))).toThrow(
			DiagnosticInvalid,
		);
		expect(existsSync(join(dir, "GC-2026-044-T2-1.json"))).toBe(false);
	});

	it("T-DIAG-01b: rejects an outcome outside the v1 enum", () => {
		expect(() =>
			writeDiagnostic(base({ outcome: "exploded" as never })),
		).toThrow(DiagnosticInvalid);
	});

	it("T-DIAG-01c: rejects an empty dispatchId", () => {
		expect(() => writeDiagnostic(base({ dispatchId: "" }))).toThrow(
			DiagnosticInvalid,
		);
	});

	it("T-DIAG-02: writing twice for one dispatchId overwrites in place", () => {
		// design §6.7.2 — idempotent by dispatchId.
		const first = writeDiagnostic(base({ detail: "first attempt" }));
		const second = writeDiagnostic(base({ detail: "second attempt" }));

		expect(first?.path).toBe(second?.path);
		expect(second?.path).toBe(join(dir, "GC-2026-044-T2-1.json"));

		const onDisk = readDiagnostic(second?.path ?? "");
		expect(onDisk?.detail).toBe("second attempt");
		// No stray .tmp survives the atomic rename.
		expect(existsSync(`${second?.path}.tmp`)).toBe(false);
	});

	it("T-DIAG-02b: stamps schemaVersion and an ISO emittedAt", () => {
		const res = writeDiagnostic(base());
		const onDisk = readDiagnostic(res?.path ?? "");
		expect(onDisk?.schemaVersion).toBe("v1");
		expect(onDisk?.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
	});

	it("T-DIAG-02c: round-trips optional evidence and the retry chain", () => {
		const res = writeDiagnostic(
			base({
				evidence: {
					stderrDigest: "FAIL test/foo.test.ts",
					commitShas: ["abc1234"],
					verifierOutputs: [{ step: "test", exitCode: 1 }],
				},
				retryBudgetLeft: 1,
				priorDispatchId: "GC-2026-044-T2-0",
			}),
		);
		const onDisk = readDiagnostic(res?.path ?? "");
		expect(onDisk?.evidence?.commitShas).toEqual(["abc1234"]);
		expect(onDisk?.evidence?.verifierOutputs?.[0]?.exitCode).toBe(1);
		expect(onDisk?.retryBudgetLeft).toBe(1);
		expect(onDisk?.priorDispatchId).toBe("GC-2026-044-T2-0");
	});

	it("T-DIAG-02d: truncates an oversized stderr digest to 4KB", () => {
		const res = writeDiagnostic(
			base({ evidence: { stderrDigest: "x".repeat(10_000) } }),
		);
		const onDisk = readDiagnostic(res?.path ?? "");
		expect(onDisk?.evidence?.stderrDigest?.length).toBeLessThanOrEqual(4096);
	});

	it("T-DIAG-02e: a failed write warns on stderr and returns null, never throws", () => {
		// Q-G: losing one diagnostic must not take the sub-agent down with it.
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = writeDiagnostic(base({ dir: join(dir, "file-not-a-dir") }));
		// Point `dir` at a path whose parent is a regular file to force failure.
		writeFileSync(join(dir, "blocker"), "x", "utf-8");
		const res2 = writeDiagnostic(base({ dir: join(dir, "blocker", "sub") }));

		expect(res2).toBeNull();
		expect(warn).toHaveBeenCalled();
		// The first one (a creatable nested dir) still succeeds.
		expect(res?.path).toBeTruthy();
	});
});

describe("readDiagnostic / pruneOldDiagnostics (design §6.7)", () => {
	it("T-DIAG-03: pruneOldDiagnostics with retentionMs=0 removes every file", () => {
		writeDiagnostic(base({ dispatchId: "a" }));
		writeDiagnostic(base({ dispatchId: "b" }));
		expect(pruneOldDiagnostics(dir, 0)).toEqual({ removed: 2 });
		expect(existsSync(join(dir, "a.json"))).toBe(false);
		expect(existsSync(join(dir, "b.json"))).toBe(false);
	});

	it("T-DIAG-03b: prune keeps files younger than the retention window", () => {
		writeDiagnostic(base({ dispatchId: "fresh" }));
		writeDiagnostic(base({ dispatchId: "stale" }));
		// Backdate `stale` by an hour.
		const old = new Date(Date.now() - 3_600_000);
		utimesSync(join(dir, "stale.json"), old, old);

		expect(pruneOldDiagnostics(dir, 60_000)).toEqual({ removed: 1 });
		expect(existsSync(join(dir, "fresh.json"))).toBe(true);
		expect(existsSync(join(dir, "stale.json"))).toBe(false);
	});

	it("T-DIAG-03c: prune on a missing directory is a no-op", () => {
		expect(pruneOldDiagnostics(join(dir, "nope"), 0)).toEqual({ removed: 0 });
	});

	it("T-DIAG-04: readDiagnostic on a missing file returns null without throwing", () => {
		// design §6.7.4 — RED case.
		expect(readDiagnostic(join(dir, "nope.json"))).toBeNull();
	});

	it("T-DIAG-04b: readDiagnostic on malformed JSON returns null without throwing", () => {
		const p = join(dir, "corrupt.json");
		writeFileSync(p, "{ not json", "utf-8");
		expect(readDiagnostic(p)).toBeNull();
	});

	it("T-DIAG-04c: readDiagnostic on schema-invalid JSON returns null", () => {
		const p = join(dir, "wrong-shape.json");
		writeFileSync(p, JSON.stringify({ schemaVersion: "v1" }), "utf-8");
		expect(readDiagnostic(p)).toBeNull();
	});
});

describe("diagnosticForRunResult — agent-runner wiring (design §6.4, §6.7.5)", () => {
	it("T-DIAG-05: an aborted run yields outcome=aborted / cause=subagent-timeout", () => {
		// design §6.7.5 — the RunResult shape agent-runner returns on hard abort.
		const d = diagnosticForRunResult({
			aborted: true,
			steered: false,
			failure: undefined,
		});
		expect(d).not.toBeNull();
		expect(d?.outcome).toBe("aborted");
		expect(d?.cause).toBe("subagent-timeout");
	});

	it("T-DIAG-05b: writing that classification lands a v1 file on disk", () => {
		const d = diagnosticForRunResult({
			aborted: true,
			steered: false,
			failure: undefined,
		});
		const res = writeDiagnostic({
			...base(),
			outcome: d?.outcome ?? "error",
			cause: d?.cause ?? "infra-unhandled",
			detail: d?.detail ?? "",
		});
		const onDisk = JSON.parse(readFileSync(res?.path ?? "", "utf-8"));
		expect(onDisk.schemaVersion).toBe("v1");
		expect(onDisk.outcome).toBe("aborted");
		expect(onDisk.cause).toBe("subagent-timeout");
	});

	it("T-DIAG-05c: a provider failure yields outcome=error", () => {
		const d = diagnosticForRunResult({
			aborted: false,
			steered: false,
			failure: "provider error: overloaded_error",
		});
		expect(d?.outcome).toBe("error");
		expect(d?.cause).toBe("infra-unhandled");
		expect(d?.detail).toContain("overloaded_error");
	});

	it("T-DIAG-05d: a verifier FAIL in the failure text classifies via the catalog", () => {
		const d = diagnosticForRunResult({
			aborted: false,
			steered: false,
			failure: "FAIL test/foo.test.ts — 3 assertions failed",
		});
		expect(d?.cause).toBe("verification-failed");
	});

	it("T-DIAG-05e: a steered-but-finished run is recorded as needs-work, not error", () => {
		const d = diagnosticForRunResult({
			aborted: false,
			steered: true,
			failure: undefined,
		});
		expect(d?.outcome).toBe("needs-work");
	});

	it("T-DIAG-05f: a clean run produces no diagnostic at all", () => {
		expect(
			diagnosticForRunResult({
				aborted: false,
				steered: false,
				failure: undefined,
			}),
		).toBeNull();
	});
});

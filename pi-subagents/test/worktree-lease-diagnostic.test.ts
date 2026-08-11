/**
 * worktree-lease-diagnostic.test.ts — GC-2026-045 T4.1.
 *
 * Design §6.7 + audit finding: when `claimWorktreeLease` throws
 * `WorktreeConcurrencyGateRefused` (mechanism 1.1), a mechanism-1.4
 * diagnostic must be written BEFORE the throw propagates. Without this wire
 * the gate's refusal leaves no on-disk record, so the L3 audit roll-up sees
 * "1 refusal" only by re-running the dispatch — never from a forensics file.
 *
 * The catalog must carry a `worktree-concurrency-cap-reached` mode for
 * `writeDiagnostic`'s cause validation to accept it; that is the 8th entry
 * the design §5.3 promised and that T2's brief did not ship.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFailureCatalog } from "../src/failure-catalog.js";
import {
	claimWorktreeLease,
	leasePath,
	WorktreeConcurrencyGateRefused,
} from "../src/worktree-lease.js";

function fixtureRepo(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `sages-lease-diag-${name}-`));
	mkdirSync(join(root, ".git"), { recursive: true });
	return root;
}

describe("GC-2026-045 — worktree concurrency gate diagnostic wire", () => {
	let repoRoot: string;

	beforeEach(() => {
		repoRoot = fixtureRepo("gate");
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("T4.1-DIAG-01: catalog exposes the 8th mode id `worktree-concurrency-cap-reached`", () => {
		// Lock the contract: the cause id we write must exist in the shipped
		// catalog. If this id changes, the wire's cause field changes with it
		// — and so does everything that buckets diagnostics by mode.
		const catalog = getFailureCatalog(repoRoot);
		expect(catalog.lookup("worktree-concurrency-cap-reached")).toBeDefined();
	});

	it("T4.1-DIAG-02: WorktreeConcurrencyGateRefused is classified as a structured hit for the new mode", () => {
		// The mode must be reachable by its structured class name so an L3
		// reader can bucket diagnostics without parsing prose.
		const catalog = getFailureCatalog(repoRoot);
		const hit = catalog.matchesByClass("WorktreeConcurrencyGateRefused");
		expect(hit?.id).toBe("worktree-concurrency-cap-reached");
	});

	it("T4.1-DIAG-03: a refused claim writes a v1 diagnostic before throwing", async () => {
		// Saturate the cap first, then a second consumer's claim must throw
		// AND leave a diagnostic on disk. This is the wire under test.
		const occupied = await claimWorktreeLease({
			repoRoot,
			consumer: { dagId: "DAG-2026-045", taskId: "T1" },
			cap: 1,
			gateEnabled: true,
		});
		expect(existsSync(leasePath(repoRoot, occupied.consumer))).toBe(true);

		const diagnosticsDir = join(repoRoot, ".pi", "diagnostics");
		expect(existsSync(diagnosticsDir)).toBe(false);

		await expect(
			claimWorktreeLease({
				repoRoot,
				consumer: { dagId: "DAG-2026-045", taskId: "T2" },
				cap: 1,
				gateEnabled: true,
			}),
		).rejects.toBeInstanceOf(WorktreeConcurrencyGateRefused);

		expect(existsSync(diagnosticsDir)).toBe(true);
		const files = readdirSync(diagnosticsDir).filter((n) =>
			n.endsWith(".json"),
		);
		expect(files.length).toBe(1);

		const onDisk = JSON.parse(
			readFileSync(join(diagnosticsDir, files[0] ?? ""), "utf-8"),
		);
		expect(onDisk.schemaVersion).toBe("v1");
		expect(onDisk.cause).toBe("worktree-concurrency-cap-reached");
		expect(onDisk.outcome).toBe("needs-work");
		expect(onDisk.subagentType).toBe("developer");
		expect(onDisk.context.dagId).toBe("DAG-2026-045");
		expect(onDisk.context.taskId).toBe("T2");
		expect(onDisk.detail).toMatch(/cap.*1/i);
		expect(typeof onDisk.dispatchId).toBe("string");
		expect(onDisk.dispatchId.length).toBeGreaterThan(0);
	});

	it("T4.1-DIAG-04: when the gate is disabled, no diagnostic is written for a refused claim", async () => {
		// The wire is a property of the GATE refusing; bypassing the gate (cap=0)
		// must not produce a forensic record for an event that did not happen.
		await claimWorktreeLease({
			repoRoot,
			consumer: { dagId: "DAG-2026-045", taskId: "T1" },
			cap: 1,
			gateEnabled: false,
		});

		const res = await claimWorktreeLease({
			repoRoot,
			consumer: { dagId: "DAG-2026-045", taskId: "T2" },
			cap: 1,
			gateEnabled: false,
		});
		expect(res.consumer.taskId).toBe("T2");

		const diagnosticsDir = join(repoRoot, ".pi", "diagnostics");
		expect(
			existsSync(diagnosticsDir) &&
				readdirSync(diagnosticsDir).filter((n) => n.endsWith(".json")).length >
					0,
		).toBe(false);
	});

	it("T4.1-DIAG-05: a diagnostic write failure does not swallow the gate's refusal", async () => {
		// writeDiagnostic is documented to swallow I/O failures and warn on
		// stderr. The gate's refusal must STILL propagate so the caller
		// learns the claim was rejected — a swallowed exception would leave
		// the caller thinking the lease was claimed.
		await claimWorktreeLease({
			repoRoot,
			consumer: { dagId: "DAG-2026-045", taskId: "T1" },
			cap: 1,
			gateEnabled: true,
		});

		// Block the diagnostics dir with a regular file so the write fails.
		mkdirSync(join(repoRoot, ".pi"), { recursive: true });
		writeFileSyncStub(join(repoRoot, ".pi", "diagnostics"), "blocker");

		await expect(
			claimWorktreeLease({
				repoRoot,
				consumer: { dagId: "DAG-2026-045", taskId: "T2" },
				cap: 1,
				gateEnabled: true,
			}),
		).rejects.toBeInstanceOf(WorktreeConcurrencyGateRefused);
	});
});

/**
 * Tiny shim so the blocker-file fixture reads cleanly. The function lives
 * here rather than at the top so the test bodies above stay focused on the
 * contract; it is identical to the stdlib writeFileSync but the name avoids
 * pulling `fs.writeFileSync` into a test that has no other use for it.
 */
function writeFileSyncStub(path: string, body: string): void {
	const { writeFileSync } = require("node:fs") as typeof import("node:fs");
	writeFileSync(path, body, "utf-8");
}

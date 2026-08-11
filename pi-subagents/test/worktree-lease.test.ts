import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	claimWorktreeLease,
	leasePath,
	releaseLease,
	renewLease,
	WorktreeConcurrencyGateRefused,
} from "../src/worktree-lease.js";

const staleHeartbeat = Date.now() - 36 * 60 * 1000;

function fixtureRepo(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `sages-lease-${name}-`));
	mkdirSync(join(root, ".git"), { recursive: true });
	return root;
}

function writeLease(
	repoRoot: string,
	consumer: { dagId: string; taskId: string; worktreeId?: string },
	heartbeatAt = Date.now(),
): string {
	const lease = {
		repoRoot,
		consumer,
		issuedAt: heartbeatAt,
		heartbeatAt,
		pid: 1234,
	};
	const path = leasePath(repoRoot, consumer);
	mkdirSync(join(repoRoot, ".pi", "worktree-leases"), { recursive: true });
	writeFileSync(path, JSON.stringify(lease));
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("worktree lease concurrency gate", () => {
	let repoRoot: string;

	beforeEach(() => {
		repoRoot = fixtureRepo("gate");
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	test("refuses a new lease when live count reaches the cap and names owners", async () => {
		writeLease(repoRoot, { dagId: "DAG", taskId: "T1" });
		writeLease(repoRoot, { dagId: "DAG", taskId: "T2" });
		writeLease(repoRoot, { dagId: "DAG", taskId: "T3" });

		await expect(
			claimWorktreeLease({
				repoRoot,
				consumer: { dagId: "DAG", taskId: "T4" },
				cap: 3,
				gateEnabled: true,
			}),
		).rejects.toBeInstanceOf(WorktreeConcurrencyGateRefused);
		await expect(
			claimWorktreeLease({
				repoRoot,
				consumer: { dagId: "DAG", taskId: "T4" },
				cap: 3,
				gateEnabled: true,
			}),
		).rejects.toThrow(/cap.*3|T1|T2|T3/i);
	});

	test("reuses a live lease for the same consumer idempotently", async () => {
		const consumer = { dagId: "DAG", taskId: "T1", worktreeId: "slot" };
		const first = await claimWorktreeLease({
			repoRoot,
			consumer,
			cap: 1,
			gateEnabled: true,
		});
		const second = await claimWorktreeLease({
			repoRoot,
			consumer,
			cap: 1,
			gateEnabled: true,
		});

		expect(second).toEqual(first);
		expect(existsSync(leasePath(repoRoot, consumer))).toBe(true);
		await renewLease(second);
		await releaseLease(first);
		expect(existsSync(leasePath(repoRoot, consumer))).toBe(false);
	});

	test("canonicalizes a symlinked repository root for lease identity", async () => {
		const alias = `${repoRoot}-alias`;
		const consumer = { dagId: "DAG", taskId: "T1" };
		try {
			// The fixture directory contains a .git marker and is sufficient for
			// lease storage; a symlink exercises the canonical repo comparison.
			await import("node:fs/promises").then(({ symlink }) =>
				symlink(repoRoot, alias),
			);
			const first = await claimWorktreeLease({
				repoRoot,
				consumer,
				cap: 1,
				gateEnabled: true,
			});
			const second = await claimWorktreeLease({
				repoRoot: alias,
				consumer,
				cap: 1,
				gateEnabled: true,
			});
			expect(second).toEqual(first);
			expect(leasePath(alias, consumer)).toBe(leasePath(repoRoot, consumer));
		} finally {
			rmSync(alias, { force: true });
		}
	});

	test("cap zero disables the gate even when enabled", async () => {
		writeLease(repoRoot, { dagId: "DAG", taskId: "T1" });
		const lease = await claimWorktreeLease({
			repoRoot,
			consumer: { dagId: "DAG", taskId: "T2" },
			cap: 0,
			gateEnabled: true,
		});
		expect(lease.consumer.taskId).toBe("T2");
	});

	test("bypass emits one warning per repository and still claims", async () => {
		const writes: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);

		await claimWorktreeLease({
			repoRoot,
			consumer: { dagId: "DAG", taskId: "T1" },
			cap: 0,
			gateEnabled: true,
			bypass: true,
		});
		await claimWorktreeLease({
			repoRoot,
			consumer: { dagId: "DAG", taskId: "T2" },
			cap: 0,
			gateEnabled: true,
			bypass: true,
		});

		expect(
			writes.filter((line) => line.includes("[sages:lease-bypass]")).length,
		).toBe(1);
	});
});

// Keep the expected on-disk naming contract explicit in this test. The helper
// is intentionally exported so callers can inspect or remove a lease without
// duplicating path construction.
test("leasePath uses the canonical identity hash", () => {
	const repoRoot = fixtureRepo("hash");
	try {
		const consumer = { dagId: "DAG", taskId: "T1", worktreeId: "W1" };
		const canonical = repoRoot;
		const expectedHash = createHash("sha256")
			.update(
				canonical + consumer.dagId + consumer.taskId + consumer.worktreeId,
			)
			.digest("hex");
		expect(leasePath(repoRoot, consumer)).toBe(
			join(repoRoot, ".pi", "worktree-leases", `${expectedHash}.json`),
		);
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

void staleHeartbeat;
void writeLease;

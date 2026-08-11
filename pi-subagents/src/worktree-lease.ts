import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { DiagnosticInvalid, writeDiagnostic } from "./diagnostic.js";

export const DEFAULT_WORKTREE_CONCURRENCY_CAP = 3;
export const DEFAULT_WORKTREE_CONCURRENCY_GATE_ENABLED = false;
export const WORKTREE_LEASE_STALE_AFTER_MS = 35 * 60 * 1000;

export type WorktreeLeaseConsumer = {
	dagId: string;
	taskId: string;
	worktreeId?: string;
};

export type WorktreeLease = {
	repoRoot: string;
	consumer: WorktreeLeaseConsumer;
	issuedAt: number;
	heartbeatAt: number;
	pid: number;
	bypassed?: boolean;
};

export type ClaimWorktreeLeaseArgs = {
	repoRoot: string;
	consumer: WorktreeLeaseConsumer;
	cap?: number;
	gateEnabled?: boolean;
	bypass?: boolean;
};

export class WorktreeConcurrencyGateRefused extends Error {
	readonly cap: number;
	readonly live: number;
	readonly owners: WorktreeLeaseConsumer[];

	constructor(cap: number, owners: WorktreeLeaseConsumer[]) {
		super(
			`worktree-concurrency-gate: refusing lease because live count ${owners.length} ` +
				`reaches cap ${cap}; existing owners: ${owners
					.map(
						(owner) =>
							`${owner.dagId}/${owner.taskId}${owner.worktreeId ? `/${owner.worktreeId}` : ""}`,
					)
					.join(", ")}`,
		);
		this.name = "WorktreeConcurrencyGateRefused";
		this.cap = cap;
		this.live = owners.length;
		this.owners = owners;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

function canonicalRepoRoot(repoRoot: string): string {
	return realpathSync(repoRoot);
}

function leaseId(repoRoot: string, consumer: WorktreeLeaseConsumer): string {
	return createHash("sha256")
		.update(
			repoRoot + consumer.dagId + consumer.taskId + (consumer.worktreeId ?? ""),
		)
		.digest("hex");
}

export function leaseDirectory(repoRoot: string): string {
	return join(canonicalRepoRoot(repoRoot), ".pi", "worktree-leases");
}

export function leasePath(
	repoRoot: string,
	consumer: WorktreeLeaseConsumer,
): string {
	const canonical = canonicalRepoRoot(repoRoot);
	return join(
		leaseDirectory(canonical),
		`${leaseId(canonical, consumer)}.json`,
	);
}

function sameConsumer(
	a: WorktreeLeaseConsumer,
	b: WorktreeLeaseConsumer,
): boolean {
	return (
		a.dagId === b.dagId &&
		a.taskId === b.taskId &&
		a.worktreeId === b.worktreeId
	);
}

function isLease(value: unknown): value is WorktreeLease {
	if (!value || typeof value !== "object") return false;
	const lease = value as Partial<WorktreeLease>;
	return (
		typeof lease.repoRoot === "string" &&
		typeof lease.issuedAt === "number" &&
		typeof lease.heartbeatAt === "number" &&
		typeof lease.pid === "number" &&
		!!lease.consumer &&
		typeof lease.consumer.dagId === "string" &&
		typeof lease.consumer.taskId === "string"
	);
}

async function readLease(path: string): Promise<WorktreeLease | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isLease(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function removeLease(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function sweepLeases(
	directory: string,
	now: number,
): Promise<WorktreeLease[]> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const live: WorktreeLease[] = [];
	await Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map(async (name) => {
				const path = join(directory, name);
				const lease = await readLease(path);
				if (
					!lease ||
					now - lease.heartbeatAt >= WORKTREE_LEASE_STALE_AFTER_MS
				) {
					await removeLease(path);
					return;
				}
				live.push(lease);
			}),
	);
	return live;
}

const bypassWarnings = new Set<string>();

function warnBypassOnce(repoRoot: string): void {
	if (bypassWarnings.has(repoRoot)) return;
	bypassWarnings.add(repoRoot);
	process.stderr.write(
		`[sages:lease-bypass] worktree concurrency gate bypassed for ${repoRoot}\n`,
	);
}

function validateCap(cap: number): void {
	if (!Number.isInteger(cap) || cap < 0) {
		throw new RangeError(
			`worktree-concurrency-gate: cap must be a non-negative integer (got ${cap})`,
		);
	}
}

async function atomicWrite(path: string, value: WorktreeLease): Promise<void> {
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp.json`;
	try {
		await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
		await rename(tmpPath, path);
	} finally {
		await removeLease(tmpPath);
	}
}

/**
 * Claim one repo-scoped worktree lease. Claims are stored outside the
 * orchestrator namespace and are safe to inspect from another process.
 */
export async function claimWorktreeLease(
	args: ClaimWorktreeLeaseArgs,
): Promise<WorktreeLease> {
	const canonical = canonicalRepoRoot(args.repoRoot);
	const cap = args.cap ?? DEFAULT_WORKTREE_CONCURRENCY_CAP;
	const gateEnabled =
		args.gateEnabled ?? DEFAULT_WORKTREE_CONCURRENCY_GATE_ENABLED;
	validateCap(cap);

	const directory = leaseDirectory(canonical);
	await mkdir(directory, { recursive: true });
	const path = leasePath(canonical, args.consumer);
	const now = Date.now();
	const current = await readLease(path);
	if (current && now - current.heartbeatAt < WORKTREE_LEASE_STALE_AFTER_MS) {
		if (sameConsumer(current.consumer, args.consumer)) return current;
	}
	if (current) await removeLease(path);

	const liveLeases = await sweepLeases(directory, now);
	const repoLeases = liveLeases.filter(
		(lease) => canonicalRepoRoot(lease.repoRoot) === canonical,
	);
	if (args.bypass) warnBypassOnce(canonical);
	if (gateEnabled && cap > 0 && !args.bypass && repoLeases.length >= cap) {
		// Emit a mechanism-1.4 diagnostic BEFORE the throw propagates so the
		// L3 audit roll-up can bucket the refusal from the filesystem rather
		// than having to re-run the dispatch. writeDiagnostic is sync-and-swallow
		// for I/O; if it does throw (e.g. catalog drift drops the cause id), warn
		// to stderr and proceed with the throw — the gate's behavior must not
		// change because of a diagnostic-write failure (test T4.1-DIAG-05).
		try {
			const dispatchId = `${process.pid}-${Date.now()}-${createHash("sha1")
				.update(`${process.pid}:${Date.now()}:${Math.random()}`)
				.digest("hex")
				.slice(0, 8)}`;
			writeDiagnostic({
				dispatchId,
				context: {
					dagId: args.consumer.dagId,
					taskId: args.consumer.taskId,
					worktreeId: args.consumer.worktreeId,
				},
				subagentType: "developer",
				outcome: "needs-work",
				cause: "worktree-concurrency-cap-reached",
				detail:
					`worktree-concurrency-gate: refused — cap=${cap}, live=${repoLeases.length}, ` +
					`existing owners: ${repoLeases
						.map(
							(lease) =>
								`${lease.consumer.dagId}/${lease.consumer.taskId}` +
								(lease.consumer.worktreeId
									? `/${lease.consumer.worktreeId}`
									: ""),
						)
						.join(", ")}`,
				retryBudgetLeft: 0,
				cwd: canonical,
				catalogCwd: canonical,
			});
		} catch (err) {
			const message =
				err instanceof DiagnosticInvalid
					? err.message
					: err instanceof Error
						? err.message
						: String(err);
			process.stderr.write(`[sages:gate-diagnostic-skip] ${message}\n`);
		}
		throw new WorktreeConcurrencyGateRefused(
			cap,
			repoLeases.map((lease) => lease.consumer),
		);
	}

	const lease: WorktreeLease = {
		repoRoot: canonical,
		consumer: { ...args.consumer },
		issuedAt: now,
		heartbeatAt: now,
		pid: process.pid,
		...(args.bypass ? { bypassed: true } : {}),
	};
	await atomicWrite(path, lease);
	return lease;
}

/** Refresh a lease heartbeat. Missing leases are treated as an expired claim. */
export async function renewLease(lease: WorktreeLease): Promise<void> {
	const path = leasePath(lease.repoRoot, lease.consumer);
	const current = await readLease(path);
	if (!current || !sameConsumer(current.consumer, lease.consumer)) {
		throw new Error(`worktree-lease: cannot renew missing lease ${path}`);
	}
	const renewed: WorktreeLease = { ...current, heartbeatAt: Date.now() };
	lease.heartbeatAt = renewed.heartbeatAt;
	await atomicWrite(path, renewed);
}

/** Release a lease, without deleting a newer claim for the same identity. */
export async function releaseLease(lease: WorktreeLease): Promise<void> {
	const path = leasePath(lease.repoRoot, lease.consumer);
	const current = await readLease(path);
	if (
		current &&
		(current.issuedAt !== lease.issuedAt || current.pid !== lease.pid)
	) {
		return;
	}
	await removeLease(path);
}

/** Test/process hook: clear warning de-duplication state. */
export function resetLeaseWarnings(): void {
	bypassWarnings.clear();
}

void existsSync;

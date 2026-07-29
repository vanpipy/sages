/**
 * scripts/profile-real-stress.ts — real ScheduleStore contention harness.
 *
 * This is deliberately separate from profile-stress.ts.  It does not call
 * profile.inc() to manufacture lock retries: every retry reported here comes
 * from ScheduleStore.add/update trying to create the shared lock file.
 *
 * Usage (from pi-subagents):
 *   mkdir -p /tmp/pi-real-N3
 *   for i in 1 2 3; do
 *     REAL_STRESS_WORKERS=3 REAL_STRESS_WORKER_ID=$i \
 *       SHARED_LOCK_DIR=/tmp/pi-real-N3 SAGES_PI_PROFILE=1 \
 *       bun run scripts/profile-real-stress.ts \
 *       >/tmp/pi-real-N3/$i.stdout 2>/tmp/pi-real-N3/$i.stderr &
 *   done
 *   wait
 *
 * Set REAL_STRESS_WORKERS=1 for a standalone run.  The script waits for all
 * workers at a small file barrier, so workers begin their ScheduleStore loop
 * together rather than relying on shell scheduling.
 */

// profile.ts caches the environment flag while its module is evaluated.  Keep
// this assignment before the dynamic imports below so the harness is useful
// even when invoked without the flag in the shell.
process.env.SAGES_PI_PROFILE = "1";

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const { AgentManager } = await import("../src/agent-manager.js");
const { ScheduleStore } = await import("../src/schedule-store.js");
const { isEnabled, snapshot, startSummary, stopSummary } = await import(
	"../src/profile.js"
);

const TOTAL_MS = 25_000;
const SAMPLE_START_MS = 2_000;
const SAMPLE_END_MS = 18_000;
const SEED_JOBS = 96;
const PAYLOAD_SIZE = 2_048;
const WORKER_COUNT = Math.max(
	1,
	Number.parseInt(process.env.REAL_STRESS_WORKERS ?? "1", 10) || 1,
);
const WORKER_ID = process.env.REAL_STRESS_WORKER_ID ?? String(process.pid);
const sharedDir = process.env.SHARED_LOCK_DIR ?? join("/tmp", "pi-real-single");
const storePath = join(sharedDir, "shared-schedules.json");
const seedReadyPath = join(sharedDir, ".seed-ready");
const readyPath = join(sharedDir, `.ready-${WORKER_ID}`);

function logSync(message: string): void {
	try {
		writeSync(2, message);
	} catch {
		process.stderr.write(message);
	}
}

/** Read Linux /proc stat without being confused by a command name in parens. */
function selfJiffies(): number {
	try {
		const line = readFileSync("/proc/self/stat", "utf8") as string;
		const closeParen = line.lastIndexOf(")");
		if (closeParen < 0) return 0;
		const fields = line
			.slice(closeParen + 1)
			.trim()
			.split(/\s+/);
		// fields[0] is field 3 (state); fields[11]/[12] are fields 14/15.
		return (
			(Number.parseInt(fields[11] ?? "0", 10) || 0) +
			(Number.parseInt(fields[12] ?? "0", 10) || 0)
		);
	} catch {
		return 0;
	}
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) await sleep(25);
	return existsSync(path);
}

function job(id: string, worker: string, iteration: number) {
	return {
		id,
		name: id,
		description: `real contention worker ${worker}`,
		schedule: "+10m",
		scheduleType: "once" as const,
		subagent_type: "Explore",
		prompt: `${worker}:${iteration}:${"x".repeat(PAYLOAD_SIZE)}`,
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: iteration,
	};
}

async function seedStore(): Promise<void> {
	if (existsSync(seedReadyPath)) return;
	// Seeding through the public API keeps setup on the same real writer path.
	// A unique marker prevents another worker from treating a partial seed as
	// complete if worker 0 is still writing.
	const seedStore = new ScheduleStore(storePath);
	for (let i = 0; i < SEED_JOBS; i++) {
		await Promise.resolve(seedStore.add(job(`seed-${i}`, WORKER_ID, i)));
	}
	try {
		writeFileSync(seedReadyPath, `${process.pid}\n`, { flag: "wx" });
	} catch {
		// Another worker may have completed the one-time seed concurrently.
	}
}

async function synchronizeWorkers(): Promise<void> {
	mkdirSync(sharedDir, { recursive: true });
	if (WORKER_ID === "1" || WORKER_COUNT === 1) await seedStore();
	else if (!(await waitFor(seedReadyPath, 10_000))) {
		throw new Error(`timed out waiting for seed marker: ${seedReadyPath}`);
	}

	writeFileSync(readyPath, `${process.pid}\n`);
	if (WORKER_COUNT > 1) {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			let ready = 0;
			for (let i = 1; i <= WORKER_COUNT; i++) {
				if (existsSync(join(sharedDir, `.ready-${i}`))) ready++;
			}
			if (ready >= WORKER_COUNT) return;
			await sleep(25);
		}
		throw new Error(`timed out waiting for ${WORKER_COUNT} workers`);
	}
}

async function run(): Promise<void> {
	if (!isEnabled()) throw new Error("SAGES_PI_PROFILE=1 is required");
	mkdirSync(sharedDir, { recursive: true });

	// AgentManager construction is real and needs no model registry or API key.
	// Its spawn() path intentionally is not invoked: that path starts a model
	// session and cannot be made network-free without replacing production code.
	const manager = new AgentManager(undefined, 1);
	manager.setMaxConcurrent(1);
	logSync(
		`profile-real-stress: pid=${process.pid} worker=${WORKER_ID}/${WORKER_COUNT} ` +
			`manager_max=${manager.getMaxConcurrent()}\n`,
	);

	try {
		await synchronizeWorkers();
		const store = new ScheduleStore(storePath);
		startSummary();
		const startedAt = Date.now();
		const startJiffies = selfJiffies();
		const startProfile = snapshot();
		let operations = 0;
		let failures = 0;
		let iteration = 0;
		let sampleAt2: number | undefined;
		let sampleAt18: number | undefined;

		const sampleTimer = (async () => {
			await sleep(SAMPLE_START_MS);
			sampleAt2 = selfJiffies();
			logSync(
				`sample pid=${process.pid} elapsed_ms=${Date.now() - startedAt} jiffies=${sampleAt2}\n`,
			);
			await sleep(SAMPLE_END_MS - SAMPLE_START_MS);
			sampleAt18 = selfJiffies();
			logSync(
				`sample pid=${process.pid} elapsed_ms=${Date.now() - startedAt} jiffies=${sampleAt18}\n`,
			);
		})();

		while (Date.now() - startedAt < TOTAL_MS) {
			const id = `shared-${iteration % SEED_JOBS}`;
			try {
				// Both calls are public ScheduleStore APIs and each acquires the
				// actual cross-process lock. Promise.resolve supports the sync
				// ScheduleStore API on the pre-GC-2026-021 baseline checkout too.
				await Promise.resolve(store.add(job(id, WORKER_ID, iteration)));
				await Promise.resolve(
					store.update(id, { runCount: iteration, lastStatus: "running" }),
				);
				operations += 2;
			} catch (error) {
				failures++;
				if (failures <= 3)
					logSync(`operation_error pid=${process.pid} ${String(error)}\n`);
			}
			iteration++;
			// Promise-resolved ScheduleStore calls continue in the microtask
			// queue. Yield to a timer once per iteration so the requested t=2s
			// and t=18s samples (and profile_summary) cannot be starved by a
			// successful writer loop.
			await sleep(0);
		}
		await sampleTimer;
		const endJiffies = selfJiffies();
		const endProfile = snapshot();
		const delta = endJiffies - startJiffies;
		logSync(
			`[real-final pid=${process.pid}] ` +
				`jiffies_start=${startJiffies} jiffies_t2=${sampleAt2 ?? 0} ` +
				`jiffies_t18=${sampleAt18 ?? 0} jiffies_end=${endJiffies} ` +
				`delta_2_to_18=${(sampleAt18 ?? endJiffies) - (sampleAt2 ?? startJiffies)} ` +
				`delta_total=${delta} operations=${operations} failures=${failures} ` +
				`busy_wait_retries=${endProfile.busy_wait_retries - startProfile.busy_wait_retries} ` +
				`spawned_total=${endProfile.spawned_total - startProfile.spawned_total} ` +
				`manager_agents=${manager.listAgents().length}\n`,
		);
		stopSummary();
	} finally {
		manager.dispose();
	}
}

run()
	.catch((error) => {
		logSync(`profile-real-stress: fatal: ${String(error)}\n`);
		process.exitCode = 1;
	})
	.finally(() => {
		// Only worker 1 owns the run directory cleanup in a single-worker run;
		// multi-process artifacts are intentionally preserved for analysis.
		if (WORKER_COUNT === 1 && process.env.REAL_STRESS_CLEANUP === "1") {
			rmSync(sharedDir, { recursive: true, force: true });
		}
	});

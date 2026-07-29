import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("ScheduleStore.incrementRunCount", () => {
	it("increments the persisted run count under the store lock", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-run-count-"));
		dirs.push(dir);
		const store = new ScheduleStore(join(dir, "schedule.json"));
		const previous = 7;
		const job: ScheduledSubagent = {
			id: "job-1",
			name: "job",
			description: "atomic run count test",
			schedule: "5m",
			scheduleType: "interval",
			subagent_type: "Explore",
			prompt: "inspect",
			enabled: true,
			createdAt: new Date().toISOString(),
			runCount: previous,
		};
		await store.add(job);

		await store.incrementRunCount(job.id);
		await store.incrementRunCount(job.id);

		expect(store.get(job.id)?.runCount).toBe(previous + 2);
		const reloaded = new ScheduleStore(join(dir, "schedule.json"));
		expect(reloaded.get(job.id)?.runCount).toBe(previous + 2);
	});
});

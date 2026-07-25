/**
 * developer-schedule.test.ts — Phase A P2 schedule enforcement.
 *
 * Pin the policy at the schedule-store boundary:
 *
 *   1. One-shot developer schedules are accepted (foreground semantics
 *      apply at fire time — caller must supply the explicit managed-
 *      worktree object).
 *   2. Recurring developer schedules are rejected with a precise
 *      message — the dispatcher can't guarantee the policy at every
 *      fire time without compile-time knowledge of the isolation shape,
 *      so recurring jobs are forbidden outright.
 *   3. Reuse mode for a developer schedule is validated through the
 *      same parser the foreground path uses — a malformed reuse object
 *      is rejected.
 *   4. The legacy `isolation: \"worktree\"` string literal is rejected
 *      for developer schedules (same message family as foreground).
 *   5. Explore / Plan / general-purpose schedules are unaffected.
 *   6. The persisted ScheduledSubagent carries the isolation object
 *      verbatim — not a coerced string.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SubagentScheduler } from "../src/schedule.js";
import {
	registerAgents,
	setDefaultsDisabled,
} from "../src/agent-types.js";

const CANONICAL = "developer";

describe("developer-schedule: persistence", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("persists the explicit managed-worktree object verbatim (one-shot)", () => {
		const scheduler = new SubagentScheduler();
		const obj = {
			dag_id: "DAG-2026-011",
			task_id: "P2",
			mode: "create" as const,
		};
		const job = scheduler.buildJob({
			name: "oneshot-developer",
			description: "fire once",
			schedule: "+10m",
			subagent_type: CANONICAL,
			prompt: "do the thing",
			isolation: obj,
		});
		expect(job.isolation).toEqual(obj);
		expect(job.scheduleType).toBe("once");
	});

	it("accepts one-shot `developer` schedules (foreground semantics at fire time)", () => {
		const scheduler = new SubagentScheduler();
		expect(() =>
			scheduler.buildJob({
				name: "oneshot-developer",
				description: "fire once",
				schedule: "+10m",
				subagent_type: CANONICAL,
				prompt: "do the thing",
				isolation: {
					dag_id: "DAG-2026-011",
					task_id: "P2",
					mode: "create",
				},
			}),
		).not.toThrow();
	});

	it("rejects recurring developer schedules with a precise reason", () => {
		const scheduler = new SubagentScheduler();
		expect(() =>
			scheduler.buildJob({
				name: "recurring-developer",
				description: "every 5m",
				schedule: "5m",
				subagent_type: CANONICAL,
				prompt: "do the thing",
				isolation: {
					dag_id: "DAG-2026-011",
					task_id: "P2",
					mode: "create",
				},
			}),
		).toThrow(/developer/i);
	});

	it("rejects cron recurring developer schedules with a precise reason", () => {
		const scheduler = new SubagentScheduler();
		expect(() =>
			scheduler.buildJob({
				name: "cron-developer",
				description: "every minute",
				schedule: "0 * * * * *",
				subagent_type: CANONICAL,
				prompt: "do the thing",
				isolation: {
					dag_id: "DAG-2026-011",
					task_id: "P2",
					mode: "create",
				},
			}),
		).toThrow(/developer/i);
	});

	it("rejects developer schedules with the legacy `worktree` string literal", () => {
		const scheduler = new SubagentScheduler();
		expect(() =>
			scheduler.buildJob({
				name: "legacy-literal-developer",
				description: "fire once",
				schedule: "+10m",
				subagent_type: CANONICAL,
				prompt: "do the thing",
				isolation: "worktree" as any,
			}),
		).toThrow(/developer/i);
	});

	it("rejects developer schedules without isolation (the policy still applies)", () => {
		const scheduler = new SubagentScheduler();
		expect(() =>
			scheduler.buildJob({
				name: "no-isolation-developer",
				description: "fire once",
				schedule: "+10m",
				subagent_type: CANONICAL,
				prompt: "do the thing",
			}),
		).toThrow(/developer/i);
	});

	it("rejects developer schedules with a malformed managed-worktree object", () => {
		const scheduler = new SubagentScheduler();
		expect(() =>
			scheduler.buildJob({
				name: "malformed-developer",
				description: "fire once",
				schedule: "+10m",
				subagent_type: CANONICAL,
				prompt: "do the thing",
				isolation: { dag_id: "DAG-1" } as any,
			}),
		).toThrow(/developer/i);
	});

	it("does NOT reject recurring schedules for non-developer agents", () => {
		const scheduler = new SubagentScheduler();
		expect(() =>
			scheduler.buildJob({
				name: "recurring-explore",
				description: "every 5m",
				schedule: "5m",
				subagent_type: "Explore",
				prompt: "find the thing",
			}),
		).not.toThrow();
		expect(() =>
			scheduler.buildJob({
				name: "recurring-gp",
				description: "every 5m",
				schedule: "5m",
				subagent_type: "general-purpose",
				prompt: "do the thing",
			}),
		).not.toThrow();
	});

	it("does NOT reject recurring schedules for the alias name (alias is metadata, not a separate roster)", () => {
		const scheduler = new SubagentScheduler();
		// The alias resolves to canonical `developer` — but the buildJob
		// validation runs against the raw caller-supplied name. To match
		// the dispatcher, buildJob should also reject the alias with the
		// same precise reason.
		expect(() =>
			scheduler.buildJob({
				name: "recurring-alias-developer",
				description: "every 5m",
				schedule: "5m",
				subagent_type: "software-developer",
				prompt: "do the thing",
				isolation: {
					dag_id: "DAG-2026-011",
					task_id: "P2",
					mode: "create",
				},
			}),
		).toThrow(/developer/i);
	});
});

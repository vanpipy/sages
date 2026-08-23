/**
 * event-domains.test.ts — GC-2026-050 T4.2
 *
 * Tests the run/* event-domain isolation contract defined in
 * `pi/src/observability/events.ts` + the matching `emitRunEvent`
 * emitter:
 *
 *   - run/* events are durable (written to audit-state-{dag}.yaml).
 *
 * The test DAG id is `TEST-DAG-event-domains`, isolated from any real
 * orchestrator state.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	RunEvent,
	emitRunEvent,
	domainOf,
} from "../src/observability/index.js";

const TEST_DAG = "TEST-DAG-event-domains";
const auditStatePath = (): string => join(".pi/orchestrator", `audit-state-${TEST_DAG}.yaml`);

describe("event domains — isolation", () => {
	beforeEach(() => {
		// Clean up any prior test state so each test starts fresh.
		const p = auditStatePath();
		if (existsSync(p)) rmSync(p);
	});

	it("RunEvent values start with 'run/'", () => {
		for (const v of Object.values(RunEvent)) {
			expect(v).toMatch(/^run\//);
			expect(domainOf(v)).toBe("run");
		}
	});

	it("emitRunEvent writes to audit-state-{dag}.yaml", () => {
		// Ensure the orchestrator dir exists before the emit so we exercise the
		// emitter's directory-ensure branch end-to-end.
		mkdirSync(".pi/orchestrator", { recursive: true });
		emitRunEvent(TEST_DAG, RunEvent.GoalCreated, { foo: "bar" });
		const path = auditStatePath();
		expect(existsSync(path)).toBe(true);
		const raw = readFileSync(path, "utf-8");
		expect(raw).toContain("run/goal_created");
		expect(raw).toContain("foo: bar");
	});

	it("emitRunEvent rejects non-run events", () => {
		expect(() => emitRunEvent(TEST_DAG, "unknown/event" as unknown as RunEvent)).toThrow();
	});

	it("domainOf returns null for unknown events", () => {
		expect(domainOf("unknown/event")).toBe(null);
		expect(domainOf("")).toBe(null);
	});
});
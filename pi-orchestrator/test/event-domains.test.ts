/**
 * event-domains.test.ts — GC-2026-050 T4.2
 *
 * Tests the run/* event-domain isolation contract defined in
 * `pi-orchestrator/src/observability/events.ts` + the matching `emitRunEvent`
 * emitter:
 *
 *   - run/* events are durable (written to audit-state-{dag}.yaml).
 *
 * The test DAG id is `TEST-DAG-event-domains`, isolated from any real
 * orchestrator state.
 *
 * Migration note: post the chore/orchestrator-workdir-tmpdir commit
 * the orchestrator's storage root is `${TMPDIR}/${ORCHESTRATOR_WORKDIR}`
 * (no `.pi/orchestrator` segment). The test routes ORCHESTRATOR_WORKDIR
 * at a per-test tempdir so the audit-state files land somewhere we can
 * clean up.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunEvent, emitRunEvent, domainOf } from "../src/observability/index.js";
import { resolveOrchestratorWorkdir, resetOrchestratorWorkdirCache } from "../src/workdir.js";

const TEST_DAG = "TEST-DAG-event-domains";
let workdir: string;

describe("event domains — isolation", () => {
	beforeEach(() => {
		// Route the orchestrator's workdir at a per-test tempdir.
		const testWorkdir = mkdtempSync(join(tmpdir(), "sages-event-domains-"));
		process.env.ORCHESTRATOR_WORKDIR = testWorkdir;
		resetOrchestratorWorkdirCache();
		workdir = resolveOrchestratorWorkdir();
		// Clean up any prior test state so each test starts fresh.
		const p = join(workdir, `audit-state-${TEST_DAG}.yaml`);
		if (existsSync(p)) rmSync(p);
	});

	afterEach(() => {
		resetOrchestratorWorkdirCache();
		delete process.env.ORCHESTRATOR_WORKDIR;
		if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
	});

	it("RunEvent values start with 'run/'", () => {
		for (const v of Object.values(RunEvent)) {
			expect(v).toMatch(/^run\//);
			expect(domainOf(v)).toBe("run");
		}
	});

	it("emitRunEvent writes to audit-state-{dag}.yaml", () => {
		// The emitter mkdirs the workdir itself, so no pre-mkdir needed here.
		emitRunEvent(TEST_DAG, RunEvent.GoalCreated, { foo: "bar" });
		const path = join(workdir, `audit-state-${TEST_DAG}.yaml`);
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
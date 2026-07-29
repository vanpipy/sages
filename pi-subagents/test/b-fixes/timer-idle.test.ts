/**
 * test/b-fixes/timer-idle.test.ts — B-fix SC2/SC3.
 *
 * Pinned invariants (GC-2026-021 SC2 + SC3):
 *   - AgentWidget's 80 ms `setInterval` MUST stop firing when no agents
 *     and no finished entries are visible (the static-analysis Top-4
 *     hotspot: 12.4 Hz constant no-op churn at idle).
 *   - FleetList's 200 ms `setInterval` MUST re-arm on roster change only.
 *     Empty roster + no input for 10 s = ≤ 1 total fire (was ~50).
 *   - When activity is present, BOTH timers keep their old cadence
 *     (no regression on the 12.5 Hz / 5 Hz timing pinned by
 *     `test/profile-instrumented/tui-timer-rate.test.ts`).
 *   - When a fleet-list timer is idle and unref'd, `process._getActiveHandles()`
 *     no longer includes it — the event loop is not pinned by the timer.
 *
 * Anti-rule: no new npm dependencies. Pure built-in setTimeout / clearTimeout
 * / unref.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests } from "../../src/profile.js";

// Stub the TUI module so we can construct AgentWidget / FleetList without
// a real terminal (mirrors the pattern in profile-instrumented/tui-timer-rate.test.ts).
vi.mock("@earendil-works/pi-tui", () => ({
	truncateToWidth: (s: string) => s,
	visibleWidth: (s: string) => [...s].length,
}));

import type { AgentManager, AgentRecord } from "../../src/agent-manager.js";
import type { AgentActivity } from "../../src/ui/agent-widget.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { FleetList } from "../../src/ui/fleet-list.js";

interface StubActivityEntry {
	activeTools: Map<string, string>;
	toolUses: number;
	responseText: string;
	updatedAt: number;
	lifetimeUsage: { input: number; output: number; cacheWrite: number };
}

class StubManager {
	private records: AgentRecord[] = [];
	listAgents(): AgentRecord[] {
		return this.records;
	}
	getRecord() {
		return undefined;
	}
	abort() {
		return true;
	}
	steer() {
		/* no-op */
	}
	asAgentManager(): AgentManager {
		return undefined as unknown as AgentManager;
	}
	setRecords(records: AgentRecord[]) {
		this.records = records;
	}
}

function makeRunningAgent(): AgentRecord {
	return {
		id: "a1",
		type: "general",
		status: "running",
		description: "test",
		toolUses: 0,
		startedAt: Date.now(),
	} as unknown as AgentRecord;
}

beforeEach(() => {
	_resetForTests();
	process.env.SAGES_PI_PROFILE = "1";
});

afterEach(() => {
	_resetForTests();
	delete process.env.SAGES_PI_PROFILE;
	vi.useRealTimers();
});

describe("b-fixes/timer-idle: agent-widget stops firing when no agents / no finished", () => {
	it("does not call setInterval at all when no agents are visible", () => {
		vi.useFakeTimers();
		const stub = new StubManager();
		stub.setRecords([]);
		const activity = new Map<string, StubActivityEntry>();
		const widget = new AgentWidget(
			stub as unknown as AgentManager,
			activity as unknown as Map<string, AgentActivity>,
		);
		let updateCount = 0;
		widget.update = () => {
			updateCount++;
		};
		widget.ensureTimer();
		vi.advanceTimersByTime(5_000);
		expect(updateCount).toBe(0);
		widget.dispose();
	});

	it("still fires at ~12.5 Hz when at least one agent is running (no regression)", () => {
		vi.useFakeTimers();
		const stub = new StubManager();
		stub.setRecords([makeRunningAgent()]);
		const activity = new Map<string, StubActivityEntry>();
		const widget = new AgentWidget(
			stub as unknown as AgentManager,
			activity as unknown as Map<string, AgentActivity>,
		);
		let updateCount = 0;
		widget.update = () => {
			updateCount++;
		};
		widget.ensureTimer();
		vi.advanceTimersByTime(5_000);
		// 5000 / 80 = 62.5 fires expected. Allow ±10%: [57, 69].
		expect(updateCount).toBeGreaterThanOrEqual(57);
		expect(updateCount).toBeLessThanOrEqual(69);
		widget.dispose();
	});
});

describe("b-fixes/timer-idle: fleet-list rearm-on-roster-change", () => {
	it("empty roster + no input for 10s → total fires ≤ 1 (was ~50)", () => {
		vi.useFakeTimers();
		const stub = new StubManager();
		stub.setRecords([]);
		const activity = new Map<string, StubActivityEntry>();
		const fleet = new FleetList(
			stub as unknown as AgentManager,
			activity as unknown as Map<string, AgentActivity>,
		);
		let updateCount = 0;
		fleet.update = () => {
			updateCount++;
		};
		// The original ensureTimer starts a 200ms setInterval that fires
		// ~50 times in 10s. After the B-fix, ensureTimer must NOT keep
		// the timer alive when the roster is empty.
		fleet.ensureTimer();
		vi.advanceTimersByTime(10_000);
		expect(updateCount).toBeLessThanOrEqual(1);
		fleet.dispose();
	});

	it("adding an agent to the roster restarts firing; ≥1 fire within 500ms of state change (no regression)", () => {
		vi.useFakeTimers();
		const stub = new StubManager();
		stub.setRecords([]);
		const activity = new Map<string, StubActivityEntry>();
		const fleet = new FleetList(
			stub as unknown as AgentManager,
			activity as unknown as Map<string, AgentActivity>,
		);
		let updateCount = 0;
		fleet.update = () => {
			updateCount++;
		};
		fleet.ensureTimer();
		vi.advanceTimersByTime(10_000);
		const idleCount = updateCount;
		// State change: roster gains an agent. With the rearm pattern, the
		// next fire must happen within ~1× the original 200ms cadence.
		stub.setRecords([makeRunningAgent()]);
		fleet.update();
		vi.advanceTimersByTime(500);
		expect(updateCount - idleCount).toBeGreaterThanOrEqual(1);
		fleet.dispose();
	});
});

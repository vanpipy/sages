/**
 * phase-widget.test.ts — Unit tests for the pi-orchestrator phase plan widget.
 *
 * The widget reads workflow tasks out of pi-tasks's TaskStore via a
 * cross-extension RPC and renders them as a phase tree. It's the
 * "planning state" surface (per the audit that motivated this GC):
 * shows Implement / Review / Merge phases plus any dynamic Fix phases.
 *
 * Architecture (per design audit 2026-10-05):
 *   - Primary data path (Option B): RPC tasks:rpc:list-by-metadata to
 *     pi-tasks, filtering by workflow_run_goal_id.
 *   - Refresh triggers (Option C): workflow:start, workflow:phase-complete,
 *     subagents:completed, subagents:failed.
 *
 * Tests use a fake bus that simulates both event subscription and the
 * RPC request/reply envelope. The fake bus handler for the RPC channel
 * is installed per-test in beforeEach so widget behavior + RPC mock can
 * evolve independently.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PhaseWidget,
  computePhasePlan,
  groupTasksByPhase,
  type PhaseWidgetBus,
  type TaskSummary,
} from "../../src/ui/phase-widget.js";

type Handler = (data: unknown) => void | Promise<void>;

class FakeBus implements PhaseWidgetBus {
  private handlers = new Map<string, Handler[]>();
  on(channel: string, handler: Handler): () => void {
    if (!this.handlers.has(channel)) this.handlers.set(channel, []);
    this.handlers.get(channel)!.push(handler);
    return () => {
      const arr = this.handlers.get(channel);
      if (arr) this.handlers.set(channel, arr.filter((h) => h !== handler));
    };
  }
  emit(channel: string, data: unknown): void {
    for (const h of [...(this.handlers.get(channel) ?? [])]) {
      void h(data);
    }
  }
  listenerCount(channel: string): number {
    return (this.handlers.get(channel) ?? []).length;
  }
}

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "1",
    subject: "Implement: foo",
    status: "pending",
    blockedBy: [],
    metadata: { workflow_run_goal_id: "GC-1", phase: "implement" },
    ...overrides,
  };
}

describe("computePhasePlan", () => {
  it("returns Implement + N Review + Merge for default max_fix_iterations=3", () => {
    const plan = computePhasePlan({ max_fix_iterations: 3, max_redesigns: 1 });
    expect(plan).toEqual([
      { key: "implement", label: "Implement", iteration: 0 },
      { key: "review", label: "Review 1", iteration: 1 },
      { key: "review", label: "Review 2", iteration: 2 },
      { key: "review", label: "Review 3", iteration: 3 },
      { key: "merge", label: "Merge", iteration: 0 },
    ]);
  });

  it("honors max_fix_iterations=1 (Implement + 1 Review + Merge)", () => {
    const plan = computePhasePlan({ max_fix_iterations: 1, max_redesigns: 1 });
    expect(plan).toEqual([
      { key: "implement", label: "Implement", iteration: 0 },
      { key: "review", label: "Review 1", iteration: 1 },
      { key: "merge", label: "Merge", iteration: 0 },
    ]);
  });

  it("throws on max_fix_iterations < 1 (invalid plan shape)", () => {
    expect(() => computePhasePlan({ max_fix_iterations: 0, max_redesigns: 1 })).toThrow();
  });
});

describe("groupTasksByPhase", () => {
  it("groups tasks by phase key, preserving creation order", () => {
    const tasks: TaskSummary[] = [
      makeTask({ id: "1", metadata: { workflow_run_goal_id: "GC-1", phase: "implement" } }),
      makeTask({
        id: "2",
        subject: "Review 1: foo",
        metadata: { workflow_run_goal_id: "GC-1", phase: "review", iteration: 1 },
      }),
      makeTask({
        id: "3",
        subject: "Fix 1: foo",
        metadata: { workflow_run_goal_id: "GC-1", phase: "fix", iteration: 1 },
      }),
      makeTask({
        id: "4",
        subject: "Review 2: foo",
        metadata: { workflow_run_goal_id: "GC-1", phase: "review", iteration: 2 },
      }),
      makeTask({ id: "5", subject: "Merge: foo", metadata: { workflow_run_goal_id: "GC-1", phase: "merge" } }),
    ];
    const groups = groupTasksByPhase(tasks);
    expect(groups).toHaveLength(5);
    // groupTasksByPhase preserves insertion order: tasks 1, 2, 3, 4, 5.
    // Fix (task 3) was inserted between Review 1 (task 2) and Review 2 (task 4),
    // so it stays at index 2 in the groups array even though iteration=1
    // (which would otherwise sort before Review 2's iteration=2).
    expect(groups.map((g) => g.key)).toEqual(["implement", "review", "fix", "review", "merge"]);
    expect(groups.map((g) => g.iteration)).toEqual([0, 1, 1, 2, 0]);
    expect(groups[0].tasks).toHaveLength(1);
    expect(groups[2].tasks[0].id).toBe("3"); // fix sits at insertion order index 2
  });

  it("returns empty groups for empty task list", () => {
    expect(groupTasksByPhase([])).toEqual([]);
  });
});

describe("PhaseWidget", () => {
  let bus: FakeBus;

  beforeEach(() => {
    bus = new FakeBus();
  });

  afterEach(() => {
    // nothing to clean — FakeBus has no async resources
  });

  function makeWidget() {
    return new PhaseWidget({ bus });
  }

  it("subscribes to workflow events on attach()", () => {
    const w = makeWidget();
    w.attach();
    expect(bus.listenerCount("workflow:start")).toBeGreaterThan(0);
    expect(bus.listenerCount("workflow:phase-complete")).toBeGreaterThan(0);
    expect(bus.listenerCount("subagents:completed")).toBeGreaterThan(0);
    expect(bus.listenerCount("subagents:failed")).toBeGreaterThan(0);
  });

  it("captures goal_id on workflow:start and computes phase plan", () => {
    const w = makeWidget();
    w.attach();

    bus.emit("workflow:start", {
      workflow_id: "wf-1",
      goal_id: "GC-TEST",
      goal: { id: "GC-TEST", title: "T", scope: { include: [], exclude: [] }, anti_goals: [], done_definition: "" },
      max_fix_iterations: 2,
      max_redesigns: 1,
      worktree_path: "/x",
    });

    const state = w.getState();
    expect(state.goalId).toBe("GC-TEST");
    expect(state.phasePlan).toEqual([
      { key: "implement", label: "Implement", iteration: 0 },
      { key: "review", label: "Review 1", iteration: 1 },
      { key: "review", label: "Review 2", iteration: 2 },
      { key: "merge", label: "Merge", iteration: 0 },
    ]);
  });

  it("queries pi-tasks via RPC on workflow:phase-complete (refresh trigger)", async () => {
    // Install the RPC handler FIRST so the widget's emitted request lands.
    bus.on("tasks:rpc:list-by-metadata", (raw: unknown) => {
      const { requestId, key, value } = raw as {
        requestId: string;
        key: string;
        value: unknown;
      };
      if (key === "workflow_run_goal_id" && value === "GC-TEST") {
        bus.emit(
          "tasks:rpc:list-by-metadata:reply:" + requestId,
          {
            success: true,
            data: [
              makeTask({
                id: "1",
                subject: "Implement: foo",
                metadata: { workflow_run_goal_id: "GC-TEST", phase: "implement" },
              }),
            ],
          },
        );
      }
    });

    const w = makeWidget();
    w.attach();

    bus.emit("workflow:start", {
      workflow_id: "wf-1",
      goal_id: "GC-TEST",
      goal: { id: "GC-TEST", title: "T", scope: { include: [], exclude: [] }, anti_goals: [], done_definition: "" },
      max_fix_iterations: 1,
      max_redesigns: 1,
      worktree_path: "/x",
    });

    bus.emit("workflow:phase-complete", {
      workflow_id: "wf-1",
      goal_id: "GC-TEST",
      phase: "implement",
      iteration: 0,
      status: "completed",
      task_id: "1",
    });

    // Allow async RPC + state update to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const state = w.getState();
    expect(state.tasksByPhase.size).toBeGreaterThanOrEqual(1);
    expect(state.tasksByPhase.get("implement")?.[0].id).toBe("1");
  });

  it("render() returns phase tree lines including the workflow goal id", async () => {
    bus.on("tasks:rpc:list-by-metadata", (raw: unknown) => {
      const { requestId, key, value } = raw as {
        requestId: string;
        key: string;
        value: unknown;
      };
      if (key === "workflow_run_goal_id" && value === "GC-TEST") {
        bus.emit(
          "tasks:rpc:list-by-metadata:reply:" + requestId,
          {
            success: true,
            data: [
              makeTask({
                id: "1",
                subject: "Implement: foo",
                status: "in_progress",
                metadata: { workflow_run_goal_id: "GC-TEST", phase: "implement" },
              }),
            ],
          },
        );
      }
    });

    const w = makeWidget();
    w.attach();

    bus.emit("workflow:start", {
      workflow_id: "wf-1",
      goal_id: "GC-TEST",
      goal: { id: "GC-TEST", title: "T", scope: { include: [], exclude: [] }, anti_goals: [], done_definition: "" },
      max_fix_iterations: 1,
      max_redesigns: 1,
      worktree_path: "/x",
    });
    bus.emit("workflow:phase-complete", {
      workflow_id: "wf-1",
      goal_id: "GC-TEST",
      phase: "implement",
      iteration: 0,
      status: "in_progress",
      task_id: "1",
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const lines = w.render();
    const text = lines.join("\n");
    expect(text).toContain("Workflow Plan");
    expect(text).toContain("GC-TEST");
    expect(text).toMatch(/Implement/);
    expect(text).toMatch(/Review 1/);
    expect(text).toMatch(/Merge/);
    expect(text).toContain("Implement: foo");
  });

 	it("ignores events when no workflow is active (no crash, goal_id stays undefined)", () => {
		const w = makeWidget();
		w.attach();
		bus.emit("workflow:phase-complete", {
			workflow_id: "wf-x",
			goal_id: "GC-X",
			phase: "implement",
			status: "completed",
			task_id: "1",
		});
		expect(w.getState().goalId).toBeUndefined();
	});

	// GC-2026-advisor-pairs: when a phase group contains both a primary
	// task and an advisor task (metadata.advisorOf set), render the
	// advisor row indented + with "advisor:" prefix so the pair is
	// visually grouped.
	it("renders advisor task as a paired sub-row under its primary", async () => {
		bus.on("tasks:rpc:list-by-metadata", (raw: unknown) => {
			const { requestId, key, value } = raw as {
				requestId: string;
				key: string;
				value: unknown;
			};
			if (key === "workflow_run_goal_id" && value === "GC-TEST") {
				bus.emit(
					"tasks:rpc:list-by-metadata:reply:" + requestId,
					{
						success: true,
						data: [
							makeTask({
								id: "1",
								subject: "Implement: foo",
								status: "completed",
								metadata: { workflow_run_goal_id: "GC-TEST", phase: "implement" },
							}),
							makeTask({
								id: "2",
								subject: "Advisor: Implement: foo",
								status: "in_progress",
								metadata: {
									workflow_run_goal_id: "GC-TEST",
									phase: "implement",
									advisorOf: "1",
								},
							}),
						],
					},
				);
			}
		});

		const w = makeWidget();
		w.attach();

		bus.emit("workflow:start", {
			workflow_id: "wf-1",
			goal_id: "GC-TEST",
			goal: { id: "GC-TEST", title: "T", scope: { include: [], exclude: [] }, anti_goals: [], done_definition: "" },
			max_fix_iterations: 1,
			max_redesigns: 1,
			worktree_path: "/x",
		});
		bus.emit("workflow:phase-complete", {
			workflow_id: "wf-1",
			goal_id: "GC-TEST",
			phase: "implement",
			iteration: 0,
			status: "completed",
			task_id: "1",
		});

		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const lines = w.render();
		const text = lines.join("\n");
		// Both tasks should be visible (advisor subject gets reformatted
		// from "Advisor: Implement: foo" -> "advisor: Implement: foo" by the
		// renderer so the prefix isn't duplicated in the display).
		expect(text).toContain("Implement: foo");
		expect(text).toContain("advisor: Implement: foo");
		// Advisor row should be indented one more level (6 spaces) than
		// the primary row (4 spaces)
		const primaryRow = lines.find((l) => l.includes("Implement: foo") && !l.includes("advisor:"));
		const advisorRow = lines.find((l) => l.includes("advisor: Implement: foo"));
		expect(primaryRow).toBeDefined();
		expect(advisorRow).toBeDefined();
		expect(primaryRow!.indexOf("Implement: foo")).toBeGreaterThanOrEqual(0);
		expect(advisorRow!.indexOf("advisor:")).toBeGreaterThanOrEqual(0);
		// Advisor is rendered after primary in the group (sort works)
		expect(lines.indexOf(advisorRow!)).toBeGreaterThan(lines.indexOf(primaryRow!));
	});
});

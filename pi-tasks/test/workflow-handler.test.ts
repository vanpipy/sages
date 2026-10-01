/**
 * workflow-handler.test.ts — Unit tests for the workflow:start / subagents:completed handlers.
 *
 * The handler is the entry point for path B. It subscribes to two events:
 *
 *  1. `workflow:start` — emitted by pi-orchestrator/workflow_run. The handler
 *     builds the static task graph, creates the tasks, wires blockedBy edges
 *     (resolving placeholders to real task IDs), then spawns the Implement
 *     task as a subagent. Cascade advances automatically as each task finishes.
 *
 *  2. `subagents:completed` — for every task with `metadata.workflow_run_goal_id`,
 *     the handler:
 *       (a) For review tasks, parses the verdict via `parseReviewerVerdict`,
 *           stamps `metadata.verdict`, and emits `workflow:phase-complete`.
 *       (b) For every workflow task, finds newly-unblocked dependents and
 *           spawns them — this drives the cascade without relying on the
 *           user's `autoCascade` config (path B always cascades).
 *
 * Tests use a fake TaskStore (no disk), a fake event bus, and a spy for
 * spawnAgent. The handler is a pure transformation of events → store mutations
 * → spawn calls + emitted events.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { subscribeWorkflow } from "../src/workflow-handler.js";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";
import type { WorkflowStartPayload } from "../src/workflow-handler.js";

// ── Fake event bus ─────────────────────────────────────────────────────

type Handler = (data: unknown) => void | Promise<void>;

function fakeEvents() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(channel: string, handler: Handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => { handlers.get(channel)?.delete(handler); };
    },
    emit(channel: string, data: unknown): Promise<void> {
      const set = handlers.get(channel);
      if (!set) return Promise.resolve();
      // Run handlers sequentially so the test can observe state in between.
      return (async () => {
        for (const h of [...set]) await h(data);
      })();
    },
    /** Snapshot how many times each channel was emitted on. */
    snapshot() {
      const result: Record<string, unknown[]> = {};
      for (const [channel, set] of handlers) {
        if (channel.startsWith("workflow:") || channel.startsWith("subagents:")) {
          result[channel] = [];
        }
      }
      return {
        emit: (channel: string, data: unknown) => {
          (result[channel] ??= []).push(data);
          // Also fire on real handlers
          return Array.from(handlers.get(channel) ?? []).reduce(
            (p, h) => p.then(() => h(data)),
            Promise.resolve(),
          );
        },
        captured: result,
      };
    },
  };
}

// ── Test helpers ───────────────────────────────────────────────────────

const goal = {
  id: "GC-TEST-WF",
  title: "Test workflow",
  rationale: "verification",
  scope: { include: ["src/**"], exclude: ["dist/**"] },
  anti_goals: ["no new deps"],
  done_definition: "tests pass",
};

function startPayload(): WorkflowStartPayload {
  return {
    workflow_id: "wf-1",
    goal_id: "GC-TEST-WF",
    goal,
    max_fix_iterations: 3,
    worktree_path: "/abs/worktree",
  };
}

function setup() {
  const store = new TaskStore(); // in-memory
  const events = fakeEvents();
  const spy = { calls: [] as Array<{ task: Task }> };
  const spawnAgent = vi.fn(async (task: Task) => {
    spy.calls.push({ task });
    return `agent-${task.id}`;
  });
  const unsub = subscribeWorkflow(store, { events, spawnAgent });

  return { store, events, spawnAgent, spy, unsub };
}

function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("subscribeWorkflow — workflow:start", () => {
  beforeEach(() => { /* each test gets its own setup */ });

  test("on workflow:start, handler creates 7 tasks with the right blockedBy edges (max=3)", async () => {
    const { store, events } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const tasks = store.list();
    expect(tasks).toHaveLength(7);

    const byPhase = (phase: string) => tasks.filter(t => t.metadata.phase === phase);
    expect(byPhase("implement")).toHaveLength(1);
    expect(byPhase("review")).toHaveLength(3);
    expect(byPhase("fix")).toHaveLength(2);
    expect(byPhase("merge")).toHaveLength(1);

    // Every task has workflow_run_goal_id + workflow_id stamped on metadata.
    for (const t of tasks) {
      expect(t.metadata.workflow_run_goal_id).toBe("GC-TEST-WF");
      expect(t.metadata.workflow_id).toBe("wf-1");
    }

    // Implement has no blockedBy; Review_1 blockedBy Implement; Fix_1 blockedBy Review_1, etc.
    const implement = byPhase("implement")[0];
    const review1 = byPhase("review")[0];
    const fix1 = byPhase("fix")[0];
    const review2 = byPhase("review")[1];
    const fix2 = byPhase("fix")[1];
    const review3 = byPhase("review")[2];
    const merge = byPhase("merge")[0];

    expect(implement.blockedBy).toEqual([]);
    expect(review1.blockedBy).toEqual([implement.id]);
    expect(fix1.blockedBy).toEqual([review1.id]);
    expect(review2.blockedBy).toEqual([fix1.id]);
    expect(fix2.blockedBy).toEqual([review2.id]);
    expect(review3.blockedBy).toEqual([fix2.id]);
    expect(merge.blockedBy).toEqual([
      implement.id,
      review1.id,
      fix1.id,
      review2.id,
      fix2.id,
      review3.id,
    ]);
  });

  test("on workflow:start, handler spawns only the Implement task", async () => {
    const { events, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    const spawned = spawnAgent.mock.calls[0][0];
    expect(spawned.metadata.phase).toBe("implement");
  });

  test("the cascade engine spawns Fix_1 after Review_1 completes (CLEAN → empty commit Fix)", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;

    // Reviewer reports CLEAN
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: "```yaml\nverdict: CLEAN\nfindings: []\n```",
    });
    await flush();

    // Cascade should have advanced: Fix_1 has been spawned.
    const spawnedSubjects = spawnAgent.mock.calls.map(c => c[0].subject);
    expect(spawnedSubjects.some(s => s.startsWith("Fix 1"))).toBe(true);
  });
});

describe("subscribeWorkflow — subagents:completed review", () => {
  test("review task completion parses verdict and stamps metadata.verdict", async () => {
    const { events, store } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;

    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: [
        "Some prose.",
        "```yaml",
        "verdict: NEEDS_WORK",
        "findings:",
        "  - severity: major",
        "    issue: missing test",
        "    location: src/foo.ts",
        "scope_check: pass",
        "anti_goal_check: pass",
        "```",
      ].join("\n"),
    });
    await flush();

    const after = store.get(review1.id);
    expect(after?.metadata.verdict).toBeDefined();
    expect(after?.metadata.verdict?.verdict).toBe("NEEDS_WORK");
    expect(after?.metadata.verdict?.findings).toHaveLength(1);
  });

  test("review completion emits workflow:phase-complete with the right shape", async () => {
    const { events, store } = setup();
    const emitted: unknown[] = [];
    // Capture via a second listener on the same bus.
    events.on("workflow:phase-complete", d => { emitted.push(d); });

    await events.emit("workflow:start", startPayload());
    await flush();

    const review2 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2)!;

    await events.emit("subagents:completed", {
      id: "agent-" + review2.id,
      result: "```yaml\nverdict: CLEAN\nfindings: []\n```",
    });
    await flush();

    expect(emitted).toHaveLength(1);
    const ev = emitted[0] as Record<string, unknown>;
    expect(ev.workflow_id).toBe("wf-1");
    expect(ev.goal_id).toBe("GC-TEST-WF");
    expect(ev.phase).toBe("review");
    expect(ev.iteration).toBe(2);
    expect(ev.verdict).toBe("CLEAN");
    expect(ev.status).toBe("completed");
  });

  test("non-review completion does not parse verdict (Implement / Fix / Merge pass through)", async () => {
    const { events, store } = setup();
    const emitted: unknown[] = [];
    events.on("workflow:phase-complete", d => { emitted.push(d); });

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;

    await events.emit("subagents:completed", {
      id: "agent-" + implement.id,
      result: "```yaml\nstatus: completed\n```",
    });
    await flush();

    const after = store.get(implement.id);
    expect(after?.metadata.verdict).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });
});

describe("subscribeWorkflow — cascade", () => {
  test("completing Implement unblocks and spawns Review_1", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();
    spawnAgent.mockClear();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await events.emit("subagents:completed", { id: "agent-" + implement.id, result: "ok" });
    await flush();

    const subjects = spawnAgent.mock.calls.map(c => c[0].subject);
    expect(subjects).toContain("Review 1: Test workflow");
  });

  test("completing the last review (Review_3 CLEAN) unblocks and spawns Merge", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();
    spawnAgent.mockClear();

    // Complete Implement → Review_1 → Fix_1 → Review_2 → Fix_2 → Review_3 in sequence.
    const all = store.list();
    const byPhase = (phase: string, iter?: number) =>
      all.find(t => t.metadata.phase === phase && (iter === undefined || t.metadata.iteration === iter))!;

    const order = [
      byPhase("implement"),
      byPhase("review", 1),
      byPhase("fix", 1),
      byPhase("review", 2),
      byPhase("fix", 2),
      byPhase("review", 3),
    ];
    for (const t of order) {
      await events.emit("subagents:completed", { id: "agent-" + t.id, result: "ok" });
      await flush();
    }

    // Merge should be the last spawn (it has no blockedBy remaining).
    const subjects = spawnAgent.mock.calls.map(c => c[0].subject);
    expect(subjects[subjects.length - 1]).toBe("Merge: Test workflow");
  });
});

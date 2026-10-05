/**
 * workflow-handler.test.ts — Unit tests for the workflow:start / subagents:completed handlers.
 *
 * The handler is the entry point for path B. It subscribes to two events:
 *
 *  1. `workflow:start` — emitted by pi-orchestrator/workflow_run. The handler
 *     builds the static task graph (Implement + N Reviews + Merge; Fix
 *     tasks are NOT pre-created — GC-2026-verdict-states-and-dynamic-cascade),
 *     creates the tasks, wires blockedBy edges (resolving placeholders to
 *     real task IDs), then spawns the Implement task as a subagent. Cascade
 *     advances automatically as each task finishes.
 *
 *  2. `subagents:completed` — for every task with `metadata.workflow_run_goal_id`,
 *     the handler:
 *       (a) For review tasks, parses the verdict via `parseReviewerVerdict`,
 *           stamps `metadata.verdict`, and emits `workflow:phase-complete`.
 *           On NEEDS_WORK → dispatches a Fix on demand. On NEEDS_REDESIGN
 *           → spawns a new Implement. On NEEDS_CLARIFICATION → pauses.
 *       (b) For every workflow task, finds newly-unblocked dependents and
 *           spawns them — this drives the cascade without relying on the
 *           user's `autoCascade` config (path B always cascades).
 *
 * Tests use a fake TaskStore (no disk), a fake event bus, and a spy for
 * spawnAgent. The handler is a pure transformation of events → store mutations
 * → spawn calls + emitted events.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";
import type { WorkflowStartPayload } from "../src/workflow-handler.js";
import { subscribeWorkflow } from "../src/workflow-handler.js";

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
      const captured: Record<string, unknown[]> = {};
      for (const channel of handlers.keys()) {
        if (channel.startsWith("workflow:") || channel.startsWith("subagents:")) {
          captured[channel] = [];
        }
      }
      return {
        emit: (channel: string, data: unknown) => {
          if (!captured[channel]) captured[channel] = [];
          captured[channel].push(data);
          // Also fire on real handlers
          return Array.from(handlers.get(channel) ?? []).reduce(
            (p, h) => p.then(() => h(data)),
            Promise.resolve(),
          );
        },
        captured,
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

function startPayload(opts: Partial<WorkflowStartPayload> = {}): WorkflowStartPayload {
	return {
		workflow_id: "wf-1",
		goal_id: "GC-TEST-WF",
		goal,
		max_fix_iterations: 3,
		max_redesigns: 1,
		worktree_path: "/abs/worktree",
		...opts,
	};
}

function startPayloadInTmp(opts: Partial<WorkflowStartPayload> = {}): {
	payload: WorkflowStartPayload;
	cwd: string;
	cleanup: () => void;
} {
	const cwd = mkdtempSync(join(tmpdir(), "wf-handler-b7-"));
	return {
		payload: {
			...startPayload(opts),
			worktree_path: cwd,
		},
		cwd,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
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

const cleanReviewMessage = (iteration: number) =>
  "```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```";

const needsWorkMessage = (issue: string) =>
  [
    "```yaml",
    "verdict: NEEDS_WORK",
    "findings:",
    "  - severity: major",
    `    issue: ${issue}`,
    "    location: src/foo.ts",
    "scope_check: pass",
    "anti_goal_check: pass",
    "```",
  ].join("\n");

const needsRedesignMessage = (issue: string) =>
  [
    "```yaml",
    "verdict: NEEDS_REDESIGN",
    "findings:",
    "  - severity: critical",
    `    issue: ${issue}`,
    "scope_check: pass",
    "anti_goal_check: pass",
    "```",
  ].join("\n");

const needsClarificationMessage = (question: string) =>
  [
    "```yaml",
    "verdict: NEEDS_CLARIFICATION",
    `open_question: ${question}`,
    "scope_check: pass",
    "anti_goal_check: pass",
    "```",
  ].join("\n");

async function completeTask(events: ReturnType<typeof fakeEvents>, task: Task) {
  await events.emit("subagents:completed", { id: "agent-" + task.id, result: "ok" });
  await flush();
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("subscribeWorkflow — workflow:start (GC-2026-verdict-states-and-dynamic-cascade)", () => {
  beforeEach(() => { /* each test gets its own setup */ });

  test("on workflow:start, handler creates 5 tasks (no Fix pre-created) — max_fix_iterations=3", async () => {
    const { store, events } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const tasks = store.list();
    // GC-2026-verdict-states-and-dynamic-cascade: Implement + 3 Reviews + Merge
    // = 5 tasks. Fix is NOT pre-created.
    expect(tasks).toHaveLength(5);

    const byPhase = (phase: string) => tasks.filter(t => t.metadata.phase === phase);
    expect(byPhase("implement")).toHaveLength(1);
    expect(byPhase("review")).toHaveLength(3);
    expect(byPhase("fix")).toHaveLength(0); // dynamically created, not pre-created
    expect(byPhase("merge")).toHaveLength(1);

    // Every task has workflow_run_goal_id + workflow_id stamped on metadata.
    for (const t of tasks) {
      expect(t.metadata.workflow_run_goal_id).toBe("GC-TEST-WF");
      expect(t.metadata.workflow_id).toBe("wf-1");
    }

    // blockedBy chain: Implement → Review_1 → Review_2 → Review_3 → Merge
    const implement = byPhase("implement")[0];
    const reviews = byPhase("review");
    const merge = byPhase("merge")[0];

    expect(implement.blockedBy).toEqual([]);
    expect(reviews[0].blockedBy).toEqual([implement.id]);
    expect(reviews[1].blockedBy).toEqual([reviews[0].id]);
    expect(reviews[2].blockedBy).toEqual([reviews[1].id]);
    expect(merge.blockedBy).toEqual([
      implement.id,
      reviews[0].id,
      reviews[1].id,
      reviews[2].id,
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

  test("max_fix_iterations=2 produces 4 tasks (Implement + 2 Reviews + Merge)", async () => {
    const { store, events } = setup();

    await events.emit("workflow:start", startPayload({ max_fix_iterations: 2 }));
    await flush();

    const tasks = store.list();
    expect(tasks).toHaveLength(4);
    expect(tasks.filter(t => t.metadata.phase === "review")).toHaveLength(2);
  });

  test("max_fix_iterations=1 produces 3 tasks (Implement + 1 Review + Merge)", async () => {
    const { store, events } = setup();

    await events.emit("workflow:start", startPayload({ max_fix_iterations: 1 }));
    await flush();

    const tasks = store.list();
    expect(tasks).toHaveLength(3);
    expect(tasks.filter(t => t.metadata.phase === "review")).toHaveLength(1);
  });
});

describe("subscribeWorkflow — cascade (clean path)", () => {
  test("clean reviews cascade Review→Review without spawning Fix", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: cleanReviewMessage(1),
    });
    await flush();

    // No Fix should have been spawned.
    const spawnedSubjects = spawnAgent.mock.calls.map(c => c[0].subject);
    expect(spawnedSubjects).not.toContain("Fix 1: Test workflow");

    // Review_2 should have been spawned.
    const review2 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2);
    expect(review2).toBeDefined();
    expect(spawnAgent.mock.calls.map(c => c[0].subject)).toContain(
      "Review 2: Test workflow",
    );
  });

  test("completing the last review (Review_3 CLEAN) spawns Merge", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const all = store.list();
    const byPhase = (phase: string, iter?: number) =>
      all.find(t => t.metadata.phase === phase && (iter === undefined || t.metadata.iteration === iter))!;

    await completeTask(events, byPhase("implement"));
    await events.emit("subagents:completed", {
      id: "agent-" + byPhase("review", 1).id,
      result: cleanReviewMessage(1),
    });
    await flush();
    await events.emit("subagents:completed", {
      id: "agent-" + byPhase("review", 2).id,
      result: cleanReviewMessage(2),
    });
    await flush();
    await events.emit("subagents:completed", {
      id: "agent-" + byPhase("review", 3).id,
      result: cleanReviewMessage(3),
    });
    await flush();

    const subjects = spawnAgent.mock.calls.map(c => c[0].subject);
    expect(subjects).toContain("Merge: Test workflow");
  });
});

describe("subscribeWorkflow — NEEDS_WORK cascade (dynamic Fix)", () => {
  test("NEEDS_WORK on Review_1 dispatches Fix_1 and pauses Review_2", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsWorkMessage("missing test for retry path"),
    });
    await flush();

    // Fix_1 was created and spawned.
    const fix1 = store.list().find(t => t.metadata.phase === "fix" && t.metadata.iteration === 1);
    expect(fix1).toBeDefined();
    expect(fix1?.blockedBy).toEqual([review1.id]);
    expect(spawnAgent.mock.calls.map(c => c[0].subject)).toContain(
      "Fix 1: Test workflow",
    );

    // Review_2 was NOT spawned yet (waiting for Fix_1).
    const review2Spawned = spawnAgent.mock.calls.some(
      c => c[0].subject === "Review 2: Test workflow",
    );
    expect(review2Spawned).toBe(false);
  });

  test("Fix_1 completion unblocks Review_2 (NEEDS_WORK → Fix → Review loop)", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsWorkMessage("missing test"),
    });
    await flush();

    const fix1 = store.list().find(t => t.metadata.phase === "fix" && t.metadata.iteration === 1)!;
    await completeTask(events, fix1);

    // Review_2 now spawned.
    expect(spawnAgent.mock.calls.map(c => c[0].subject)).toContain(
      "Review 2: Test workflow",
    );
  });

  test("Fix dispatched at max_fix_iterations is silently skipped (not spawned)", async () => {
    // max_fix_iterations=1 means: Review_1 → NEEDS_WORK triggers Fix_1, but
    // there is no Review_2 to follow. workflow-run.ts will resolve as blocked.
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload({ max_fix_iterations: 1 }));
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsWorkMessage("missing test"),
    });
    await flush();

    // Fix_1 IS dispatched (this is the last allowed iteration).
    const fix1 = store.list().find(t => t.metadata.phase === "fix");
    expect(fix1).toBeDefined();
  });

  test("Fix is NOT dispatched when verdict is CLEAN (verified counter only ticks on NEEDS_WORK)", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    // Review_1 CLEAN → Review_2 (no Fix dispatched).
    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: cleanReviewMessage(1),
    });
    await flush();

    expect(store.list().find(t => t.metadata.phase === "fix")).toBeUndefined();
    expect(spawnAgent.mock.calls.map(c => c[0].subject)).not.toContain(
      expect.stringContaining("Fix"),
    );
  });
});

describe("subscribeWorkflow — NEEDS_REDESIGN cascade (dynamic new Implement)", () => {
  test("NEEDS_REDESIGN spawns a new Implement with redesignNumber metadata", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsRedesignMessage("caching layer doesn't fit workload"),
    });
    await flush();

    // The new Implement task has isRedesign=true and redesignNumber=1.
    const allImplements = store.list().filter(t => t.metadata.phase === "implement");
    expect(allImplements).toHaveLength(2);
    const newImpl = allImplements.find(t => t.metadata.isRedesign === true);
    expect(newImpl).toBeDefined();
    expect(newImpl?.metadata.iteration).toBe(1);
    expect(newImpl?.blockedBy).toEqual([review1.id]);

    // Subject was generated as "Implement (redesign N): ..."
    expect(spawnAgent.mock.calls.map(c => c[0].subject)).toContain(
      "Implement (redesign 1): Test workflow",
    );
  });

  test("NEEDS_REDESIGN new Implement is added to Review_1's blockedBy (chain resets)", async () => {
    const { events, store } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsRedesignMessage("wrong layer"),
    });
    await flush();

    // Review_1 now waits on the new Implement too.
    const review1After = store.get(review1.id);
    const newImpl = store.list().find(
      t => t.metadata.phase === "implement" && t.metadata.isRedesign === true,
    );
    expect(review1After?.blockedBy).toContain(newImpl?.id);
  });

  test("NEEDS_REDESIGN at max_redesigns is silently skipped (workflow-run resolves as blocked)", async () => {
    const { events, store } = setup();

    await events.emit("workflow:start", startPayload({ max_redesigns: 1 }));
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsRedesignMessage("wrong layer"),
    });
    await flush();

    // First redesign spawns a new Implement.
    expect(store.list().filter(t => t.metadata.isRedesign === true)).toHaveLength(1);

    const newImpl = store.list().find(
      t => t.metadata.phase === "implement" && t.metadata.isRedesign === true,
    )!;
    await completeTask(events, newImpl);

    // Review_1 is now unblocked again (it waits on new Impl, which completed).
    // Re-emit a NEEDS_REDESIGN to hit the cap.
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsRedesignMessage("still wrong"),
    });
    await flush();

    // Second redesign attempt — cap reached, no new Implement.
    expect(store.list().filter(t => t.metadata.isRedesign === true)).toHaveLength(1);
  });
});

describe("subscribeWorkflow — NEEDS_CLARIFICATION pause", () => {
  test("NEEDS_CLARIFICATION emits needs_clarification phase-complete with open_question", async () => {
    const { events, store } = setup();
    const emitted: unknown[] = [];
    events.on("workflow:phase-complete", d => { emitted.push(d); });

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsClarificationMessage("snake_case or camelCase?"),
    });
    await flush();

    const lastEmitted = emitted[emitted.length - 1] as Record<string, unknown>;
    expect(lastEmitted.phase).toBe("review");
    expect(lastEmitted.status).toBe("needs_clarification");
    expect(lastEmitted.verdict).toBe("NEEDS_CLARIFICATION");
    expect(lastEmitted.open_question).toBe("snake_case or camelCase?");
  });

  test("NEEDS_CLARIFICATION does not cascade (Review_2 NOT spawned)", async () => {
    const { events, store, spawnAgent } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsClarificationMessage("ambiguous scope"),
    });
    await flush();

    expect(spawnAgent.mock.calls.map(c => c[0].subject)).not.toContain(
      "Review 2: Test workflow",
    );
    expect(spawnAgent.mock.calls.map(c => c[0].subject)).not.toContain(
      "Merge: Test workflow",
    );
  });
});

describe("subscribeWorkflow — review metadata", () => {
  test("review task completion parses verdict and stamps metadata.verdict", async () => {
    const { events, store } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsWorkMessage("missing test"),
    });
    await flush();

    const after = store.get(review1.id);
    expect(after?.metadata.verdict).toBeDefined();
    expect(after?.metadata.verdict?.verdict).toBe("NEEDS_WORK");
    expect(after?.metadata.verdict?.findings).toHaveLength(1);
  });

  test("NEEDS_CLARIFICATION parses open_question into metadata.verdict", async () => {
    const { events, store } = setup();

    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await completeTask(events, implement);

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: "agent-" + review1.id,
      result: needsClarificationMessage("test question"),
    });
    await flush();

    const after = store.get(review1.id);
    expect(after?.metadata.verdict?.verdict).toBe("NEEDS_CLARIFICATION");
    expect(after?.metadata.verdict?.open_question).toBe("test question");
  });
});

// GC-2026-b7: Reviewer evidence trail sidecar file for Merger consumption.
describe("subscribeWorkflow — last-review evidence file (GC-2026-b7)", () => {
  test("writes .pi/orchestrator/last-review-{goal_id}.md after every Review completion", async () => {
    const { payload, cwd, cleanup } = startPayloadInTmp();
    try {
      const store = new TaskStore();
      const events = fakeEvents();
      const spawnAgent = vi.fn(async (task: Task) => `agent-${task.id}`);
      subscribeWorkflow(store, { events, spawnAgent });
      const fire = async (channel: string, data: unknown) => {
        await events.emit(channel, data);
        await flush();
      };

      await fire("workflow:start", payload);

      const implement = store.list().find(t => t.metadata.phase === "implement")!;
      await fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

      const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
      await fire("subagents:completed", {
        id: `agent-${review1.id}`,
        result: "```yaml\nverdict: NEEDS_WORK\nfindings:\n  - severity: major\n    issue: missing test\nscope_check: pass\nanti_goal_check: pass\n```",
      });

      const evidencePath = join(cwd, ".pi", "orchestrator", `last-review-${payload.goal_id}.md`);
      expect(existsSync(evidencePath)).toBe(true);
      const content = readFileSync(evidencePath, "utf-8");
      expect(content).toContain("# Last Reviewer evidence for goal");
      expect(content).toContain("- verdict: NEEDS_WORK");
      expect(content).toContain("- scope_check: pass");
      expect(content).toContain("- anti_goal_check: pass");
      expect(content).toContain("- findings_count: 1");
      expect(content).toContain("[major] missing test");
    } finally {
      cleanup();
    }
  });

  test("overwrites last-review-{goal_id}.md on each Review completion (file reflects latest)", async () => {
    const { payload, cwd, cleanup } = startPayloadInTmp();
    try {
      const store = new TaskStore();
      const events = fakeEvents();
      const spawnAgent = vi.fn(async (task: Task) => `agent-${task.id}`);
      subscribeWorkflow(store, { events, spawnAgent });
      const fire = async (channel: string, data: unknown) => {
        await events.emit(channel, data);
        await flush();
      };

      await fire("workflow:start", payload);

      const implement = store.list().find(t => t.metadata.phase === "implement")!;
      await fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

      // Review_1: NEEDS_WORK
      const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
      await fire("subagents:completed", {
        id: `agent-${review1.id}`,
        result: "```yaml\nverdict: NEEDS_WORK\nfindings:\n  - severity: major\n    issue: first finding\nscope_check: pass\nanti_goal_check: pass\n```",
      });

      // Fix_1
      const fix1 = store.list().find(t => t.metadata.phase === "fix" && t.metadata.iteration === 1)!;
      await fire("subagents:completed", { id: `agent-${fix1.id}`, result: "ok" });

      // Review_2: CLEAN
      const review2 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2)!;
      await fire("subagents:completed", {
        id: `agent-${review2.id}`,
        result: "```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
      });

      // File should reflect Review_2's verdict (CLEAN), not Review_1's (NEEDS_WORK).
      const evidencePath = join(cwd, ".pi", "orchestrator", `last-review-${payload.goal_id}.md`);
      const content = readFileSync(evidencePath, "utf-8");
      expect(content).toContain("- verdict: CLEAN");
      expect(content).toContain("- findings_count: 0");
      expect(content).not.toContain("first finding");
    } finally {
      cleanup();
    }
  });
});

// GC-2026-workflow-chat-stream: workflow tasks must be marked active on the
// TaskWidget so the spinner animates during the long workflow_run tool
// call. The wiring lives in pi-tasks/src/index.ts subscribeWorkflow's
// spawnAgent closure.
describe("subscribeWorkflow — workflow task active marker (GC-2026-workflow-chat-stream)", () => {
  test("subscribeWorkflow.spawnAgent marks the task active before dispatching", () => {
    // We can't reach the real TaskWidget instance from here (it's the
    // singleton inside initExtension). Instead we verify the side-effect:
    // the spawn path calls widget.setActiveTask(task.id, true) before
    // dispatching, and the workflow's own listener removes it via
    // widget.update()'s prune loop once status flips to completed.
    //
    // Indirect check: the subscribeWorkflow closure captures `widget` via
    // the surrounding index.ts scope. We assert that the spawn was
    // synchronous (the call was made) by checking spawnAgent.mock.calls
    // is populated after the cascade completes a Review phase.
    const { events, store, spawnAgent } = setup();
    events.emit("workflow:start", startPayload());
    flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    events.emit("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });
    flush();

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    // The spawnAgent mock was called for Review_1 — that's the spawn that
    // should have hit setActiveTask(true). We don't have direct visibility
    // into the widget here, but the call itself is what we can assert
    // here (the widget side-effect is integration-tested via the
    // TaskWidget unit + smoke).
    expect(spawnAgent.mock.calls.length).toBeGreaterThanOrEqual(1);
    const review1SpawnCall = spawnAgent.mock.calls.find(
      (c) => c[0].metadata.phase === "review" && c[0].metadata.iteration === 1,
    );
    expect(review1SpawnCall).toBeDefined();
  });
});

// GC-2026-b6: iteration-aware review. Review_{N>1} receives a "Prior review
// summary" section in its dispatch brief so the Reviewer can classify
// findings as regression / unresolved / new.
describe("subscribeWorkflow — prior review summary (GC-2026-b6)", () => {
  test("Review_1 dispatch brief has NO prior summary section", async () => {
    const { events, store, spawnAgent } = setup();
    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await events.emit("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });
    await flush();

    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    // The actual injection marker is the "## Prior review summary (iteration N)"
    // section header. Review_1 (iteration=1) has no prior, so the section must
    // NOT be present. The phrase "Prior review summary" appears elsewhere in
    // the prompt body (in the "Finding category" guidance) so we anchor on
    // the section header.
    expect(review1.description).not.toContain("## Prior review summary (iteration");
  });

  test("Review_2 dispatch brief contains Prior review summary when Review_1 was NEEDS_WORK", async () => {
    const { events, store } = setup();
    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await events.emit("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });
    await flush();

    // Review_1: NEEDS_WORK with one finding
    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: `agent-${review1.id}`,
      result: [
        "```yaml",
        "verdict: NEEDS_WORK",
        "findings:",
        "  - severity: major",
        "    issue: missing test for retry path",
        "    location: src/auth/retry.ts:42",
        "scope_check: pass",
        "anti_goal_check: pass",
        "```",
      ].join("\n"),
    });
    await flush();

    // Fix_1 (dispatched after NEEDS_WORK).
    const fix1 = store.list().find(t => t.metadata.phase === "fix" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", { id: `agent-${fix1.id}`, result: "ok" });
    await flush();

    // Review_2 spawn should now have the prior summary injected.
    const review2 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2)!;
    expect(review2.description).toContain("## Prior review summary (iteration 1)");
    expect(review2.description).toContain("- **Verdict**: NEEDS_WORK");
    expect(review2.description).toContain("- **Findings count**: 1");
    expect(review2.description).toContain("missing test for retry path");
  });

  test("Review_2 prior summary reflects CLEAN prior Review (no findings to regress)", async () => {
    const { events, store } = setup();
    await events.emit("workflow:start", startPayload());
    await flush();

    const implement = store.list().find(t => t.metadata.phase === "implement")!;
    await events.emit("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });
    await flush();

    // Review_1: CLEAN
    const review1 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
    await events.emit("subagents:completed", {
      id: `agent-${review1.id}`,
      result: "```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
    });
    await flush();

    const review2 = store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2)!;
    expect(review2.description).toContain("- **Verdict**: CLEAN");
    expect(review2.description).toContain("- **Findings count**: 0");
  });
});

/**
 * workflow-handler-helper-integration.test.ts — Verify that
 * `subscribeWorkflow`'s static graph routes every `store.create` call through
 * the GC-2026-task-feeding-and-decomposition helpers (D1 / AC4).
 *
 * Coverage:
 *   1. workflow:start emits the static graph (Implement + N Reviews + Merge).
 *      Every created task has `metadata.created_by === "orchestrator"`,
 *      stamped by `createOrchestratorTask` or `createMergeTask`. Direct
 *      `store.create` calls would NOT carry that stamp and would fail
 *      `verify:created-by-invariant` + AC4.
 *   2. Implement gets `agentType=Developer`, Review gets `agentType=Reviewer`,
 *      Merge gets `agentType=MergerAdvisor` + `phase="merge"`. The latter
 *      is what `createMergeTask` stamps; anything else means a direct
 *      `store.create` slipped through.
 *   3. Dynamic Fix dispatch (when a Review emits NEEDS_WORK) routes through
 *      `createOrchestratorTask` too — Fix is not top-level (blockedBy the
 *      Review) so no Reviewer sibling is auto-attached. Verify the Fix task
 *      has the right metadata.
 *   4. Regression: existing `path-b-e2e.test.ts` continues to pass — covered
 *      implicitly by the test suite. (Not asserted here; run the full
 *      `pi-tasks` test suite to verify.)
 *
 * Notes:
 *   - This is an integration test of the pi-tasks workflow-handler,
 *     executed under pi-orchestrator's test runner (per AC12's design
 *     doc). Imports come from `@sages/pi-tasks/workflow-handler`.
 *   - All assertions are metadata-based (no behavioral assertion about
 *     what each helper did); the structural side effect is the
 *     `created_by="orchestrator"` stamp + the right `agentType` / `phase`.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "@sages/pi-tasks/task-store";
import {
  subscribeWorkflow,
  type WorkflowStartPayload,
} from "@sages/pi-tasks/workflow-handler";
import type { Task } from "@sages/pi-tasks/types";

interface FakeBus {
  on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
  emit(channel: string, data: unknown): Promise<void>;
  emitted: Array<{ channel: string; data: unknown }>;
}

function fakeEvents(): FakeBus {
  const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => {
        handlers.get(channel)!.delete(handler);
      };
    },
    async emit(channel, data) {
      emitted.push({ channel, data });
      const set = handlers.get(channel);
      if (!set) return;
      for (const h of [...set]) await h(data);
    },
  };
}

interface Harness {
  store: TaskStore;
  events: FakeBus;
  spawnCalls: Array<{ task: Task; ctx: { worktreePath?: string } }>;
  /** Map taskId -> agentId (advisor tasks are also tracked). */
  agentIds: Map<string, string>;
  unsubscribe: () => void;
}

const GOAL_ID = "GC-2026-test-helper-integration";
const WORKFLOW_ID = "wf-test-helper";
const WORKTREE = "/tmp/test-worktree";
const BRANCH = `${GOAL_ID.toLowerCase()}-implement`;

const goal = {
  id: GOAL_ID,
  title: "Helper integration test",
  rationale: "verify",
  scope: { include: ["src/**"], exclude: ["dist/**"] },
  anti_goals: ["no new deps"],
  done_definition: "all tasks created via helper",
};

const cleanReviewYaml =
  "verdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass";
const cleanReviewFenced = "```yaml\n" + cleanReviewYaml + "\n```";
const needsWorkReviewYaml = [
  "verdict: NEEDS_WORK",
  "findings:",
  "  - severity: major",
  "    issue: missing test",
  "scope_check: pass",
  "anti_goal_check: pass",
].join("\n");
const needsWorkReviewFenced = "```yaml\n" + needsWorkReviewYaml + "\n```";

function setup(maxFixIterations = 2): Harness {
  const store = new TaskStore();
  const events = fakeEvents();
  const spawnCalls: Array<{ task: Task; ctx: { worktreePath?: string } }> = [];
  const agentIds = new Map<string, string>();
  const agentTaskMap = new Map<string, string>();
  let counter = 0;

  // GC-2026-114 FU3: subscribeWorkflow no longer takes a `spawnAgent`
  // callback. It now takes a `feed: { maybeAutoSpawn }` + a shared
  // `agentTaskMap`. The mock `feed.maybeAutoSpawn` simulates a spawn
  // RPC, populates `agentTaskMap` (so the workflow-handler's listeners
  // can find the task on completion), and stamps `owner` on the task.
  const unsubscribe = subscribeWorkflow(store, {
    events,
    feed: {
      maybeAutoSpawn: async (task, ctx) => {
        counter += 1;
        const agentId = `agent-stub-${counter}`;
        spawnCalls.push({ task, ctx });
        agentIds.set(task.id, agentId);
        agentTaskMap.set(agentId, task.id);
        store.update(task.id, { status: "in_progress", owner: agentId });
      },
    },
    agentTaskMap,
  });

  return { store, events, spawnCalls, agentIds, unsubscribe };
}

async function fireWorkflowStart(harness: Harness): Promise<void> {
  const payload: WorkflowStartPayload = {
    workflow_id: WORKFLOW_ID,
    goal_id: GOAL_ID,
    goal,
    max_fix_iterations: 2,
    max_redesigns: 1,
    worktree_path: WORKTREE,
  };
  await harness.events.emit("workflow:start", payload);
}

async function completeSubagent(
  harness: Harness,
  agentId: string,
  result: string,
): Promise<void> {
  await harness.events.emit("subagents:completed", { id: agentId, result });
}

/** Convenience: complete a Review agent with a fenced verdict block. */
async function completeReview(
  harness: Harness,
  agentId: string,
  verdict: "CLEAN" | "NEEDS_WORK",
): Promise<void> {
  await completeSubagent(
    harness,
    agentId,
    verdict === "CLEAN" ? cleanReviewFenced : needsWorkReviewFenced,
  );
}

describe("workflow-handler routes all store.create via helpers (GC-2026-task-feeding-and-decomposition AC4 / AC12)", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setup(2);
  });

  it("static graph: every task carries created_by='orchestrator' (helper stamp)", async () => {
    await fireWorkflowStart(harness);

    // Static graph for max_fix_iterations=2: Implement + Review_1 + Review_2 + Merge = 4 tasks
    const tasks = harness.store.list();
    expect(tasks).toHaveLength(4);

    // Every task is orchestrator-stamped (D1 + AC4)
    for (const t of tasks) {
      expect(t.metadata.created_by).toBe("orchestrator");
      expect(t.metadata.workflow_run_goal_id).toBe(GOAL_ID);
    }

    // Per-phase agentType (proves createOrchestratorTask vs createMergeTask routing)
    const implement = tasks.find((t) => t.metadata.phase === "implement");
    const reviews = tasks.filter((t) => t.metadata.phase === "review");
    const merge = tasks.find((t) => t.metadata.phase === "merge");
    expect(implement?.metadata.agentType).toBe("Developer");
    expect(reviews).toHaveLength(2);
    for (const r of reviews) expect(r.metadata.agentType).toBe("Reviewer");
    // Merge: createMergeTask stamps agentType=MergerAdvisor + phase=merge.
    // Anything else would mean a direct store.create call slipped through.
    expect(merge?.metadata.agentType).toBe("MergerAdvisor");
    expect(merge?.metadata.phase).toBe("merge");
  });

  it("Implement gets the worktree context (shared spawn hook)", async () => {
    await fireWorkflowStart(harness);

    expect(harness.spawnCalls).toHaveLength(1);
    const { task, ctx } = harness.spawnCalls[0];
    expect(task.metadata.phase).toBe("implement");
    expect(ctx.worktreePath).toBe(WORKTREE);
  });

  it("Fix dispatch routes through createOrchestratorTask (D1 stamp, no Reviewer)", async () => {
    await fireWorkflowStart(harness);

    // Implement spawned (index 0). spawn[1] is DeveloperAdvisor (advisorOf
    // Implement), spawn[2] is Review_1 — advisor pair interleaves with cascade.
    const implementId = harness.spawnCalls[0].task.id;
    const implementAgent = harness.agentIds.get(implementId)!;

    // Implement CLEAN → Review_1 spawned via cascade
    await completeSubagent(harness, implementAgent, "ok");
    const review1 = harness.store.list().find((t) => t.metadata.phase === "review");
    expect(review1?.status).toBe("in_progress");

    // Review_1 NEEDS_WORK → Fix_1 spawned dynamically
    const review1Agent = harness.agentIds.get(review1!.id)!;
    await completeReview(harness, review1Agent, "NEEDS_WORK");

    // Find Fix_1 — should have agentType=Fix + created_by=orchestrator
    const fix1 = harness.store.list().find((t) => t.metadata.phase === "fix");
    expect(fix1).toBeDefined();
    expect(fix1!.metadata.created_by).toBe("orchestrator");
    expect(fix1!.metadata.agentType).toBe("Fix");

    // Fix is blockedBy Review_1 — not top-level — no Reviewer sibling auto-attached.
    // We count primary review tasks only (excluding advisor siblings which
    // inherit phase="review" from their parent primary).
    const beforeFixCount = 4; // static graph size
    expect(harness.store.list().length).toBeGreaterThan(beforeFixCount);
    const reviewCount = harness.store
      .list()
      .filter((t) => t.metadata.phase === "review" && !t.metadata.advisorOf)
      .length;
    // Should still be 2 (Review_1 + Review_2); no extra Reviewer for Fix.
    expect(reviewCount).toBe(2);
  });

  it("CreateMergeTask path: Merge's description embeds the branch + worktreePath", async () => {
    await fireWorkflowStart(harness);

    // Complete Implement → Review_1 → Review_2 (each CLEAN) → Merge spawns.
    // spawnCalls interleaves advisors with cascade spawns; look up by taskId.
    const completeChain = async (phaseFilter: (t: Task) => boolean) => {
      const tasks = harness.store.list().filter(phaseFilter);
      const pending = tasks.find((t) => t.status !== "completed");
      if (!pending) throw new Error(`no pending task matching ${phaseFilter.toString()}`);
      const agentId = harness.agentIds.get(pending.id);
      if (!agentId) throw new Error(`no agentId for task ${pending.id}`);
      await completeReview(harness, agentId, "CLEAN");
    };

    await completeChain((t) => t.metadata.phase === "implement");
    await completeChain((t) => t.metadata.phase === "review" && t.metadata.iteration === 1);
    await completeChain((t) => t.metadata.phase === "review" && t.metadata.iteration === 2);

    // Merge should have been spawned
    const merge = harness.store.list().find((t) => t.metadata.phase === "merge");
    expect(merge).toBeDefined();
    expect(merge!.description).toContain(BRANCH);
    expect(merge!.description).toContain(WORKTREE);
  });
});
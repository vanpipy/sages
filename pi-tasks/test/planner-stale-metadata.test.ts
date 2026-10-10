/**
 * planner-stale-metadata.test.ts — Tests that the post-GC-2026-122 intent-task
 * predicate + inferKind contract holds for tasks WITHOUT agentType.
 *
 * GC-2026-122 reversed GC-2026-121: intent tasks no longer auto-stamp
 * agentType=Planner, and the unified task-feeder no longer auto-spawns a
 * Planner subagent on intent tasks. The intent task is now exclusively
 * consumed by the main LLM via the `before_agent_start` reminder (see
 * `pi-tasks/src/intent-reminder.ts` + `composeIntentReminder`).
 *
 * This file pins the post-GC-2026-122 contract:
 *
 *   - `isFeedableTask(t)` returns FALSE for `kind=intent` tasks without
 *     `agentType` — the main LLM is the only consumer.
 *   - `inferKind` no longer stamps `agentType=Planner` for user-authored
 *     intent tasks.
 *   - `isFeedableTask` continues to reject tasks that have neither
 *     `agentType` nor `kind=intent` (truly orphaned tasks).
 *
 * (The pre-GC-2026-122 tests for the auto-stamp fallback were deleted
 * along with the GC-2026-121 follow-up; the auto-stamp path no longer
 * exists.)
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import { isFeedableTask } from "../src/task-feeder.js";

describe("Post-GC-2026-122 intent-task predicate (no Planner auto-stamp)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("isFeedableTask returns FALSE for kind=intent without agentType (main LLM is sole consumer)", () => {
    // GC-2026-122: the main LLM is the only consumer of intent tasks
    // (via the before_agent_start reminder). The unified feeder does
    // NOT auto-spawn a Planner for them anymore.
    const t = store.create("research X", "Investigate X.");
    expect(t.metadata.kind).toBe("intent");
    expect(t.metadata.agentType).toBeUndefined(); // post-122: no auto-stamp
    expect(isFeedableTask(t)).toBe(false);
  });

  it("isFeedableTask returns FALSE for hand-crafted stale intent tasks (no agentType)", () => {
    // Pre-GC-2026-122 tasks (loaded from a stale on-disk file) with
    // kind=intent but no agentType are also NOT feedable. The
    // before_agent_start reminder is the sole consumer, and the
    // reminder reaches the LLM via the live store, not the feeder.
    const rawTask = {
      id: "stale-1",
      subject: "Pre-fix intent task",
      description: "Description.",
      status: "pending" as const,
      metadata: {
        created_by: "user",
        kind: "intent",
        requires_decomposition: true,
        // NOTE: no agentType — this is the stale shape, but the
        // post-122 feeder does NOT auto-spawn it.
      },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(rawTask as any)).toBe(false);
  });

  it("isFeedableTask still rejects raw tasks without agentType AND without kind=intent", () => {
    // Truly orphaned tasks (no agentType, no kind=intent) are still
    // rejected. The main LLM has no consumer for them either.
    const rawTask = {
      id: "raw-1",
      subject: "Truly manual",
      description: "Description.",
      status: "pending" as const,
      metadata: {
        created_by: "user",
        // No agentType, no kind=intent — truly orphaned
      },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(rawTask as any)).toBe(false);
  });

  it("inferKind does NOT stamp Planner for the user-authored agentType-less path", () => {
    // Post-GC-2026-122: inferKind stamps kind=intent + requires_decomposition=true
    // but does NOT auto-stamp agentType=Planner. The Planner subagent
    // is no longer auto-spawned for user-authored intent tasks.
    const t = store.create("research Y", "Investigate Y.");
    expect(t.metadata.kind).toBe("intent");
    expect(t.metadata.requires_decomposition).toBe(true);
    expect(t.metadata.agentType).toBeUndefined();
  });
});

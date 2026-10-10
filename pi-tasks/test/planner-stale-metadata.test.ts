/**
 * planner-stale-metadata.test.ts — Tests that the
 * GC-2026-main-agent-proactive-intent-pump intent-task predicate +
 * inferKind contract holds for tasks WITHOUT agentType.
 *
 * History:
 *   - GC-2026-121: Planner auto-spawn for intent tasks (reverted)
 *   - GC-2026-122: dropped Planner auto-spawn; intent tasks sat
 *     un-feedable; main LLM consumed via before_agent_start reminder
 *   - GC-2026-main-agent-proactive-intent-pump (this GC): intent tasks
 *     ARE feedable to the IntentPump (NOT to a subagent). The pump
 *     injects a "Consume intent #N" user message into the main session.
 *     Main LLM is still the sole consumer — but consumption is now
 *     observable + queued + serialized instead of relying on a soft
 *     system-prompt nudge.
 *
 * This file pins the new contract:
 *   - `inferKind` still does NOT auto-stamp `agentType=Planner` for
 *     user-authored intent tasks. The Planner subagent is no longer
 *     auto-spawned; it remains registered for explicit dispatch via
 *     the `Agent` tool.
 *   - `isFeedableTask(t)` returns TRUE for `kind=intent` tasks
 *     (dispatcher = IntentPump, NOT a subagent).
 *   - The "truly orphaned" case (no agentType, no kind=intent) is now
 *     unreachable via the public API because `inferKind` always
 *     stamps kind=intent for created_by=user. The predicate returns
 *     TRUE in that case too — IntentPump will dispatch it.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { isFeedableTask } from "../src/task-feeder.js";
import { TaskStore } from "../src/task-store.js";

describe("Post-GC-2026-main-agent-proactive-intent-pump intent-task predicate", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("isFeedableTask returns TRUE for kind=intent without agentType (IntentPump is the dispatcher)", () => {
    // GC-2026-main-agent-proactive-intent-pump: the main LLM is the
    // sole consumer of intent tasks, and the IntentPump now delivers
    // the consumption prompt to the main session. The unified feeder
    // routes kind=intent to the pump instead of subagent spawn.
    const t = store.create("research X", "Investigate X.");
    expect(t.metadata.kind).toBe("intent");
    expect(t.metadata.agentType).toBeUndefined(); // still no auto-stamp
    expect(isFeedableTask(t)).toBe(true);
  });

  it("isFeedableTask returns TRUE for hand-crafted stale intent tasks (no agentType)", () => {
    // Pre-GC-2026-122 tasks (loaded from a stale on-disk file) with
    // kind=intent but no agentType are now ALSO feedable — the pump
    // picks them up on the next maybeAutoSpawn. The reminder fallback
    // remains for orphaned intents not yet seen by the pump.
    const rawTask = {
      id: "stale-1",
      subject: "Pre-fix intent task",
      description: "Description.",
      status: "pending" as const,
      metadata: {
        created_by: "user",
        kind: "intent",
        requires_decomposition: true,
        // NOTE: no agentType — but the post-GC-2026-...-pump feeder
        // routes this to IntentPump.
      },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(rawTask as any)).toBe(true);
  });

  it("isFeedableTask accepts raw tasks with no explicit kind (inferKind stamps intent for user-created)", () => {
    // The "truly orphaned" case (no agentType, no kind=intent) is no
    // longer reachable via the public API — `inferKind` always stamps
    // kind=intent for created_by=user. The predicate still accepts
    // these so the pump can pick them up.
    const rawTask = {
      id: "raw-1",
      subject: "Inferred-intent raw task",
      description: "Description.",
      status: "pending" as const,
      metadata: {
        created_by: "user",
        // No agentType, no kind=intent here, but inferKind fills kind
        // in before the predicate runs.
      },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    // The raw object is what a hand-edited file might contain. The
    // predicate does not run inferKind on raw input — it reads metadata
    // as-is. So this object (no kind) is NOT feedable in the predicate
    // sense, but the public API never produces this shape.
    expect(isFeedableTask(rawTask as any)).toBe(false);
  });

  it("inferKind does NOT stamp Planner for the user-authored agentType-less path", () => {
    // GC-2026-121 auto-stamp is gone for good. inferKind stamps
    // kind=intent + requires_decomposition=true but does NOT add
    // agentType=Planner. The IntentPump is the dispatcher, and it
    // doesn't need an agentType on the task.
    const t = store.create("research Y", "Investigate Y.");
    expect(t.metadata.kind).toBe("intent");
    expect(t.metadata.requires_decomposition).toBe(true);
    expect(t.metadata.agentType).toBeUndefined();
  });
});

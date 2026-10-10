/**
 * planner-auto-spawn.test.ts — INVERTED tests asserting that
 * `TaskStore.create` does NOT auto-stamp `agentType: "Planner"` on
 * intent tasks (GC-2026-122).
 *
 * GC-2026-121 originally added the Planner auto-spawn so the unified
 * feeder would dispatch a Planner subagent that calls `decompose_task`
 * autonomously. This file used to assert the auto-spawn behavior.
 *
 * GC-2026-122 reverses that design. The Planner auto-spawn was
 * empirically too conservative for informational intents (e.g.
 * "了解一下当前仓库") because the Planner's prompt forbids any repo
 * exploration or context-aware reasoning — so it BLOCKed on every
 * intent that wasn't a narrow, mechanically-decomposable ask, leaving
 * the user task pending forever.
 *
 * The fix: intent tasks keep `kind: "intent"` + `requires_decomposition:
 * true` (semantic markers) but lose the auto-stamped `agentType`. The
 * main LLM is the sole consumer; the `before_agent_start` reminder in
 * `pi-tasks/src/intent-reminder.ts` surfaces pending intents to the LLM
 * via system-prompt injection.
 *
 * The Planner subagent itself is still defined in
 * `pi-subagents/src/default-agents.ts` — the main LLM can dispatch it
 * explicitly via the `Agent` tool when it wants a mechanical spec
 * compiler.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { isFeedableTask } from "../src/task-feeder.js";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore.create does NOT auto-stamp agentType=Planner (GC-2026-122 — inverted from GC-2026-121)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("infers kind=intent but does NOT auto-stamp agentType=Planner (no agentType default for user tasks)", () => {
    const task = store.create("research X", "Investigate topic X.");
    expect(task.metadata.kind).toBe("intent");
    expect(task.metadata.agentType).toBeUndefined();
  });

  it("isFeedableTask returns TRUE for the default intent task (dispatcher = IntentPump)", () => {
    // GC-2026-main-agent-proactive-intent-pump replaces the GC-2026-122
    // "no consumer" state. The default user task (no agentType) is now
    // kind=intent and IS feedable — but routed to the IntentPump via
    // the spawn router in `task-feeder.ts:registerTaskFeeder`, NOT to a
    // subagent. The pump injects a "Consume intent #N" user message
    // into the main session.
    const task = store.create("research X", "Investigate topic X.");
    expect(isFeedableTask(task)).toBe(true);
  });

  it("does NOT override an explicit user-supplied agentType on intent tasks", () => {
    // If the caller explicitly sets agentType=Explore, the store must
    // not clobber it. (Caller is asserting a specific dispatcher.)
    const task = store.create("investigate X", "Investigate X deeply.", undefined, {
      created_by: "user",
      kind: "intent",
      agentType: "Explore",
    });
    expect(task.metadata.agentType).toBe("Explore");
  });

  it("does NOT change actionable task inference (kind=actionable keeps explicit agentType)", () => {
    const task = store.create("fix typo", "Fix the typo.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("actionable");
    expect(task.metadata.agentType).toBe("Developer");
  });

  it("does NOT change orchestrator step inference (kind=step keeps explicit agentType)", () => {
    const task = store.create("step", "Implement.", undefined, {
      created_by: "orchestrator",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("step");
    expect(task.metadata.agentType).toBe("Developer");
  });

  it("still sets requires_decomposition=true on intent tasks (semantic intent marker)", () => {
    // The semantic intent marker stays even though the auto-stamp is gone —
    // the before_agent_start reminder reads requires_decomposition to know
    // this task is an intent (vs an actionable that the LLM just hasn't gotten to).
    const task = store.create("research X", "Investigate X.");
    expect(task.metadata.requires_decomposition).toBe(true);
  });

  it("default-created user task (no metadata) is kind=intent with no agentType", () => {
    const task = store.create("do something", "details");
    expect(task.metadata.kind).toBe("intent");
    expect(task.metadata.agentType).toBeUndefined();
  });
});

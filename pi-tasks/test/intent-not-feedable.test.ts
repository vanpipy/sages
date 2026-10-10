/**
 * intent-not-feedable.test.ts — GC-2026-main-agent-proactive-intent-pump
 *
 * Inverts the GC-2026-122 assertions: `kind=intent` (default user task,
 * no agentType) IS feedable to the IntentPump. Tasks with no `kind` and
 * no `agentType` are still NOT feedable (truly unmapped). Tasks with
 * `kind=actionable` and no agentType are also NOT feedable (actionable
 * requires an explicit dispatcher).
 *
 * The feeder's spawn router inside `maybeAutoSpawn` decides whether to
 * dispatch to IntentPump (kind=intent) or to a subagent (agentType).
 * `isFeedableTask` only answers the binary "is this dispatcher-eligible"
 * question.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { isFeedableTask } from "../src/task-feeder.js";
import { TaskStore } from "../src/task-store.js";

describe("isFeedableTask — kind=intent IS feedable (GC-2026-main-agent-proactive-intent-pump)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("kind=intent (default user task, no agentType) IS feedable → IntentPump", () => {
    const task = store.create("research X", "Investigate topic X deeply.");
    expect(task.metadata.kind).toBe("intent");
    expect(isFeedableTask(task)).toBe(true);
  });

  it("kind=intent with explicit agentType IS feedable — caller override (subagent path)", () => {
    const task = store.create("investigate X", "Investigate X.", undefined, {
      created_by: "user",
      kind: "intent",
      agentType: "Explore",
    });
    expect(isFeedableTask(task)).toBe(true);
  });

  it("kind=actionable (with agentType) is feedable — no regression", () => {
    const task = store.create("fix typo", "Fix the typo.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("actionable");
    expect(isFeedableTask(task)).toBe(true);
  });

  it("kind=step (orchestrator) is feedable — no regression", () => {
    const task = store.create("step", "Implement.", undefined, {
      created_by: "orchestrator",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("step");
    expect(isFeedableTask(task)).toBe(true);
  });

  it("task with no kind and no agentType is NOT feedable (truly unmapped)", () => {
    // A caller that explicitly passes neither kind nor agentType has
    // no dispatcher. inferKind stamps kind=intent for created_by=user
    // when nothing is supplied, so the public API never produces a
    // "no kind + no agentType" task. This case is only reachable via
    // hand-edited files / a forced created_by="orchestrator" path.
    // We exercise the orchestrator path here: created_by=orchestrator
    // → kind=step (inferred), but no agentType → NOT feedable.
    const task = store.create("misc", "details", undefined, {
      created_by: "orchestrator",
      // no kind, no agentType
    });
    expect(task.metadata.kind).toBe("step");
    expect(isFeedableTask(task)).toBe(false);
  });

  it("kind=actionable with no agentType is NOT feedable (no dispatcher)", () => {
    const task = store.create("actionable without agent", "Details.", undefined, {
      created_by: "user",
      kind: "actionable",
    });
    expect(isFeedableTask(task)).toBe(false);
  });
});

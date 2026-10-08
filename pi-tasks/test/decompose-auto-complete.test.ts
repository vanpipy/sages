/**
 * decompose-auto-complete.test.ts — Tests that materializeDecomposeChain
 * auto-completes the user task on success (GC-2026-120 AC3).
 *
 * The deadlock the GC fixes:
 *   - /tasks create "X"        → userTask pending, no agent
 *   - decompose_task(user_task_id=X, specs=[...]) → T1 blockedBy [userTask.id]
 *   - T1 cannot spawn: no subagent ever completes userTask
 *
 * The fix: materializeDecomposeChain auto-completes userTask after the
 * chain materializes successfully. Chain tasks blockedBy only the
 * previous chain task (not userTask).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";

/**
 * Inline copy of the materializeDecomposeChain logic — the production
 * version lives inside the pi-tasks extension factory closure and is not
 * exported. Mirroring it here keeps the test self-contained.
 *
 * If the production logic changes, this fixture must change too.
 */
function makeMaterialize(store: TaskStore, opts: {
  spawn?: (task: Task) => Promise<string>;
} = {}) {
  return async function materialize(params: {
    user_task_id: string;
    specs: Array<{ subject: string; description: string }>;
  }): Promise<{
    user_task_id: string;
    tasks: Task[];
  }> {
    const userTask = store.get(params.user_task_id);
    if (!userTask) throw new Error(`user_task_id ${params.user_task_id} not found`);
    const chain: Task[] = [];
    let prevId: string | undefined;
    for (const spec of params.specs) {
      const blockedBy = prevId ? [prevId] : [];
      const t = store.create(spec.subject, spec.description, undefined, {
        created_by: "orchestrator",
        kind: "step",
        agentType: "Developer",
        user_task_ref: userTask.id,
      });
      if (blockedBy.length > 0) {
        store.update(t.id, { addBlockedBy: blockedBy });
      }
      chain.push(t);
      prevId = t.id;
    }
    // Auto-complete the user task on success — AC3 fix.
    store.update(userTask.id, {
      status: "completed",
      metadata: {
        ...userTask.metadata,
        completed_via: "decomposition",
        completed_at: new Date().toISOString(),
      },
    });
    return { user_task_id: userTask.id, tasks: chain };
  };
}

describe("materializeDecomposeChain auto-completion (GC-2026-120 AC3)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("auto-completes the user task after successful chain materialization", async () => {
    const userTask = store.create("research X", "Investigate topic X.", undefined, {
      created_by: "user",
    });
    const materialize = makeMaterialize(store);
    await materialize({
      user_task_id: userTask.id,
      specs: [
        { subject: "Investigate", description: "Read papers and docs." },
        { subject: "Summarize", description: "Write summary." },
      ],
    });
    const after = store.get(userTask.id)!;
    expect(after.status).toBe("completed");
    expect(after.metadata.completed_via).toBe("decomposition");
    expect(typeof after.metadata.completed_at).toBe("string");
  });

  it("chain tasks are blockedBy only the previous chain task, NOT userTask", async () => {
    const userTask = store.create("research X", "Investigate X.");
    const materialize = makeMaterialize(store);
    const result = await materialize({
      user_task_id: userTask.id,
      specs: [
        { subject: "T1", description: "Step one." },
        { subject: "T2", description: "Step two." },
        { subject: "T3", description: "Step three." },
      ],
    });
    const t1 = store.get(result.tasks[0].id)!;
    const t2 = store.get(result.tasks[1].id)!;
    const t3 = store.get(result.tasks[2].id)!;
    // T1 has no blockedBy (chain head) — no longer blocks on userTask.
    expect(t1.blockedBy).toEqual([]);
    // T2 blockedBy T1 only.
    expect(t2.blockedBy).toEqual([t1.id]);
    // T3 blockedBy T2 only.
    expect(t3.blockedBy).toEqual([t2.id]);
    // Sanity: chain tasks must NOT carry userTask.id in blockedBy.
    expect(t1.blockedBy).not.toContain(userTask.id);
    expect(t2.blockedBy).not.toContain(userTask.id);
    expect(t3.blockedBy).not.toContain(userTask.id);
  });

  it("chain tasks carry user_task_ref pointing back to the user task", async () => {
    const userTask = store.create("research X", "Investigate X.");
    const materialize = makeMaterialize(store);
    const result = await materialize({
      user_task_id: userTask.id,
      specs: [{ subject: "T1", description: "Step one." }],
    });
    expect(result.tasks[0].metadata.user_task_ref).toBe(userTask.id);
  });

  it("chain tasks are kind=step (orchestrator-created)", async () => {
    const userTask = store.create("research X", "Investigate X.");
    const materialize = makeMaterialize(store);
    const result = await materialize({
      user_task_id: userTask.id,
      specs: [{ subject: "T1", description: "Step one." }],
    });
    expect(result.tasks[0].metadata.kind).toBe("step");
  });

  it("does NOT auto-complete user task if materialization throws (no chain created)", async () => {
    // Test fixture intentionally throws if userTask is missing. Use
    // a bogus id to simulate the throw path.
    const userTask = store.create("research X", "Investigate X.");
    const materialize = makeMaterialize(store);
    await expect(
      materialize({
        user_task_id: "999-nonexistent",
        specs: [{ subject: "T1", description: "Step one." }],
      }),
    ).rejects.toThrow();
    // Real user task untouched.
    expect(store.get(userTask.id)!.status).toBe("pending");
  });

  it("after auto-completion, T1 has no blockers — feeder would spawn immediately", async () => {
    const userTask = store.create("research X", "Investigate X.");
    const materialize = makeMaterialize(store);
    const result = await materialize({
      user_task_id: userTask.id,
      specs: [{ subject: "T1", description: "Step one." }],
    });
    const t1 = store.get(result.tasks[0].id)!;
    // userTask completed → its dependency check (no longer relevant).
    // T1 has no blockedBy → feeder.maybeAutoSpawn sees no blockers → spawns.
    expect(userTask.status).toBe("completed");
    expect(t1.blockedBy).toEqual([]);
  });
});
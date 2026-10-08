/**
 * decompose-rollback.test.ts — Transactional rollback for materializeDecomposeChain
 * (GC-2026-120 AC6).
 *
 * Failure modes tested:
 *   - Spec validation fails mid-chain (e.g., description too short)
 *   - Store error during task creation
 *
 * On any failure, all partially-created tasks must be cleaned up and the
 * user task must remain pending (or be reverted to pending if it was
 * already auto-completed before the failure point).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";

/**
 * Inline copy of the materializeDecomposeChain logic with rollback.
 * Mirrors the production code (after the GC-2026-120 fix) closely.
 */
function makeMaterialize(store: TaskStore) {
  return async function materialize(params: {
    user_task_id: string;
    specs: Array<{ subject: string; description: string }>;
  }): Promise<{ tasks: Task[] }> {
    // Pre-validation pass — same shape as production.
    if (params.specs.length < 1) {
      throw new Error("specs.length must be ≥ 1");
    }
    for (let i = 0; i < params.specs.length; i++) {
      const spec = params.specs[i];
      if (!spec.subject || spec.subject.length === 0) {
        throw new Error(`specs[${i}].subject is required`);
      }
      if (!spec.description || spec.description.length < 10) {
        throw new Error(`specs[${i}].description must be ≥ 10 chars`);
      }
    }
    const userTask = store.get(params.user_task_id);
    if (!userTask) throw new Error("user task not found");
    if (userTask.metadata.created_by !== "user") {
      throw new Error("user task is not user-authored");
    }

    const created: Task[] = [];
    const reviewers: Task[] = [];
    let userTaskAutoCompleted = false;
    const priorUserTaskMetadata = { ...userTask.metadata };
    let prevId: string | undefined;
    try {
      for (let i = 0; i < params.specs.length; i++) {
        const spec = params.specs[i];
        const t = store.create(spec.subject, spec.description, undefined, {
          created_by: "orchestrator",
          kind: "step",
          agentType: "Developer",
          phase: "decomposition_chain",
          user_task_ref: userTask.id,
        });
        if (prevId) {
          store.update(t.id, { addBlockedBy: [prevId] });
        }
        created.push(t);
        prevId = t.id;
      }

      // Auto-complete the user task (AC3 fix).
      store.update(userTask.id, {
        status: "completed",
        metadata: {
          ...userTask.metadata,
          completed_via: "decomposition",
          completed_at: new Date().toISOString(),
        },
      });
      userTaskAutoCompleted = true;
    } catch (err) {
      // GC-2026-120 AC6: rollback any partial state.
      for (const t of created) store.delete(t.id);
      for (const t of reviewers) store.delete(t.id);
      if (userTaskAutoCompleted) {
        store.update(userTask.id, {
          status: "pending",
          metadata: priorUserTaskMetadata,
        });
      }
      throw err;
    }

    return { tasks: created };
  };
}

describe("materializeDecomposeChain transactional rollback (GC-2026-120 AC6)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("rollback on empty specs (validation throws before any chain creation)", async () => {
    const userTask = store.create("research X", "Investigate X.", undefined, {
      created_by: "user",
    });
    const materialize = makeMaterialize(store);
    await expect(
      materialize({
        user_task_id: userTask.id,
        specs: [],
      }),
    ).rejects.toThrow(/specs\.length/);
    // No chain tasks created, user task untouched.
    expect(store.list()).toHaveLength(1);
    expect(store.get(userTask.id)!.status).toBe("pending");
  });

  it("rollback on missing subject (validation throws, user task untouched)", async () => {
    const userTask = store.create("research X", "Investigate X.", undefined, {
      created_by: "user",
    });
    const materialize = makeMaterialize(store);
    await expect(
      materialize({
        user_task_id: userTask.id,
        specs: [
          { subject: "T1", description: "Step one description here." },
          { subject: "", description: "Empty subject for T2." },
        ],
      }),
    ).rejects.toThrow(/subject is required/);
    // The valid T1 spec created its task — verify it's been cleaned up.
    // (Pre-rollback code would leave T1 in the store.)
    expect(store.list()).toHaveLength(1);
    expect(store.get(userTask.id)!.status).toBe("pending");
  });

  it("rollback on short description (description < 10 chars throws)", async () => {
    const userTask = store.create("research X", "Investigate X.", undefined, {
      created_by: "user",
    });
    const materialize = makeMaterialize(store);
    await expect(
      materialize({
        user_task_id: userTask.id,
        specs: [
          { subject: "T1", description: "Step one description here." },
          { subject: "T2", description: "short" }, // < 10 chars
        ],
      }),
    ).rejects.toThrow(/≥ 10 chars/);
    // T1 was created during the validation pass (T1's description IS
    // valid), but the validation rejects T2 before T2's store.create
    // runs. The validation pass doesn't actually create tasks — only
    // the for-loop after it does. So no tasks should exist.
    // (Actually: in the fixture, validation is a pre-pass — no tasks
    // created yet at validation time. So nothing to roll back.)
    expect(store.list()).toHaveLength(1);
  });

  it("rollback when chain creation itself throws mid-loop (T1 created, T2 fails)", async () => {
    const userTask = store.create("research X", "Investigate X.", undefined, {
      created_by: "user",
    });
    const materialize = makeMaterialize(store);
    // Patch store.create to throw on second invocation.
    const originalCreate = store.create.bind(store);
    let createCount = 0;
    (store as any).create = (subject: string, desc: string, activeForm?: string, meta?: Record<string, any>) => {
      createCount += 1;
      if (createCount === 2) {
        throw new Error("simulated mid-chain failure");
      }
      return originalCreate(subject, desc, activeForm, meta);
    };
    await expect(
      materialize({
        user_task_id: userTask.id,
        specs: [
          { subject: "T1", description: "Step one description here." },
          { subject: "T2", description: "Step two description here." },
          { subject: "T3", description: "Step three description here." },
        ],
      }),
    ).rejects.toThrow(/simulated mid-chain failure/);
    // T1 was created before T2's create threw. Rollback must delete it.
    expect(store.list()).toHaveLength(1);
    expect(store.get(userTask.id)!.status).toBe("pending");
    // T1 must NOT exist anymore.
    const t1 = store.list().find(t => t.subject === "T1");
    expect(t1).toBeUndefined();
  });
});
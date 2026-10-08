/**
 * orchestrator-task.test.ts — Unit tests for the orchestrator task helpers.
 *
 * GC-2026-task-feeding-and-decomposition AC1: tests cover the universal
 * helper API (createOrchestratorTask, createOrchestratorTaskWithReview,
 * isTopLevelOrchestratorTask, traceUserTaskChain, createMergeTask).
 *
 * Uses an in-memory TaskStore (no file backing) so tests don't pollute
 * ~/.pi/tasks/.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import {
  createOrchestratorTask,
  createOrchestratorTaskWithReview,
  isTopLevelOrchestratorTask,
  traceUserTaskChain,
  createMergeTask,
} from "../src/orchestrator-task.js";
import { buildReviewerDescription } from "../src/reviewer-prompt.js";

describe("orchestrator-task helpers (GC-2026-task-feeding-and-decomposition)", () => {
  let store: TaskStore;

  beforeEach(() => {
    // In-memory store (no path arg)
    store = new TaskStore();
  });

  it("createOrchestratorTask stamps created_by='orchestrator' on the new task", () => {
    const task = createOrchestratorTask(store, {
      subject: "Implement X",
      description: "Build feature X.",
      agentType: "Developer",
    });
    expect(task.metadata.created_by).toBe("orchestrator");
    expect(task.subject).toBe("Implement X");
    expect(task.status).toBe("pending");
  });

  it("createOrchestratorTask wires blockedBy edges to real task ids", () => {
    const a = createOrchestratorTask(store, {
      subject: "A",
      description: "First.",
      agentType: "Developer",
    });
    const b = createOrchestratorTask(store, {
      subject: "B",
      description: "Second.",
      agentType: "Developer",
      blockedBy: [a.id],
    });
    expect(b.blockedBy).toEqual([a.id]);
  });

  it("createOrchestratorTaskWithReview attaches Reviewer iff top-level (empty blockedBy)", () => {
    const out = createOrchestratorTaskWithReview(
      store,
      {
        subject: "Top-level",
        description: "First in chain.",
        agentType: "Developer",
      },
      {
        kind: "decompose",
        parentSubject: "Top-level",
        parentDescription: "First in chain.",
        parentAgentType: "Developer",
        parentIteration: 1,
        chainSubjects: ["Top-level"],
        chainDescriptions: ["First in chain."],
        branch: "",
      },
    );
    expect(out.reviewer).toBeDefined();
    // decompose-context R1 carries phase="decomposition_chain" so the
    // cascade filter picks it up. workflow-context R1 (not exercised in
    // this test) would be "review".
    expect(out.reviewer?.metadata.phase).toBe("decomposition_chain");
    expect(out.reviewer?.metadata.agentType).toBe("Reviewer");
    expect(out.reviewer?.metadata.created_by).toBe("orchestrator");
    expect(out.reviewer?.blockedBy).toEqual([out.task.id]);
  });

  it("createOrchestratorTaskWithReview does NOT attach Reviewer when blockedBy an orchestrator predecessor", () => {
    const first = createOrchestratorTask(store, {
      subject: "T1",
      description: "Top-level.",
      agentType: "Developer",
    });
    const second = createOrchestratorTaskWithReview(
      store,
      {
        subject: "T2",
        description: "Downstream.",
        agentType: "Developer",
        blockedBy: [first.id],
      },
      {
        kind: "decompose",
        parentSubject: "T2",
        parentDescription: "Downstream.",
        parentAgentType: "Developer",
        parentIteration: 1,
        chainSubjects: ["T2"],
        chainDescriptions: ["Downstream."],
        branch: "",
      },
    );
    expect(second.reviewer).toBeUndefined();
  });

  it("isTopLevelOrchestratorTask: false when not created_by='orchestrator'", () => {
    const task = store.create("plain", "no helper");
    expect(isTopLevelOrchestratorTask(task, store)).toBe(false);
  });

  it("isTopLevelOrchestratorTask: true when orchestrator-created with no orchestrator predecessors", () => {
    const task = createOrchestratorTask(store, {
      subject: "Fresh",
      description: "x",
      agentType: "Developer",
    });
    expect(isTopLevelOrchestratorTask(task, store)).toBe(true);
  });

  it("traceUserTaskChain walks user_task_ref back to the user-created origin", () => {
    const userTask = store.create("user intent", "fix README", undefined, {
      created_by: "user",
    });
    const t1 = createOrchestratorTask(store, {
      subject: "T1",
      description: "Investigate.",
      agentType: "Developer",
      blockedBy: [userTask.id],
      metadata: { user_task_ref: userTask.id },
    });
    const t2 = createOrchestratorTask(store, {
      subject: "T2",
      description: "Apply fix.",
      agentType: "Developer",
      blockedBy: [t1.id],
      metadata: { user_task_ref: userTask.id },
    });
    const chain = traceUserTaskChain(store, t2.id);
    expect(chain.map((t) => t.id)).toEqual([userTask.id, t1.id, t2.id]);
  });

  it("createMergeTask stamps created_by='orchestrator' and agentType='MergerAdvisor', no Reviewer", () => {
    const merge = createMergeTask(store, {
      subject: "Merge: GC-X",
      description: "Advisory merge.",
    });
    expect(merge.metadata.created_by).toBe("orchestrator");
    expect(merge.metadata.agentType).toBe("MergerAdvisor");
    expect(merge.metadata.phase).toBe("merge");
  });

  it("buildReviewerDescription accepts discriminated union (workflow vs decompose) — round 2", () => {
    // Workflow mode produces a goal-context review prompt.
    const wf = buildReviewerDescription({
      kind: "workflow",
      goal: {
        id: "g1",
        title: "T",
        scope: { include: [], exclude: [] },
        anti_goals: [],
        done_definition: "D",
      },
      iteration: 1,
      worktreePath: "/tmp/wt",
      branch: "b",
    });
    expect(wf).toContain("Review phase");

    // Decompose mode produces a chain-context review prompt.
    const dc = buildReviewerDescription({
      kind: "decompose",
      parentSubject: "T1",
      parentDescription: "First in chain.",
      parentAgentType: "Developer",
      parentIteration: 1,
      chainSubjects: ["T1", "T2"],
      chainDescriptions: ["First.", "Second."],
      branch: "b",
    });
    expect(dc).toContain("Decompose-chain Review");
    expect(dc).toContain("T2");
  });
});
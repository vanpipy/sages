/**
 * main-agent-injector.test.ts — GC-2026-main-agent-proactive-intent-pump
 *
 * RED tests for IntentPump + MainAgentTransport + composeConsumptionPrompt.
 * The pump replaces GC-2026-122's soft system-prompt reminder with a
 * queued, observable mechanism that injects a "Consume intent #N" user
 * message into the main session.
 *
 * Locked decisions (do not re-open in code review):
 *   1. Queue, don't preempt — single-in-flight
 *   2. decompose_task stays in scope
 *   3. NO cascade — pump dequeues FIFO, never walks blockedBy
 *   4. MainAgentTransport interface — send(content), isBusy?()
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  composeConsumptionPrompt,
  IntentPump,
  type MainAgentTransport,
} from "../src/main-agent-injector.js";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

class FakeTransport implements MainAgentTransport {
  sent: string[] = [];
  failNext = false;
  busy = false;

  async send(content: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("transport boom");
    }
    this.sent.push(content);
  }

  isBusy(): boolean {
    return this.busy;
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "1",
    subject: "Investigate X",
    description: "Investigate topic X deeply.",
    status: "pending",
    activeForm: undefined,
    owner: undefined,
    metadata: { kind: "intent", requires_decomposition: true },
    blocks: [],
    blockedBy: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── composeConsumptionPrompt — pure function ──────────────────────────

describe("composeConsumptionPrompt", () => {
  it("includes the task id, subject, and description", () => {
    const task = makeTask({ id: "42", subject: "Do thing", description: "details here" });
    const text = composeConsumptionPrompt(task);
    expect(text).toContain("#42");
    expect(text).toContain("Do thing");
    expect(text).toContain("details here");
  });

  it("lists both consume paths (decompose_task and chat-answer)", () => {
    const text = composeConsumptionPrompt(makeTask({ id: "1" }));
    expect(text).toContain(`decompose_task(user_task_id="1"`);
    expect(text).toContain(`TaskUpdate(taskId="1", status="completed")`);
  });

  it("instructs the blocked_reason escape hatch", () => {
    const text = composeConsumptionPrompt(makeTask({ id: "7" }));
    expect(text).toContain("blocked_reason");
    expect(text).toContain(`taskId="7"`);
  });

  it("truncates descriptions longer than 200 characters", () => {
    const long = "x".repeat(500);
    const text = composeConsumptionPrompt(makeTask({ id: "1", description: long }));
    // ellipsis suffix, length capped near 200
    expect(text).toContain("...");
    // original 500-char string must NOT appear verbatim
    expect(text.includes("x".repeat(500))).toBe(false);
    // the truncated line itself should be ≤ 200 chars + ellipsis
    const descLine = text.split("\n").find((l) => l.startsWith("Description: ")) ?? "";
    expect(descLine.length).toBeLessThanOrEqual("Description: ".length + 200);
  });

  it("does not mutate the input task", () => {
    const task = makeTask({ id: "1", description: "x" });
    const before = JSON.stringify(task);
    composeConsumptionPrompt(task);
    expect(JSON.stringify(task)).toBe(before);
  });
});

// ── IntentPump — single-in-flight queue ───────────────────────────────

describe("IntentPump — single-in-flight", () => {
  let store: TaskStore;
  let transport: FakeTransport;
  let pump: IntentPump;

  beforeEach(() => {
    store = new TaskStore();
    transport = new FakeTransport();
    pump = new IntentPump(store, transport, { pollMs: 10 });
  });

  it("sends the consumption prompt to the transport on first enqueue", async () => {
    const task = store.create("first", "details");
    pump.enqueue(task);
    // send is async; wait a microtask
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0]).toContain("#1");
  });

  it("marks the in-flight task as in_progress with main-session owner", async () => {
    const task = store.create("first", "details");
    pump.enqueue(task);
    await new Promise((r) => setTimeout(r, 5));
    const fresh = store.get(task.id);
    expect(fresh?.status).toBe("in_progress");
    expect(fresh?.owner).toBe("main-session");
  });

  it("queues a second enqueue while the first is in-flight", async () => {
    const t1 = store.create("first", "details 1");
    const t2 = store.create("second", "details 2");
    pump.enqueue(t1);
    pump.enqueue(t2);
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0]).toContain("#1");
  });
});

// ── IntentPump — FIFO ordering ────────────────────────────────────────

describe("IntentPump — FIFO ordering", () => {
  let store: TaskStore;
  let transport: FakeTransport;
  let pump: IntentPump;

  beforeEach(() => {
    store = new TaskStore();
    transport = new FakeTransport();
    pump = new IntentPump(store, transport, { pollMs: 10 });
  });

  it("pumps in createdAt order across 3 enqueues", async () => {
    const t1 = store.create("alpha", "a");
    const t2 = store.create("beta", "b");
    const t3 = store.create("gamma", "c");
    pump.enqueue(t1);
    pump.enqueue(t2);
    pump.enqueue(t3);
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0]).toContain(`#${t1.id}`);

    // Simulate completion of t1 → pump advances to t2
    store.update(t1.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(transport.sent.length).toBe(2);
    expect(transport.sent[1]).toContain(`#${t2.id}`);

    // Simulate completion of t2 → pump advances to t3
    store.update(t2.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(transport.sent.length).toBe(3);
    expect(transport.sent[2]).toContain(`#${t3.id}`);
  });
});

// ── IntentPump — completion → dequeue next ────────────────────────────

describe("IntentPump — completion triggers dequeue", () => {
  it("dequeues next pending intent when in-flight completes", async () => {
    const store = new TaskStore();
    const transport = new FakeTransport();
    const pump = new IntentPump(store, transport, { pollMs: 10 });

    const t1 = store.create("a", "1");
    const t2 = store.create("b", "2");
    pump.enqueue(t1);
    pump.enqueue(t2);
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.sent.length).toBe(1);

    // Mark t1 complete via store (simulating LLM's TaskUpdate)
    store.update(t1.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(transport.sent.length).toBe(2);
    expect(transport.sent[1]).toContain(`#${t2.id}`);

    // Mark t2 complete; queue is now empty
    store.update(t2.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(transport.sent.length).toBe(2); // no more sends
    pump.dispose();
  });
});

// ── IntentPump — send failure rollback ────────────────────────────────

describe("IntentPump — transport.send failure", () => {
  it("reverts in-flight task to pending with lastError and does NOT advance", async () => {
    const store = new TaskStore();
    const transport = new FakeTransport();
    transport.failNext = true;
    const pump = new IntentPump(store, transport, { pollMs: 10 });

    const t1 = store.create("a", "1");
    const t2 = store.create("b", "2");
    pump.enqueue(t1);
    pump.enqueue(t2);
    await new Promise((r) => setTimeout(r, 10));

    const fresh = store.get(t1.id);
    expect(fresh?.status).toBe("pending");
    expect(fresh?.metadata?.lastError).toBe("transport boom");
    // t2 should NOT have been pumped yet — queue did not advance
    expect(transport.sent.length).toBe(0);
  });
});

// ── IntentPump — no-cascade invariant ─────────────────────────────────

describe("IntentPump — no-cascade invariant", () => {
  it("ignores blockedBy edges when picking the next intent", async () => {
    const store = new TaskStore();
    const transport = new FakeTransport();
    const pump = new IntentPump(store, transport, { pollMs: 10 });

    // t1 has NO blockers — it gets pumped first
    const t1 = store.create("first", "1");
    // t2 has a (synthetic) blocker pointing at t1 — but the pump must
    // still pick it as the next FIFO intent after t1 completes, ignoring
    // the edge entirely.
    const t2 = store.create("second", "2");
    store.update(t2.id, { addBlockedBy: [t1.id] });

    pump.enqueue(t1);
    pump.enqueue(t2);
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0]).toContain(`#${t1.id}`);

    store.update(t1.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));

    // Pump must advance to t2 even though t2.blockedBy includes the just-completed t1
    // — the no-cascade rule says the pump walks the store by id, not by edges.
    // (Equivalently: the pump's internal queue is what orders next, not blockedBy.)
    expect(transport.sent.length).toBe(2);
    expect(transport.sent[1]).toContain(`#${t2.id}`);
  });
});

// ── IntentPump — blocked_reason escape hatch ──────────────────────────

describe("IntentPump — blocked_reason escape hatch", () => {
  it("does not re-pump when LLM rolls task back to pending with blocked_reason", async () => {
    const store = new TaskStore();
    const transport = new FakeTransport();
    const pump = new IntentPump(store, transport, { pollMs: 10 });

    const t1 = store.create("need more info", "1");
    pump.enqueue(t1);
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.sent.length).toBe(1);

    // LLM signals it cannot decide yet — rolls back to pending with blocked_reason
    store.update(t1.id, {
      status: "pending",
      metadata: { blocked_reason: "missing input from user" },
    });
    await new Promise((r) => setTimeout(r, 50));
    // Pump must NOT re-send — the task is parked awaiting the next enqueue
    expect(transport.sent.length).toBe(1);
    pump.dispose();
  });
});

// ── IntentPump — owned-ids for reminder downgrade ─────────────────────

describe("IntentPump — owned-ids surface", () => {
  it("exposes isOwned(taskId) true for enqueued tasks", () => {
    const store = new TaskStore();
    const transport = new FakeTransport();
    const pump = new IntentPump(store, transport);
    const t1 = store.create("a", "1");
    expect(pump.isOwned(t1.id)).toBe(false);
    pump.enqueue(t1);
    expect(pump.isOwned(t1.id)).toBe(true);
  });
});

// ── isFeedableTask — kind=intent now feedable ─────────────────────────

describe("isFeedableTask — kind=intent is now feedable (GC-2026-main-agent-proactive-intent-pump)", () => {
  // Re-import the predicate from task-feeder (not main-agent-injector) to
  // assert the new contract end-to-end.
  it("returns true for kind=intent (default user task, no agentType)", async () => {
    const { isFeedableTask } = await import("../src/task-feeder.js");
    const task = makeTask({ id: "1", metadata: { kind: "intent" } });
    expect(isFeedableTask(task)).toBe(true);
  });

  it("still returns true for kind=actionable with explicit agentType (no regression)", async () => {
    const { isFeedableTask } = await import("../src/task-feeder.js");
    const task = makeTask({
      id: "1",
      metadata: { kind: "actionable", agentType: "Developer" },
    });
    expect(isFeedableTask(task)).toBe(true);
  });

  it("still returns true for kind=step (orchestrator, no regression)", async () => {
    const { isFeedableTask } = await import("../src/task-feeder.js");
    const task = makeTask({
      id: "1",
      metadata: { kind: "step", agentType: "Developer", created_by: "orchestrator" },
    });
    expect(isFeedableTask(task)).toBe(true);
  });
});

/**
 * intent-pump-integration.test.ts — GC-2026-main-agent-proactive-intent-pump
 *
 * End-to-end integration test wiring the actual production surface:
 *   TaskStore.create → feeder.maybeAutoSpawn → wrappedSpawn router →
 *   IntentPump.enqueue → MainAgentTransport.send.
 *
 * Verifies the spawn router inside `registerTaskFeeder` dispatches
 * `kind=intent` to the pump (NOT a subagent) and that agentType-bearing
 * tasks still go through the regular subagent spawn callback.
 *
 * Verifies the intent-reminder downgrade skips pump-owned tasks but
 * still surfaces orphaned intents.
 */

import { describe, expect, it } from "bun:test";
import { composeIntentReminder } from "../src/intent-reminder.js";
import { IntentPump, type MainAgentTransport } from "../src/main-agent-injector.js";
import { registerTaskFeeder, type TaskFeederHandle } from "../src/task-feeder.js";
import { TaskStore } from "../src/task-store.js";

// ── Test fixtures ─────────────────────────────────────────────────────

class FakeTransport implements MainAgentTransport {
  sent: string[] = [];
  failNext = false;
  async send(content: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("transport boom");
    }
    this.sent.push(content);
  }
}

interface Wiring {
  store: TaskStore;
  transport: FakeTransport;
  pump: IntentPump;
  feeder: TaskFeederHandle;
  subagentSpawned: Array<{ id: string; taskId: string; type: string }>;
  events: { on: (ch: string, h: (raw: unknown) => void | Promise<void>) => () => void };
  emitEvent: (ch: string, raw: unknown) => void;
  agentTaskMap: Map<string, string>;
}

function wireWiring(): Wiring {
  const store = new TaskStore();
  const transport = new FakeTransport();
  const pump = new IntentPump(store, transport, { pollMs: 10 });
  const subagentSpawned: Array<{ id: string; taskId: string; type: string }> = [];
  let idCounter = 0;
  const agentTaskMap = new Map<string, string>();
  const eventHandlers = new Map<string, ((raw: unknown) => void)[]>();
  const events = {
    on: (ch: string, h: (raw: unknown) => void | Promise<void>) => {
      if (!eventHandlers.has(ch)) eventHandlers.set(ch, []);
      eventHandlers.get(ch)!.push(h as (raw: unknown) => void);
      return () => {};
    },
  };
  const emitEvent = (ch: string, raw: unknown) => {
    for (const h of [...(eventHandlers.get(ch) ?? [])]) void h(raw);
  };
  const spawn = async (task: { id: string; metadata?: { agentType?: string } }) => {
    const id = `agent-${++idCounter}`;
    subagentSpawned.push({ id, taskId: task.id, type: task.metadata?.agentType ?? "?" });
    return id;
  };
  const feeder = registerTaskFeeder({
    store,
    events,
    spawn,
    agentTaskMap,
    intentPump: pump,
  });
  return { store, transport, pump, feeder, subagentSpawned, events, emitEvent, agentTaskMap };
}

// ── Integration: kind=intent → IntentPump, NOT subagent ───────────────

describe("integration: feeder routes kind=intent to IntentPump", () => {
  it("sends the consumption prompt through FakeTransport, never spawns a subagent", async () => {
    const w = wireWiring();
    const task = w.store.create("research X", "Investigate X deeply.");
    await w.feeder.maybeAutoSpawn(task);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.transport.sent.length).toBe(1);
    expect(w.transport.sent[0]).toContain(`#${task.id}`);
    expect(w.transport.sent[0]).toContain("research X");
    // No subagent should have been spawned
    expect(w.subagentSpawned.length).toBe(0);
    w.pump.dispose();
  });

  it("does NOT touch the agentType path for kind=intent", async () => {
    const w = wireWiring();
    const task = w.store.create("research Y", "Investigate Y.");
    await w.feeder.maybeAutoSpawn(task);
    await new Promise((r) => setTimeout(r, 5));
    // agentTaskMap gets a synthetic entry for widget uniformity
    const syntheticEntry = [...w.agentTaskMap.entries()].find(([k]) => k.startsWith("intent-pump:"));
    expect(syntheticEntry).toBeDefined();
    expect(syntheticEntry![1]).toBe(task.id);
    w.pump.dispose();
  });
});

// ── Integration: agentType-bearing tasks still go through subagent ────

describe("integration: feeder routes kind=actionable to subagent spawn", () => {
  it("spawns a subagent for an actionable task with explicit agentType", async () => {
    const w = wireWiring();
    const task = w.store.create("fix typo", "fix the typo", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    await w.feeder.maybeAutoSpawn(task);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.subagentSpawned.length).toBe(1);
    expect(w.subagentSpawned[0].type).toBe("Developer");
    // No pump send for the actionable task
    expect(w.transport.sent.length).toBe(0);
  });
});

// ── Integration: cascade still works for non-intent ───────────────────

describe("integration: feeder cascade does NOT fire for kind=intent", () => {
  it("intent tasks are not advanced via cascadeSpawn even when blockedBy is populated", async () => {
    const w = wireWiring();
    // Two intent tasks with synthetic blockedBy edges
    const t1 = w.store.create("first", "1");
    const t2 = w.store.create("second", "2");
    w.store.update(t2.id, { addBlockedBy: [t1.id] });

    await w.feeder.maybeAutoSpawn(t1);
    await w.feeder.maybeAutoSpawn(t2);
    await new Promise((r) => setTimeout(r, 5));
    // Only t1 is in-flight on the pump; t2 is queued (FIFO).
    expect(w.transport.sent.length).toBe(1);
    expect(w.transport.sent[0]).toContain(`#${t1.id}`);

    // Simulate t1 completion via the LLM's TaskUpdate
    w.store.update(t1.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    // Pump advances to t2 (FIFO queue), NOT via cascade
    expect(w.transport.sent.length).toBe(2);
    expect(w.transport.sent[1]).toContain(`#${t2.id}`);

    // Verify cascade did not ALSO spawn anything via the subagent path
    // — t1 had no subagent, t2 was in the pump queue (NOT the cascade)
    expect(w.subagentSpawned.length).toBe(0);
    w.pump.dispose();
  });
});

// ── Integration: intent-reminder downgrade ────────────────────────────

describe("integration: intent-reminder skips pump-owned tasks", () => {
  it("does NOT include a pump-owned intent in the fallback reminder", async () => {
    const w = wireWiring();
    const task = w.store.create("research Z", "Investigate Z.");
    await w.feeder.maybeAutoSpawn(task);
    await new Promise((r) => setTimeout(r, 5));

    // Without isOwned: the intent is in the store but ALSO in the pump.
    // The reminder (with the pump's isOwned filter) should skip it.
    const reminder = composeIntentReminder(w.store, (id) => w.pump.isOwned(id));
    if (reminder !== null) {
      expect(reminder).not.toContain(`#${task.id}`);
    }
    // (reminder may be null because no orphaned intents remain)
    w.pump.dispose();
  });

  it("DOES include an orphan intent (not yet seen by the pump) in the reminder", () => {
    const store = new TaskStore();
    const orphan = store.create("orphan", "never reached the pump");
    // No pump is wired — this is the GC-2026-122 fallback path
    const reminder = composeIntentReminder(store);
    expect(reminder).not.toBeNull();
    expect(reminder).toContain(`#${orphan.id}`);
  });
});

// ── Integration: full lifecycle ───────────────────────────────────────

describe("integration: full lifecycle TaskStore.create → consume → complete", () => {
  it("LLM completing via TaskUpdate(id, completed) drives the pump to advance", async () => {
    const w = wireWiring();
    const t1 = w.store.create("a", "1");
    const t2 = w.store.create("b", "2");
    await w.feeder.maybeAutoSpawn(t1);
    await w.feeder.maybeAutoSpawn(t2);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.transport.sent.length).toBe(1);

    // LLM consumes t1 (chat-answer + TaskUpdate completed)
    w.store.update(t1.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    // Pump advances to t2
    expect(w.transport.sent.length).toBe(2);
    expect(w.transport.sent[1]).toContain(`#${t2.id}`);

    // LLM consumes t2 via decompose_task (we simulate by marking completed)
    w.store.update(t2.id, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.transport.sent.length).toBe(2);
    w.pump.dispose();
  });
});

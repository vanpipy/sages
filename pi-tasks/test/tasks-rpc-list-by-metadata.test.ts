/**
 * tasks-rpc-list-by-metadata.test.ts — RPC endpoint for cross-extension
 * task queries (GC-2026-phase-widget).
 *
 * Background: pi-orchestrator's phase widget needs to read workflow tasks
 * out of pi-tasks's TaskStore without a parallel data model. The widget
 * sits in a different extension; the standard query path is the
 * `pi-tasks:rpc:list-by-metadata` event channel:
 *
 *   caller → emit("tasks:rpc:list-by-metadata", { requestId, key, value })
 *   callee → filter store.list() by `t.metadata[key] === value`
 *   callee → emit("tasks:rpc:list-by-metadata:reply:<requestId>", { success, data })
 *
 * The requestId envelope matches pi-subagents's existing RPC pattern
 * (`subagents:rpc:spawn` etc.) — see pi-tasks/src/index.ts:108 for the
 * caller-side helper.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { installSubagentsMock, mockPi } from "./helpers/mock-pi.js";

// In-memory store across the suite — RPC + store reads are deterministic.
beforeEach(() => {
  process.env.PI_TASKS = "off";
});
afterEach(() => {
  delete process.env.PI_TASKS;
});

interface RpcCall {
  (channel: string, payload: Record<string, unknown>): Promise<unknown>;
}

function installRpc(mock: ReturnType<typeof mockPi>): {
  call: RpcCall;
  seen: Array<{ channel: string; payload: Record<string, unknown> }>;
} {
  const seen: Array<{ channel: string; payload: Record<string, unknown> }> = [];

  const call: RpcCall = (channel, payload) =>
    new Promise((resolve, reject) => {
      seen.push({ channel, payload });
      const { requestId } = payload as { requestId: string };
      const replyChannel = `${channel}:reply:${requestId}`;
      const unsub = mock.pi.events.on(replyChannel, (raw: unknown) => {
        unsub();
        const reply = raw as { success: boolean; data?: unknown; error?: string };
        if (reply.success) resolve(reply.data);
        else reject(new Error(reply.error ?? "rpc failed"));
      });
      mock.pi.events.emit(channel, payload);
    });

  return { call, seen };
}

describe("tasks:rpc:list-by-metadata (GC-2026-phase-widget)", () => {
  it("returns tasks whose metadata[key] === value", async () => {
    const mock = mockPi();
    installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "test" }, {
      cwd: "/tmp",
      ui: { setWidget: () => {}, setStatus: () => {} } as any,
      sessionManager: { getSessionFile: () => null, getSessionId: () => "s1" },
    });

    // Seed tasks via the running store. The mock store isn't directly
    // accessible, so we go through the public lifecycle: create + update.
    // Easiest: query the underlying store via the existing rpc envelope
    // by simulating what a worker would do.
    //
    // Simpler: emit a synthetic tasks:rpc:create helper? No — we don't
    // have one. Instead, drive the same store through the public mockPi
    // tool surface.
    //
    // Cleanest approach for this test: write to the same file path the
    // store loads from. PI_TASKS=off means in-memory store, so we need
    // another path. Use the env override.
    //
    // The simplest reliable approach: use PI_TASKS=file + write the file
    // before initExtension. This bypasses the runtime store but exercises
    // the RPC handler on a known seed.
    const tmpFile = `/tmp/pi-tasks-rpc-test-${process.pid}-${Date.now()}.json`;
    process.env.PI_TASKS = tmpFile;
    const store = new TaskStore(tmpFile);
    const t1 = store.create("Implement: foo", "Implement description");
    store.update(t1.id, {
      metadata: { ...t1.metadata, workflow_run_goal_id: "GC-test-1", phase: "implement" },
    });
    const t2 = store.create("Review 1: foo", "Review description");
    store.update(t2.id, {
      metadata: { ...t2.metadata, workflow_run_goal_id: "GC-test-1", phase: "review", iteration: 1 },
    });
    const t3 = store.create("Implement: bar", "Other workflow");
    store.update(t3.id, {
      metadata: { ...t3.metadata, workflow_run_goal_id: "GC-test-2", phase: "implement" },
    });
    // Re-init extension to pick up the seeded file.
    const mock2 = mockPi();
    installSubagentsMock(mock2.pi);
    initExtension(mock2.pi as any);
    await mock2.fireLifecycle("session_start", { reason: "test" }, {
      cwd: "/tmp",
      ui: { setWidget: () => {}, setStatus: () => {} } as any,
      sessionManager: { getSessionFile: () => null, getSessionId: () => "s2" },
    });

    const { call } = installRpc(mock2);
    const tasks = (await call("tasks:rpc:list-by-metadata", {
      requestId: "r1",
      key: "workflow_run_goal_id",
      value: "GC-test-1",
    })) as Array<{ id: string; subject: string }>;

    expect(tasks).toHaveLength(2);
    const subjects = tasks.map((t) => t.subject).sort();
    expect(subjects).toEqual(["Implement: foo", "Review 1: foo"]);
  });

  it("returns empty array when no tasks match", async () => {
    const tmpFile = `/tmp/pi-tasks-rpc-empty-${process.pid}-${Date.now()}.json`;
    process.env.PI_TASKS = tmpFile;
    const store = new TaskStore(tmpFile);
    const t = store.create("Implement: foo", "desc");
    store.update(t.id, {
      metadata: { ...t.metadata, workflow_run_goal_id: "GC-x" },
    });

    const mock = mockPi();
    installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "test" }, {
      cwd: "/tmp",
      ui: { setWidget: () => {}, setStatus: () => {} } as any,
      sessionManager: { getSessionFile: () => null, getSessionId: () => "s3" },
    });

    const { call } = installRpc(mock);
    const tasks = (await call("tasks:rpc:list-by-metadata", {
      requestId: "r2",
      key: "workflow_run_goal_id",
      value: "GC-does-not-exist",
    })) as unknown[];

    expect(tasks).toEqual([]);
  });

  it("filters by phase metadata for the same goal", async () => {
    const tmpFile = `/tmp/pi-tasks-rpc-phase-${process.pid}-${Date.now()}.json`;
    process.env.PI_TASKS = tmpFile;
    const store = new TaskStore(tmpFile);
    for (const phase of ["implement", "review", "fix", "merge"]) {
      const t = store.create(`${phase}: task`, "desc");
      store.update(t.id, {
        metadata: { ...t.metadata, workflow_run_goal_id: "GC-1", phase },
      });
    }

    const mock = mockPi();
    installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "test" }, {
      cwd: "/tmp",
      ui: { setWidget: () => {}, setStatus: () => {} } as any,
      sessionManager: { getSessionFile: () => null, getSessionId: () => "s4" },
    });

    const { call } = installRpc(mock);
    const review = (await call("tasks:rpc:list-by-metadata", {
      requestId: "r3",
      key: "phase",
      value: "review",
    })) as Array<{ subject: string }>;
    expect(review).toHaveLength(1);
    expect(review[0].subject).toBe("review: task");
  });

  it("returns success envelope shape (matches the cross-extension RPC pattern)", async () => {
    const tmpFile = `/tmp/pi-tasks-rpc-envelope-${process.pid}-${Date.now()}.json`;
    process.env.PI_TASKS = tmpFile;
    const store = new TaskStore(tmpFile);
    const t = store.create("x", "x");
    store.update(t.id, { metadata: { ...t.metadata, goal_id: "GC-x" } });

    const mock = mockPi();
    installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "test" }, {
      cwd: "/tmp",
      ui: { setWidget: () => {}, setStatus: () => {} } as any,
      sessionManager: { getSessionFile: () => null, getSessionId: () => "s5" },
    });

    // Capture the reply directly so we can assert envelope shape.
    let captured: unknown = null;
    const capturePromise = new Promise<void>((resolve) => {
      mock.pi.events.on("tasks:rpc:list-by-metadata:reply:envelope-test", (raw: unknown) => {
        captured = raw;
        resolve();
      });
    });
    mock.pi.events.emit("tasks:rpc:list-by-metadata", {
      requestId: "envelope-test",
      key: "goal_id",
      value: "GC-x",
    });
    await capturePromise;

    expect(captured).toMatchObject({ success: true, data: expect.any(Array) });
  });
});

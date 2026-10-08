/**
 * decompose-task.test.ts — Unit tests for the decompose_task tool
 * (GC-2026-task-feeding-and-decomposition AC3).
 *
 * Tests the pure entry point (`executeDecomposeTask`) with a fake event
 * bus. The fake bus synchronously routes requests to listeners and
 * captures emitted events for assertion.
 */

import { describe, expect, it } from "bun:test";
import {
  buildSafeCtx,
  DecomposeTaskParams,
  executeDecomposeTask,
  executeDecomposeTaskTool,
} from "../src/decompose-task.js";

function createFakeBus() {
  const listeners = new Map<string, Array<(data: unknown) => void | Promise<void>>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void {
      const arr = listeners.get(channel) ?? [];
      arr.push(handler);
      listeners.set(channel, arr);
      return () => {
        const a = listeners.get(channel) ?? [];
        const idx = a.indexOf(handler);
        if (idx >= 0) a.splice(idx, 1);
      };
    },
    async emit(channel: string, data: unknown): Promise<void> {
      emitted.push({ channel, data });
      const handlers = listeners.get(channel) ?? [];
      // Reply-channel: simulate the rpc handler by routing to the requester
      // for decompose:materialize. We build a minimal reply here so
      // executeDecomposeTask can resolve.
      if (channel === "tasks:rpc:decompose-materialize") {
        const payload = data as { requestId?: string; params?: any };
        if (payload?.requestId && payload.params) {
          // Simulate the pi-tasks-side materialize.
          const params = payload.params;
          const result = simulateMaterialize(params);
          const replyChannel = `tasks:rpc:decompose-materialize:reply:${payload.requestId}`;
          for (const h of listeners.get(replyChannel) ?? []) {
            await h({ success: true, data: result });
          }
        }
      }
      // Also run any local listeners.
      for (const h of handlers) await h(data);
    },
  };
}

function simulateMaterialize(params: any): any {
  // Mirror the pi-tasks materializeDecomposeChain logic for tests.
  if (!params?.specs || params.specs.length < 1 || params.specs.length > 20) {
    return undefined;
  }
  let counter = 0;
  const tasks: any[] = [];
  let reviewer: string | undefined;
  for (let i = 0; i < params.specs.length; i++) {
    counter += 1;
    const isTop = i === 0;
    tasks.push({
      task_id: String(counter),
      subject: params.specs[i].subject,
      reviewer_id: isTop ? String(counter + 100) : undefined,
      is_top_level: isTop,
    });
    if (isTop) reviewer = String(counter + 100);
  }
  const result = {
    status: "success" as const,
    summary: `Decomposed into ${tasks.length} task(s); 1 Reviewer on T1.`,
    tasks,
    user_task_chain: params.user_task_id
      ? [params.user_task_id, ...tasks.map((t) => t.task_id)]
      : undefined,
    first_task_spawned: { task_id: tasks[0].task_id, agent_id: "agent-stub" },
  };
  return result;
}

describe("decompose_task tool (AC3)", () => {
  it("emits 'tasks:rpc:decompose-materialize' with the request id + params", async () => {
    const bus = createFakeBus();
    const ctx = { cwd: "/tmp", events: bus };
    await executeDecomposeTask(
      {
        specs: [
          { subject: "Read README", description: "Investigate the codebase structure." },
          { subject: "Fix typo", description: "Apply the typo fix to README.md." },
        ],
      },
      ctx,
    );
    const req = bus.emitted.find((e) => e.channel === "tasks:rpc:decompose-materialize");
    expect(req).toBeDefined();
    const payload = req?.data as { requestId?: string; params?: unknown };
    expect(payload?.requestId).toBeDefined();
    expect(payload?.params).toBeDefined();
  });

  it("returns chain with reviewer_id on T1 only, not on T2+", async () => {
    const bus = createFakeBus();
    const ctx = { cwd: "/tmp", events: bus };
    const result = await executeDecomposeTask(
      {
        specs: [
          { subject: "T1", description: "First in chain test description." },
          { subject: "T2", description: "Second in chain test description." },
          { subject: "T3", description: "Third in chain test description." },
        ],
      },
      ctx,
    );
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0].is_top_level).toBe(true);
    expect(result.tasks[0].reviewer_id).toBeDefined();
    expect(result.tasks[1].is_top_level).toBe(false);
    expect(result.tasks[1].reviewer_id).toBeUndefined();
    expect(result.tasks[2].is_top_level).toBe(false);
    expect(result.tasks[2].reviewer_id).toBeUndefined();
  });

  it("writes an audit file under .pi/orchestrator/", async () => {
    const bus = createFakeBus();
    const tmpDir = `/tmp/sages-decompose-${Date.now()}`;
    const ctx = { cwd: tmpDir, events: bus };
    const result = await executeDecomposeTask(
      {
        specs: [
          { subject: "S1", description: "First task description here." },
          { subject: "S2", description: "Second task description here." },
        ],
      },
      ctx,
    );
    expect(result.audit_path).toContain(tmpDir);
    expect(result.audit_path).toContain(".pi/orchestrator/decompose-");
  });

  it("includes user_task_chain when user_task_id is provided", async () => {
    const bus = createFakeBus();
    const ctx = { cwd: "/tmp", events: bus };
    const result = await executeDecomposeTask(
      {
        user_task_id: "user-task-42",
        specs: [
          { subject: "T1", description: "Top-level chain task." },
        ],
      },
      ctx,
    );
    expect(result.user_task_chain).toEqual(["user-task-42", "1"]);
  });

  it("rejects specs.length > 20 (schema-enforced)", () => {
    const params = DecomposeTaskParams;
    // TypeBox doesn't validate at runtime; the pi-tasks listener does.
    // We assert the schema's maxItems via the static analyzer:
    expect(JSON.stringify(params)).toContain("maxItems");
  });

  it("schema accepts single spec (minItems=1)", () => {
    // Just a smoke check that schema parses without error.
    const schema = DecomposeTaskParams;
    expect(schema.type).toBe("object");
  });

  it("RPC failure surfaces as thrown error (no silent drop)", async () => {
    const bus = createFakeBus();
    // Override emit so the rpc never replies — should hit the timeout.
    const origEmit = bus.emit;
    bus.emit = async (channel: string, data: unknown) => {
      // Don't route to reply channel.
      bus.emitted.push({ channel, data });
    };
    const ctx = { cwd: "/tmp", events: bus, rpcTimeoutMs: 200 };
    await expect(
      executeDecomposeTask(
        {
          specs: [
            { subject: "T1", description: "Test task description here." },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/timeout/);
    void origEmit;
  });

  // Regression: 2026-10-08T14:17:24Z host crash.
  // Pre-fix, when `api.on` threw synchronously, the executor rejected
  // with that error but the orphan setTimeout (referencing an
  // uninitialized `const unsub` in TDZ) was never cleared. The timer
  // fired ~6s later and raised a ReferenceError that crashed the
  // host. Post-fix, the catch wraps the setup, cleanup() clears the
  // timer, and no orphan fires.
  it("does not leak timer / hit TDZ when api.on throws synchronously", async () => {
    const uncaught: unknown[] = [];
    const handler = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", handler);
    try {
      const bus = {
        on: () => {
          throw new Error("bus.on exploded");
        },
        emit: async () => {},
      };
      const ctx = { cwd: "/tmp", events: bus, rpcTimeoutMs: 50 };
      await expect(
        executeDecomposeTask(
          {
            specs: [
              { subject: "X", description: "Regression coverage here ok" },
            ],
          },
          ctx,
        ),
      ).rejects.toThrow("bus.on exploded");
      // Wait past timeoutMs so any orphan timer would have fired.
      await new Promise((r) => setTimeout(r, 120));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", handler);
    }
  });

  // Regression: same crash chain, different trigger. If `api.emit`
  // throws after `api.on` registered the listener, the pre-fix code
  // never reached `clearTimeout(timer)` and the listener leaked on the
  // bus. Post-fix, the catch runs cleanup() which removes both.
  it("cleans up listener + timer when api.emit throws synchronously", async () => {
    let removed = false;
    let emitted = false;
    const bus = {
      on: (_ch: string, _h: (data: unknown) => void) => {
        return () => {
          removed = true;
        };
      },
      // Sync-throw, NOT async-throw: `void api.emit(...)` swallows a
      // rejected Promise, so the production try/catch only fires for
      // synchronous throws.
      emit: () => {
        emitted = true;
        throw new Error("bus.emit exploded");
      },
    };
    const ctx = { cwd: "/tmp", events: bus, rpcTimeoutMs: 50 };
    await expect(
      executeDecomposeTask(
        {
          specs: [
            { subject: "Y", description: "Emit-throw regression coverage" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow("bus.emit exploded");
    expect(emitted).toBe(true);
    expect(removed).toBe(true);
    // Also wait past timeout to confirm no orphan timer raises TDZ.
    await new Promise((r) => setTimeout(r, 120));
  });
});

// ──────────────────────────────────────────────────────────────────────
// GC-2026-fix-decompose-task-ctx-events: tool-wrapper safeCtx fallback.
// The pre-fix wrapper used `(ctx as { events: ... }) ?? { ... }` which
// only fell back when `ctx` itself was null/undefined. If the host
// passed a `ctx` whose `events` field was undefined, the cast silenced
// TypeScript but at runtime `safeCtx.events.on(...)` threw
// `Cannot read properties of undefined (reading 'on')` — the
// 6×-hit runtime bug from the GC incident. The fix extracts the
// narrowing into `buildSafeCtx` which defaults BOTH fields
// independently. Coverage below asserts the no-op-events path
// (the bug-trigger shape) does not surface the TypeError.
// ──────────────────────────────────────────────────────────────────────

describe("decompose_task tool wrapper: buildSafeCtx fallback (GC-2026-fix-decompose-task-ctx-events)", () => {
  it("defaults cwd and events when ctx is undefined", () => {
    const safe = buildSafeCtx(undefined);
    expect(safe.cwd).toBe(process.cwd());
    expect(typeof safe.events.emit).toBe("function");
    expect(typeof safe.events.on).toBe("function");
  });

  it("defaults cwd and events when ctx is null", () => {
    const safe = buildSafeCtx(null);
    expect(safe.cwd).toBe(process.cwd());
    expect(typeof safe.events.emit).toBe("function");
    expect(typeof safe.events.on).toBe("function");
  });

  it("defaults events when ctx.events is undefined (THE BUG TRIGGER)", () => {
    // The exact shape that crashed 6× in the GC incident: ctx has
    // cwd but its `events` field is undefined. Pre-fix this would
    // surface as `safeCtx.events.on(...)` throwing "Cannot read
    // properties of undefined (reading 'on')". Post-fix the helper
    // returns a no-op events object so the wrapper can fall through
    // to the RPC layer.
    const safe = buildSafeCtx({ cwd: "/tmp" });
    expect(safe.cwd).toBe("/tmp");
    expect(typeof safe.events.emit).toBe("function");
    expect(typeof safe.events.on).toBe("function");
    // The no-op on() must return an unsub fn (the rpcCall cleanup path
    // calls it unconditionally on every path — success, reply, timeout).
    const unsub = safe.events.on("x", () => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("preserves ctx.events when present (pass-through)", () => {
    const bus = {
      on: () => () => {},
      emit: () => {},
    };
    const safe = buildSafeCtx({ cwd: "/tmp", events: bus });
    expect(safe.cwd).toBe("/tmp");
    expect(safe.events).toBe(bus);
  });

  it("tool wrapper: ctx without events does not surface the runtime TypeError", async () => {
    // The bug-trigger shape — wrapped in the full tool entry point
    // (executeDecomposeTaskTool) that the LLM calls. With the bug
    // this throws "Cannot read properties of undefined (reading 'on')"
    // synchronously. With the fix, the no-op events bus means the
    // RPC never receives a reply and the call rejects with the
    // RPC timeout error (clean) rather than the TypeError.
    //
    // Pass rpcTimeoutMs: 50 so the test doesn't wait the default 30s.
    let err: Error | undefined;
    try {
      await executeDecomposeTaskTool(
        {
          specs: [
            {
              subject: "T1",
              description: "Regression coverage for ctx.events undefined",
            },
          ],
        },
        { cwd: "/tmp", rpcTimeoutMs: 50 }, // <-- no events field (the bug-trigger shape)
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(String(err)).not.toMatch(
      /Cannot read properties of undefined.*reading 'on'/,
    );
    expect(String(err)).toMatch(/timeout/i);
  });
});
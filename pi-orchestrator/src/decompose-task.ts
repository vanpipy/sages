/**
 * decompose-task.ts — LLM-facing tool that materializes a user intent as a
 * linear chain of orchestrator-tracked tasks.
 *
 * GC-2026-task-feeding-and-decomposition (AC3, D5, R3): the chain has one
 * Reviewer sibling attached to T1 (top-level per R3). Subsequent T_i are
 * blockedBy the previous spec, so they're not top-level and get no
 * Reviewer sibling. No recursion, no folded sub-tasks.
 *
 * Implementation: RPC over the event bus. This module (pi-orchestrator)
 * emits a request; pi-tasks's extension factory registers a listener that
 * materializes the chain in the store and replies with chain metadata.
 * Channel constants are duplicated across packages (string literals) — no
 * direct import coupling. Matches the existing
 * `tasks:rpc:list-by-metadata` pattern.
 */

import { Type, type Static } from "typebox";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

import { TASKS_RPC_DECOMPOSE_MATERIALIZE } from "@sages/pi-tasks/event-channels";

const DECOMPOSE_REQUEST_CHANNEL = TASKS_RPC_DECOMPOSE_MATERIALIZE;
const DECOMPOSE_REPLY_PREFIX = `${TASKS_RPC_DECOMPOSE_MATERIALIZE}:reply:`;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

// ── LLM-facing schema (AC3: narrow specs, no agentType/blockedBy/metadata) ──

export const DecomposeTaskParams = Type.Object({
  user_task_id: Type.Optional(
    Type.String({
      description:
        "Reference to the user-created task being decomposed. Stamps user_task_ref on every spec.",
    }),
  ),
  specs: Type.Array(
    Type.Object({
      subject: Type.String({ maxLength: 120 }),
      description: Type.String({ minLength: 10 }),
      activeForm: Type.Optional(Type.String()),
    }),
    { minItems: 1, maxItems: 20 },
  ),
});

export type DecomposeTaskInput = Static<typeof DecomposeTaskParams>;

// ── Result shape (mirrors the pi-tasks listener's reply) ───────────────

export interface DecomposeTaskResult {
  status: "success";
  summary: string;
  tasks: Array<{
    task_id: string;
    subject: string;
    reviewer_id: string | undefined;
    is_top_level: boolean;
  }>;
  user_task_chain?: string[];
  first_task_spawned?: { task_id: string; agent_id: string };
  audit_path: string;
}

// ── RPC helpers ────────────────────────────────────────────────────────

interface RpcEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * GC-2026-decompose-task-retry: thrown when an RPC exceeds its
 * per-attempt timeout. Distinct from generic `Error` so the retry
 * loop in `executeDecomposeTask` can tell timeout (retryable) apart
 * from listener-side errors (not retryable — they carry
 * domain-meaningful failure information).
 *
 * Exported so callers + tests can `instanceof` check.
 */
export class RpcTimeoutError extends Error {
  override readonly name = "RpcTimeoutError";
  constructor(
    readonly channel: string,
    readonly timeoutMs: number,
  ) {
    super(`${channel} timeout after ${timeoutMs}ms`);
  }
}

function rpcCall<T>(
  api: {
    emit: (channel: string, data: unknown) => void | Promise<void>;
    on: (
      channel: string,
      handler: (data: unknown) => void | Promise<void>,
    ) => () => void;
  },
  channel: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const requestId = randomUUID();
  const replyChannel = `${channel}:reply:${requestId}`;
  // Two pre-fix crashes captured in ~/.pi/agent/crashes.json
  // (2026-10-08T14:17:24Z) trace here:
  //   1. The `setTimeout` callback referenced `unsub` BEFORE the
  //      `const unsub = api.on(...)` declaration ran. If the executor
  //      threw before line 93 (e.g. ctx.events undefined → "Cannot
  //      read properties of undefined (reading 'on')"), the Promise
  //      rejected with that error, but the orphan timer was never
  //      cleared. When it fired, the still-uninitialized `unsub`
  //      binding raised a TDZ ReferenceError and crashed the host.
  //   2. Same root cause, surfaced as a host-wide uncaught exception
  //      rather than a per-call rejection.
  //
  // Fix: hoist `unsub` to a `let` declared BEFORE setTimeout (so the
  // binding exists by the time the timer callback can run), wrap the
  // setup in try/catch, and route all teardown through one `cleanup`
  // helper that clears the timer and removes the listener.
  return new Promise<T>((resolveFn, rejectFn) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (unsub !== undefined) {
        unsub();
        unsub = undefined;
      }
    };
    try {
      timer = setTimeout(() => {
        cleanup();
        rejectFn(new RpcTimeoutError(channel, timeoutMs));
      }, timeoutMs);
      unsub = api.on(replyChannel, (raw: unknown) => {
        cleanup();
        const reply = raw as RpcEnvelope<T>;
        if (reply.success && reply.data !== undefined) {
          resolveFn(reply.data);
        } else {
          rejectFn(new Error(reply.error ?? `${channel} failed (no data)`));
        }
      });
      void api.emit(channel, { requestId, ...params });
    } catch (err) {
      cleanup();
      rejectFn(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── Entry point (pure, testable without pi runtime) ────────────────────

/**
 * GC-2026-decompose-task-retry: default per-call retry budget for
 * the decompose RPC. The pre-fix behavior was no retry — a single
 * timeout error surfaced immediately to the LLM. The retry loop
 * here covers transient failure modes (slow listener attach,
 * intermittent event-bus hiccup) at the cost of taking up to
 * `maxRetries * rpcTimeoutMs` of wall-clock in the worst case.
 *
 * The user's explicit ask: 最多重试三次 → default 3.
 */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Optional delay between retry attempts. Default 0 (immediate
 * retry). The per-attempt `rpcTimeoutMs` already provides natural
 * spacing — adding a delay here would only help if the listener
 * needs recovery time after a slow first response. Tests can
 * override to 0 to keep runtime small.
 */
const DEFAULT_RETRY_DELAY_MS = 0;

export async function executeDecomposeTask(
  params: DecomposeTaskInput,
  ctx: {
    cwd: string;
    events: {
      emit: (channel: string, data: unknown) => void | Promise<void>;
      on: (
        channel: string,
        handler: (data: unknown) => void | Promise<void>,
      ) => () => void;
    };
    /** Override the RPC timeout (default 30s). Useful for tests. */
    rpcTimeoutMs?: number;
    /** GC-2026-decompose-task-retry: max attempts (default 3, total tries incl. first). */
    maxRetries?: number;
    /** GC-2026-decompose-task-retry: delay between attempts in ms (default 0). */
    retryDelayMs?: number;
  },
): Promise<DecomposeTaskResult> {
  const maxRetries = ctx.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = ctx.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const rpcTimeoutMs = ctx.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  // GC-2026-decompose-task-retry: retry on timeout only. Listener-side
  // failures (success: false envelopes) carry domain-meaningful
  // information; retrying would re-emit the same call and either get
  // the same failure or — worse — succeed on a transient side-effect
  // the listener would normally reject (e.g. duplicate-task policy).
  //
  // KNOWN LIMITATION (idempotency): retries are NOT idempotent at the
  // listener level. If the first attempt's request reached the
  // pi-tasks listener and was processed (chain materialized in
  // store.create calls) but the reply did not make it back within
  // the timeout, the retry will issue a new requestId, the listener
  // will re-process, and a duplicate chain will be created in the
  // store. Full idempotency requires the listener to dedupe by
  // requestId (or by `user_task_id`); that's a follow-up GC against
  // pi-tasks. See `pi/docs/postmortem/GC-2026-decompose-task-retry.md`
  // for the full analysis.
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const inner = await rpcCall<{
        status: "success";
        summary: string;
        tasks: DecomposeTaskResult["tasks"];
        user_task_chain?: string[];
        first_task_spawned?: { task_id: string; agent_id: string };
      }>(
        ctx.events,
        DECOMPOSE_REQUEST_CHANNEL,
        { params },
        rpcTimeoutMs,
      );

      // Success: write audit and return. Audit only happens on
      // success — a failed RPC has no materialize result to record.
      const auditPath = writeAuditFile(ctx.cwd, params, inner);
      return {
        status: "success",
        summary: inner.summary,
        tasks: inner.tasks,
        ...(inner.user_task_chain ? { user_task_chain: inner.user_task_chain } : {}),
        ...(inner.first_task_spawned
          ? { first_task_spawned: inner.first_task_spawned }
          : {}),
        audit_path: auditPath,
      };
    } catch (err) {
      lastErr = err;
      // Non-timeout errors propagate immediately (no retry).
      if (!(err instanceof RpcTimeoutError)) {
        throw err;
      }
      // Last attempt: don't sleep, just exit the loop and throw.
      if (attempt < maxRetries - 1 && retryDelayMs > 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  // All attempts timed out. Throw the most recent error so the
  // caller sees the channel name + timeout duration in the message.
  throw lastErr;
}

function writeAuditFile(
  cwd: string,
  params: DecomposeTaskInput,
  inner: {
    tasks: Array<{ task_id: string; reviewer_id: string | undefined }>;
    first_task_spawned?: { task_id: string; agent_id: string };
  },
): string {
  const auditDir = join(cwd, ".pi", "orchestrator");
  mkdirSync(auditDir, { recursive: true });
  const auditName = params.user_task_id
    ? `decompose-${params.user_task_id}.yaml`
    : `decompose-${new Date().toISOString().replace(/[:.]/g, "-")}.yaml`;
  const auditPath = join(auditDir, auditName);
  const lines: string[] = [
    `# Decompose audit`,
    `decompose_at: ${new Date().toISOString()}`,
    `user_task_id: ${params.user_task_id ?? "(none)"}`,
    `spec_count: ${params.specs.length}`,
    `created_tasks: [${inner.tasks.map((t) => t.task_id).join(", ")}]`,
    `reviewers: [${inner.tasks.map((t) => t.reviewer_id ?? "null").join(", ")}]`,
    `first_task_spawned: ${
      inner.first_task_spawned
        ? `${inner.first_task_spawned.task_id} (agent_id=${inner.first_task_spawned.agent_id})`
        : "(none)"
    }`,
  ];
  writeFileSync(auditPath, lines.join("\n") + "\n", { mode: 0o644 });
  return auditPath;
}

// ── Tool wrapper (extracted for testability — GC-2026-fix-decompose-task-ctx-events) ─

/**
 * Shape the inner `executeDecomposeTask` requires. Mirrors the host's
 * `ExtensionToolContext` minus the `signal` / `onUpdate` fields the
 * decompose RPC does not need.
 */
export interface SafeDecomposeCtx {
  cwd: string;
  events: {
    emit: (channel: string, data: unknown) => void | Promise<void>;
    on: (
      channel: string,
      handler: (data: unknown) => void | Promise<void>,
    ) => () => void;
  };
  /** Optional RPC timeout override. Defaults to 30s in executeDecomposeTask. */
  rpcTimeoutMs?: number;
}

/**
 * GC-2026-fix-decompose-task-ctx-events: pre-fix the tool wrapper
 * used `(ctx as SafeDecomposeCtx) ?? { cwd: process.cwd(), events: <no-op> }`,
 * which only fell back when `ctx` itself was null/undefined. When the
 * host passed a `ctx` whose `events` field was undefined (the shape
 * mismatch from the host's `ExtensionToolContext`), the cast silenced
 * TypeScript but at runtime `safeCtx.events.on(...)` threw
 * `Cannot read properties of undefined (reading 'on')` — the
 * 6×-hit runtime bug captured in the GC postmortem. The fix defaults
 * `events` independently of `cwd`, mirroring the pattern in
 * `wrapRegisteredTool` (`pi-orchestrator/src/registered-tool-wrapper.ts:124`).
 */
export function buildSafeCtx(ctx: unknown): SafeDecomposeCtx {
  const obj = ctx as Partial<SafeDecomposeCtx> | null | undefined;
  return {
    cwd: obj?.cwd ?? process.cwd(),
    events: obj?.events ?? { emit: () => {}, on: () => () => {} },
    ...(obj?.rpcTimeoutMs !== undefined ? { rpcTimeoutMs: obj.rpcTimeoutMs } : {}),
  };
}

/**
 * Pure entry point for the `decompose_task` tool. Extracted from
 * `registerDecomposeTaskTool` so unit tests can exercise the wrapper
 * logic (the `safeCtx` fallback, the JSON.stringify response shape)
 * without going through `pi.registerTool`.
 *
 * The wrapper's only job is to narrow `ctx: unknown` (the
 * `registerTool` boundary) into the shape `executeDecomposeTask`
 * requires. Production callers go through `registerDecomposeTaskTool`;
 * tests go through this function directly.
 */
export async function executeDecomposeTaskTool(
  params: DecomposeTaskInput,
  ctx: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const safeCtx = buildSafeCtx(ctx);
  const result = await executeDecomposeTask(params, safeCtx);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

// ── Tool registration ─────────────────────────────────────────────────

export function registerDecomposeTaskTool(pi: unknown): void {
  // Same `pi: any` workaround as workflow-run-tool.ts: pi-coding-agent's
  // ToolDefinition uses AgentToolResult<unknown> internally which is
  // structurally incompatible with our local return shape.
  const piAsAny = pi as unknown as {
    registerTool(def: {
      name: string;
      label: string;
      description: string;
      parameters: typeof DecomposeTaskParams;
      execute: (
        toolCallId: string,
        params: DecomposeTaskInput,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
      }>;
    }): void;
  };
  piAsAny.registerTool({
    name: "decompose_task",
    label: "Decompose Task",
    description:
      "GC-2026-task-feeding-and-decomposition (D5, R3): break a high-level intent into N orchestrator-tracked sub-tasks. Linear chain T1 -> T2 -> ... -> TN. T1 is top-level -> auto-attaches one Reviewer sibling. Subsequent T_i are blockedBy the previous spec, so they're not top-level -> no additional Reviewer. No recursion, no folded sub-tasks. The whole chain shares one R1 at the head. The first task spawns immediately; the cascade proceeds serially via pi-tasks's unified task-feeder (cascadeSpawn walks pending feedable tasks with satisfied blockers — GC-2026-113; the dedicated decompose-cascade module was removed in GC-2026-117).",
    parameters: DecomposeTaskParams,
    execute: async (
      _toolCallId: string,
      params: DecomposeTaskInput,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: unknown,
    ) => executeDecomposeTaskTool(params, ctx),
  });
}
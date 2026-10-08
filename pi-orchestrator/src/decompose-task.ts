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

const DECOMPOSE_REQUEST_CHANNEL = "tasks:rpc:decompose-materialize";
const DECOMPOSE_REPLY_PREFIX = "tasks:rpc:decompose-materialize:reply:";
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
  return new Promise<T>((resolveFn, rejectFn) => {
    const timer = setTimeout(() => {
      unsub();
      rejectFn(new Error(`${channel} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = api.on(replyChannel, (raw: unknown) => {
      clearTimeout(timer);
      unsub();
      const reply = raw as RpcEnvelope<T>;
      if (reply.success && reply.data !== undefined) {
        resolveFn(reply.data);
      } else {
        rejectFn(new Error(reply.error ?? `${channel} failed (no data)`));
      }
    });
    void api.emit(channel, { requestId, ...params });
  });
}

// ── Entry point (pure, testable without pi runtime) ────────────────────

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
  },
): Promise<DecomposeTaskResult> {
  const inner = await rpcCall<{
    status: "success";
    summary: string;
    tasks: DecomposeTaskResult["tasks"];
    user_task_chain?: string[];
    first_task_spawned?: { task_id: string; agent_id: string };
  }>(ctx.events, DECOMPOSE_REQUEST_CHANNEL, { params }, ctx.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);

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
      "GC-2026-task-feeding-and-decomposition (D5, R3): break a high-level intent into N orchestrator-tracked sub-tasks. Linear chain T1 -> T2 -> ... -> TN. T1 is top-level -> auto-attaches one Reviewer sibling. Subsequent T_i are blockedBy the previous spec, so they're not top-level -> no additional Reviewer. No recursion, no folded sub-tasks. The whole chain shares one R1 at the head. The first task spawns immediately; the cascade proceeds serially via pi-tasks's decompose-cascade listener.",
    parameters: DecomposeTaskParams,
    execute: async (
      _toolCallId: string,
      params: DecomposeTaskInput,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: unknown,
    ) => {
      const safeCtx =
        (ctx as {
          cwd: string;
          events: {
            emit: (channel: string, data: unknown) => void | Promise<void>;
            on: (
              channel: string,
              handler: (data: unknown) => void | Promise<void>,
            ) => () => void;
          };
        }) ?? {
          cwd: process.cwd(),
          events: { emit: () => {}, on: () => () => {} },
        };
      const result = await executeDecomposeTask(params, safeCtx);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  });
}
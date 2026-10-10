/**
 * recording.ts — GC-2026-subagent-recording-no-budget
 *
 * Append-only JSONL recorder for subagent tool usage. Every tool execution
 * across every subagent type is captured as a single row, allowing the
 * orchestrator to analyze post-hoc via `bun run subagent-usage:summary`.
 *
 * No enforcement: this module never interrupts a tool execution, never
 * aborts an agent, never applies a budget. It captures; that's all.
 *
 * The JSONL log lives at `.pi/orchestrator/metrics/subagent-tool-usage.jsonl`
 * by default; the orchestrator recorder wires the same path so a single
 * stream serves both producers.
 *
 * Writer-safety: appends are serialized through a queue mutex so concurrent
 * appends (e.g. N parallel subagents racing to record) don't interleave
 * half-written rows. Write errors are caught and re-emitted on the
 * `subagents:recording-error` event channel — the agent's run continues
 * unaffected (recording is best-effort, never blocking).
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

// ── Single source of truth: the JSONL path ────────────────────────────

/**
 * The default JSONL file path for subagent tool-usage recordings. The
 * orchestrator recorder (`pi-orchestrator/src/recorder.ts`) uses the same
 * path so a single host process writes to one file; the cross-host
 * recorder is a no-op stub. Both `aggregate-subagent-usage.ts` and the
 * `verify:recorder` gate read from this constant or its override.
 */
export const RECORDING_PATH_DEFAULT =
  ".pi/orchestrator/metrics/subagent-tool-usage.jsonl";

// ── Event channel for write errors ────────────────────────────────────

/** Event channel for recording write errors. Subscribed by diagnostic / UI. */
export const SUBAGENTS_RECORDING_ERROR = "subagents:recording-error";

/**
 * Event channel emitted by `agent-runner.ts` (via `emitToolUse` below)
 * for every tool execution across every subagent type. The orchestrator
 * recorder (`pi-orchestrator/src/recorder.ts`) subscribes and writes to
 * the JSONL file; cross-process hosts can ignore the channel.
 */
export const SUBAGENTS_TOOL_USE = "subagents:tool-use";

// ── Record shape ──────────────────────────────────────────────────────

/**
 * A single tool-use record. Fields are stable; downstream tooling (the
 * aggregator script, `pi-evaluator/src/metrics/tool-use.ts`, the task
 * widget) may rely on the key set. `inputKeys` is the list of parameter
 * keys (NEVER the values) so secrets / large blobs aren't persisted.
 */
export interface ToolUseRecord {
  /** Subagent id (from `AgentRecord.id`). */
  agentId: string;
  /** Subagent type (developer / reviewer / Explore / Plan / Merger / Fix / advisor variants / etc.). */
  agentType: string;
  /** Originating task id (omittable for tool calls that pre-date task creation). */
  taskId: string;
  /** Tool name as registered. */
  toolName: string;
  /** Names of the input parameter keys. Values are intentionally NOT recorded. */
  inputKeys: readonly string[];
  /** Wall-clock duration of the tool execution in milliseconds. */
  durationMs: number;
  /** Unix ms timestamp at tool completion (after the `tool_result`). */
  ts: number;
}

/**
 * Minimal event-bus emit interface consumed by `emitToolUse`. Matches
 * the `pi.events.emit` shape and is structurally compatible with the
 * `ToolUseRecorderOptions.events` field above.
 */
export interface ToolUseEventsBus {
  emit: (channel: string, payload: unknown) => void;
}

/**
 * Helper called by `agent-runner.ts` at every tool execution. Emits
 * `SUBAGENTS_TOOL_USE` exactly once with the record shape; never throws.
 *
 * `inputKeys` is derived from `input` via `Object.keys(input).sort()`.
 * The caller can also pass an explicit `inputKeys` array to override
 * (useful when the runtime wraps the input object across an internal
 * hop and you want to capture the user-facing key names).
 */
export function emitToolUse(
  events: ToolUseEventsBus,
  args: {
    agentId: string;
    agentType: string;
    taskId: string;
    toolName: string;
    input: Record<string, unknown> | undefined;
    inputKeys?: readonly string[];
    durationMs: number;
    ts?: number;
  },
): void {
  const record: ToolUseRecord = {
    agentId: args.agentId,
    agentType: args.agentType,
    taskId: args.taskId,
    toolName: args.toolName,
    inputKeys: args.inputKeys ?? (args.input ? Object.keys(args.input).sort() : []),
    durationMs: Math.max(0, Math.floor(args.durationMs)),
    ts: typeof args.ts === "number" ? args.ts : Date.now(),
  };
  try {
    events.emit(SUBAGENTS_TOOL_USE, record);
  } catch {
    // Never let a subscriber throw block the tool result delivery.
  }
}

// ── Recorder options ──────────────────────────────────────────────────

export interface ToolUseRecorderOptions {
  /**
   * JSONL path. Defaults to `RECORDING_PATH_DEFAULT`. Tests pass a tmp path.
   */
  jsonlPath?: string;
  /**
   * Event-bus interface for re-emitting write errors. Subscribers receive
   * `{ jsonlPath, error }` payloads on the `subagents:recording-error`
   * channel. Same shape as the `pi.events` interface used elsewhere in
   * pi-subagents; recorder is usable from any host that has `events.emit`.
   */
  events: {
    emit: (channel: string, payload: unknown) => void;
  };
}

// ── Recorder ──────────────────────────────────────────────────────────

/**
 * Append-only JSONL writer. One instance per process; reuse via
 * `recorder.append(row)` from every tool execution.
 *
 * Concurrency: a per-instance promise mutex serializes writes, so
 * concurrent `append()` calls don't interleave bytes mid-line.
 *
 * Errors: never throws from `append`. The error is caught and re-emitted
 * on `subagents:recording-error`; the caller can continue unaffected.
 * `await append(...)` resolves once the row is on disk OR once the
 * write attempt completed (with the error re-emitted).
 */
export class ToolUseRecorder {
  private readonly jsonlPath: string;
  private readonly events: ToolUseRecorderOptions["events"];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ToolUseRecorderOptions) {
    this.jsonlPath = options.jsonlPath ?? RECORDING_PATH_DEFAULT;
    this.events = options.events;
  }

  /**
   * Append one row. Serializes against any in-flight write. Resolves once
   * the row is persisted (or once the write attempt failed + the error
   * was re-emitted on `subagents:recording-error`).
   */
  async append(record: ToolUseRecord): Promise<void> {
    const next = this.writeQueue.then(async () => {
      const line = JSON.stringify(record) + "\n";
      try {
        await mkdir(dirname(this.jsonlPath), { recursive: true });
        await appendFile(this.jsonlPath, line, "utf-8");
      } catch (err) {
        this.events.emit(SUBAGENTS_RECORDING_ERROR, {
          jsonlPath: this.jsonlPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    // Keep the chain alive even if a previous write rejected; never let
    // an error poison the queue.
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  /** Resolve once all currently-queued writes have flushed. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

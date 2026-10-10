/**
 * main-agent-injector.ts — GC-2026-main-agent-proactive-intent-pump
 *
 * Replaces GC-2026-122's soft system-prompt reminder with a queued,
 * observable pump that injects a "Consume intent #N" user message into
 * the main session. The main LLM is the sole consumer; it picks one of:
 *
 *   1. decompose_task(user_task_id="#N", specs=[...])  → chain enters
 *      the task stream via the existing materializeDecomposeChain path
 *   2. chat-answer + TaskUpdate(taskId="#N", status="completed")
 *   3. (escape hatch) TaskUpdate(taskId="#N", status="pending",
 *      metadata={blocked_reason:"..."})  → park, do not re-pump
 *
 * Locked design decisions (do not re-open):
 *   - Single-in-flight; new intents during a consumption turn append to
 *     an internal FIFO queue (by createdAt / enqueue order).
 *   - No cascade. The pump's "next" iterator pulls from its own queue,
 *     never walks `blockedBy` edges.
 *   - MainAgentTransport interface (`send(content)` + optional
 *     `isBusy?()`) so the production transport wraps `pi.sendUserMessage`
 *     and tests use a recording FakeTransport.
 *   - Completion detection: a polling tick on the in-flight task. When
 *     `store.get(taskId).status === "completed"`, the pump advances. If
 *     the LLM rolls the task back to `pending` with `lastError` (transport
 *     failure) or `blocked_reason` (LLM-park), the pump stops advancing
 *     and waits for the next enqueue.
 *
 * The feeder (task-feeder.ts) routes `kind=intent` tasks here instead of
 * `AgentManager.spawn`. The intent-reminder.ts path stays as a fallback
 * for orphaned intents (the pump exposes `isOwned(taskId)` so the
 * reminder can skip pump-owned tasks).
 */

import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

// ── Transport interface ─────────────────────────────────────────────

/**
 * Pluggable transport that the pump uses to push a "consume this intent"
 * user-role message into the main session. Production wraps
 * `pi.sendUserMessage`; tests record sends in an array.
 */
export interface MainAgentTransport {
  /** Send `content` to the main session as a user-role message. */
  send(content: string): Promise<void>;
  /**
   * Optional busy signal. If the transport exposes this and it returns
   * true, the pump treats that as "session is busy, do not preempt"
   * (but the pump already does not preempt — it always queues — so this
   * is currently informational only; reserved for a future follow-up
   * that wants to expose busy state to the LLM via the prompt).
   */
  isBusy?(): boolean;
}

// ── Pure prompt composer ─────────────────────────────────────────────

const MAX_DESCRIPTION_CHARS = 200;

/**
 * Compose the user-role prompt that the pump injects when an intent
 * needs consumption. Pure function — no side effects, no store reads.
 *
 * Stable text shape; the LLM is expected to match on `task #N` and
 * `taskId="N"` substrings to call back into TaskUpdate / decompose_task.
 */
export function composeConsumptionPrompt(task: Task): string {
  const desc =
    task.description.length > MAX_DESCRIPTION_CHARS
      ? `${task.description.slice(0, MAX_DESCRIPTION_CHARS - 3)}...`
      : task.description;
  return [
    `[IntentPump] Pending intent task #${task.id}:`,
    ``,
    `Subject: ${task.subject}`,
    `Description: ${desc}`,
    ``,
    `Decide ONE:`,
    `1. decompose_task(user_task_id="${task.id}", specs=[...])   — multi-step`,
    `2. chat-answer + TaskUpdate(taskId="${task.id}", status="completed")   — trivial`,
    ``,
    `If blocked on missing input, emit:`,
    `  TaskUpdate(taskId="${task.id}", status="pending",`,
    `    metadata={blocked_reason:"..."})`,
    `The pump will see the blocked_reason and stay parked until the`,
    `next enqueue. Do NOT leave pending silently.`,
  ].join("\n");
}

// ── IntentPump ───────────────────────────────────────────────────────

export interface IntentPumpOptions {
  /** Polling interval for completion detection. Default 50ms. */
  pollMs?: number;
}

/**
 * Single-in-flight pump for `kind=intent` tasks. Enqueue an intent
 * while another is in-flight and it joins the FIFO queue. When the
 * in-flight task reaches `completed` (LLM's TaskUpdate), the pump
 * dequeues the next and pumps it. Send failures and blocked_reason
 * rollbacks park the in-flight task without advancing.
 */
export class IntentPump {
  private inFlight: Task | null = null;
  private queue: Task[] = [];
  private readonly ownedIds = new Set<string>();
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private readonly pollMs: number;
  private disposed = false;

  constructor(
    private readonly store: TaskStore,
    private readonly transport: MainAgentTransport,
    options: IntentPumpOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 50;
  }

  /**
   * Enqueue an intent for consumption. If a task is in-flight, the new
   * task joins the internal FIFO queue. Otherwise it is pumped
   * immediately. Marked "owned" regardless, so the reminder fallback
   * can skip it.
   */
  enqueue(task: Task): void {
    if (this.disposed) return;
    this.ownedIds.add(task.id);
    if (this.inFlight !== null) {
      // FIFO by enqueue order. createdAt is monotonic with enqueue in
      // practice (TaskStore.create stamps createdAt = Date.now() and
      // the feeder calls enqueue once per create), so we use a simple
      // push. If the caller has reordered createdAt manually, the
      // consumer side (LLM) will still see tasks in enqueue order
      // because the queue is the source of truth for "next".
      this.queue.push(task);
      return;
    }
    this.startPump(task);
  }

  /** True iff `taskId` has been enqueued into the pump (owned). */
  isOwned(taskId: string): boolean {
    return this.ownedIds.has(taskId);
  }

  /** Number of pending pump tasks (in-flight + queued). */
  size(): number {
    return (this.inFlight ? 1 : 0) + this.queue.length;
  }

  /** Detach the polling timer and clear state. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.inFlight = null;
    this.queue = [];
  }

  // ── Internals ────────────────────────────────────────────────────

  private startPump(task: Task): void {
    this.inFlight = task;
    this.store.update(task.id, {
      status: "in_progress",
      owner: "main-session",
    });
    this.transport.send(composeConsumptionPrompt(task)).then(
      () => this.onSendOk(task),
      (err: unknown) => this.onSendErr(task, err),
    );
  }

  private onSendOk(task: Task): void {
    if (this.disposed) return;
    if (this.inFlight?.id !== task.id) return;
    this.startPolling();
  }

  private onSendErr(task: Task, err: unknown): void {
    if (this.disposed) return;
    const msg = err instanceof Error ? err.message : String(err);
    this.store.update(task.id, {
      status: "pending",
      metadata: { ...task.metadata, lastError: msg },
    });
    // Queue does NOT advance on send failure — the failed task stays at
    // the head of the queue (via re-enqueue) so a future retry can
    // pick it up. We re-enqueue so the next send failure also surfaces
    // through the same path; the head-of-queue is now the same task.
    this.inFlight = null;
    this.queue.unshift(task);
    this.stopPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollHandle = setInterval(() => this.poll(), this.pollMs);
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private poll(): void {
    if (this.disposed || this.inFlight === null) {
      this.stopPolling();
      return;
    }
    const taskId = this.inFlight.id;
    const fresh = this.store.get(taskId);
    if (!fresh) {
      // Task disappeared from the store (deleted?); abandon the in-flight
      // but do not advance.
      this.stopPolling();
      this.inFlight = null;
      return;
    }
    if (fresh.status === "completed") {
      this.advance();
      return;
    }
    if (fresh.status === "pending") {
      const meta = fresh.metadata ?? {};
      if (typeof meta.lastError === "string") {
        // Send-failure rollback — already rolled back in onSendErr, but
        // defensive: if a separate path also rolls back, don't re-fire.
        this.stopPolling();
        this.inFlight = null;
        return;
      }
      if (typeof meta.blocked_reason === "string") {
        // LLM-parked with blocked_reason — keep the task in ownedIds but
        // do not re-pump. The reminder will eventually surface it
        // again, OR the LLM can call TaskUpdate(completed) on it later.
        this.stopPolling();
        this.inFlight = null;
        return;
      }
    }
    // Otherwise (in_progress, or pending with no escape hatch) — keep polling.
  }

  private advance(): void {
    this.stopPolling();
    this.inFlight = null;
    const next = this.queue.shift();
    if (next !== undefined) {
      this.startPump(next);
    }
    // else: queue empty, do nothing. (We never walk the store to find
    // orphans — the feeder is the only path into the pump, and cascade
    // is explicitly forbidden by the contract.)
  }
}

/**
 * main-agent-injector.ts — GC-2026-main-agent-proactive-intent-pump +
 *   GC-2026-intent-default-to-decompose
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
 *
 * ── GC-2026-intent-default-to-decompose ──
 *
 * Empirically observed (current chat session and the
 * GC-2026-continuous-intent-reminder postmortem): when the pump
 * injects a user-role prompt for a task like "了解一下当前仓库",
 * the LLM frequently picks option #2 (chat-answer + completed) for
 * what is plainly a multi-step task. The system-prompt reminder is
 * verified wired (see `intent-reminder-wiring.test.ts`), but the
 * user-role injection eclipses it.
 *
 * Mitigation: bias the user-role prompt itself toward `decompose_task`
 * for tasks that look exploration-shaped:
 *   - A) `detectExplorationIntent(subject)` + a `Routing:` block that
 *        default-recommends `decompose_task` and shifts the burden of
 *        justification onto the chat-answer path.
 *   - B) Empty-description + non-trivial subject (length > 5) gets a
 *        callout lifted above the numbered `Decide ONE` so the LLM
 *        cannot miss it.
 *   - D) `composeSpecSuggestion(task)` returns 3–5 suggested specs for
 *        known intent patterns (了解/explore/learn, 重构/refactor,
 *        修复/fix/bug) so the LLM does not have to invent them.
 *
 * These three additions make the prompt strongly favor the correct
 * branch for the most common failure mode without removing the
 * `Decide ONE` framing (LLM autonomy is preserved).
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

// ── GC-2026-intent-default-to-decompose / A: exploration-verb lexicon ──

/**
 * Chinese verbs that signal "this task is an exploration/refactor/
 * investigation that should almost always be decomposed". Matched
 * case-sensitively (Chinese has no case).
 */
export const EXPLORATION_VERBS_CN: readonly string[] = [
  "了解",
  "学习",
  "梳理",
  "分析",
  "总结",
  "调研",
  "排查",
  "重构",
  "修复",
  "调查",
  "掌握",
];

/**
 * English verbs with the same semantics. Matched case-insensitively
 * (the matcher lowercases both sides).
 */
export const EXPLORATION_VERBS_EN: readonly string[] = [
  "explore",
  "learn",
  "understand",
  "investigate",
  "analyze",
  "summarize",
  "review",
  "audit",
  "refactor",
  "rewrite",
  "restructure",
  "redesign",
  "build",
  "implement",
  "fix",
  "repair",
  "patch",
  "debug",
];

/**
 * True iff `subject` contains any verb from the exploration lexicon.
 * The matching is case-insensitive for English and byte-exact for
 * Chinese (no case folding). An empty subject returns false.
 */
export function detectExplorationIntent(subject: string): boolean {
  if (!subject) return false;
  const lower = subject.toLowerCase();
  for (const v of EXPLORATION_VERBS_CN) {
    if (subject.includes(v)) return true;
  }
  for (const v of EXPLORATION_VERBS_EN) {
    if (lower.includes(v.toLowerCase())) return true;
  }
  return false;
}

// ── GC-2026-intent-default-to-decompose / D: spec templates ──

interface SpecTemplate {
  /** Verbs (CN + EN) that match this template. */
  verbs: readonly string[];
  /** Suggested spec entries; the LLM may adjust, drop, or extend. */
  specs: readonly string[];
}

/**
 * Per-verb-tribe spec templates. Each template is selected when the
 * subject contains any of its `verbs`. Ordered by specificity — the
 * first match wins. New patterns can be added without touching
 * `composeConsumptionPrompt`.
 */
const SPEC_TEMPLATES: readonly SpecTemplate[] = [
  {
    verbs: ["了解", "学习", "explore", "learn", "understand", "梳理", "调研"],
    specs: [
      "Read top-level docs (README, AGENTS.md, package.json) and write 1-line summary per file",
      "Map package layout (workspaces, key entry points, public surface)",
      "Explore key code paths (extension hooks, AgentManager, TaskStore) and capture the call graph",
      "Synthesize a structured overview for the user (what it is, how it works, where to dive next)",
    ],
  },
  {
    verbs: ["重构", "refactor", "rewrite", "restructure", "redesign"],
    specs: [
      "Identify refactor scope: which files / symbols / contracts are in scope and which are frozen",
      "Write characterization tests for current behavior (capture the contract before changing it)",
      "Apply the transformation incrementally, keeping tests green at every step",
      "Verify behavior unchanged via the full test suite + manual smoke of the user-facing surface",
    ],
  },
  {
    verbs: ["修复", "fix", "bug", "debug", "repair", "patch"],
    specs: [
      "Reproduce the bug with a minimal failing test (RED)",
      "Locate the root cause in source \u2014 call-graph + diff bisect if needed",
      "Implement the fix (GREEN) and confirm the failing test now passes",
      "Run the full regression suite + add a regression test that pins the fix",
    ],
  },
  {
    verbs: ["分析", "analyze", "审计", "audit", "review", "排查"],
    specs: [
      "State the analysis question + success criteria up front",
      "Gather evidence (grep, read, instrument) and record findings",
      "Cross-check findings against scope.include / scope.exclude and anti_goals",
      "Write a structured report with verdict, evidence, and recommended next steps",
    ],
  },
];

/**
 * Return 3\u20135 suggested specs for the given task based on its subject.
 * Returns an empty array when no template matches \u2014 the LLM is then
 * free to invent specs from scratch (the same behavior as before
 * GC-2026-intent-default-to-decompose).
 */
export function composeSpecSuggestion(task: Task): string[] {
  if (!task.subject) return [];
  const subjectLower = task.subject.toLowerCase();
  for (const tmpl of SPEC_TEMPLATES) {
    for (const v of tmpl.verbs) {
      const vLower = v.toLowerCase();
      // For ASCII verbs use case-insensitive substring match; for
      // non-ASCII (Chinese) use the original-cased substring so we
      // don't accidentally match a Latin-shaped string.
      const isAscii = /^[\x00-\x7f]+$/.test(v);
      if (isAscii ? subjectLower.includes(vLower) : task.subject.includes(v)) {
        return [...tmpl.specs];
      }
    }
  }
  return [];
}

// ── GC-2026-intent-default-to-decompose / B: empty-description default ──

/**
 * True when the description is empty/whitespace AND the subject is
 * long enough to be a non-trivial task (>5 chars). Both clauses are
 * required: a one-word subject like "hi" with empty description is
 * genuinely trivial and should not trigger the default-decompose
 * callout (that would over-decompose noise).
 */
function isEmptyDescriptionNonTrivialSubject(task: Task): boolean {
  return task.description.trim() === "" && task.subject.length > 5;
}

/**
 * Compose the user-role prompt that the pump injects when an intent
 * needs consumption. Pure function \u2014 no side effects, no store reads.
 *
 * Stable text shape; the LLM is expected to match on `task #N` and
 * `taskId="N"` substrings to call back into TaskUpdate / decompose_task.
 *
 * GC-2026-intent-default-to-decompose: the prompt biases toward
 * `decompose_task` via three additive blocks (none of them remove the
 * existing `Decide ONE` framing):
 *   - `Routing:` block when the subject matches the exploration
 *     lexicon \u2014 default-recommends `decompose_task`, shifts burden
 *     of justification onto chat-answer.
 *   - `Empty description` callout lifted above `Decide ONE` when
 *     description is empty AND subject is non-trivial \u2014 same
 *     default + a noise signal the LLM cannot miss.
 *   - `Suggested specs:` block when `composeSpecSuggestion` returns
 *     entries \u2014 lowers the cost of decomposing by handing the LLM
 *     a ready-made spec list.
 */
export function composeConsumptionPrompt(task: Task): string {
  const desc =
    task.description.length > MAX_DESCRIPTION_CHARS
      ? `${task.description.slice(0, MAX_DESCRIPTION_CHARS - 3)}...`
      : task.description;
  const lines: string[] = [
    `[IntentPump] Pending intent task #${task.id}:`,
    ``,
    `Subject: ${task.subject}`,
    `Description: ${desc}`,
    ``,
  ];

  // A) Routing block \u2014 default-recommend decompose for exploration-shaped subjects.
  if (detectExplorationIntent(task.subject)) {
    lines.push(
      `Routing: Subject matches an exploration verb (\u4e86\u89e3/\u5b66\u4e60/explore/refactor/...) \u2192 default to \`decompose_task\`.`,
      `If you pick chat-answer anyway, you owe the user an explicit justification for skipping decomposition.`,
      ``,
    );
  }

  // B) Empty-description callout \u2014 lifted above Decide ONE so the LLM cannot miss it.
  if (isEmptyDescriptionNonTrivialSubject(task)) {
    lines.push(
      `\u26a0\ufe0f  Empty description + non-trivial subject (length > 5) \u2192 default to \`decompose_task\`.`,
      `The subject alone suggests multiple steps; chat-answering would under-serve the user.`,
      ``,
    );
  }

  // D) Spec suggestion \u2014 when a known pattern matches, hand the LLM ready-made specs.
  const specs = composeSpecSuggestion(task);
  if (specs.length > 0) {
    lines.push(`Suggested specs (${specs.length}) \u2014 adjust / drop / extend as needed:`);
    for (const spec of specs) {
      lines.push(`  - ${spec}`);
    }
    lines.push(``);
  }

  lines.push(
    `Decide ONE:`,
    `1. decompose_task(user_task_id="${task.id}", specs=[...])   \u2014 multi-step`,
    `2. chat-answer + TaskUpdate(taskId="${task.id}", status="completed")   \u2014 trivial`,
    ``,
    `If blocked on missing input, emit:`,
    `  TaskUpdate(taskId="${task.id}", status="pending",`,
    `    metadata={blocked_reason:"..."})`,
    `The pump will see the blocked_reason and stay parked until the`,
    `next enqueue. Do NOT leave pending silently.`,
  );
  return lines.join("\n");
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

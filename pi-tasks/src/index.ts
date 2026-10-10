/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks as subagents (requires @tintinweb/pi-subagents)
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import { resolveTaskGlyphs } from "./task-glyphs.js";
import { reclaimGlobalSessionTasksDir, sessionTaskFile } from "./task-paths.js";
import { TaskStore } from "./task-store.js";
import { loadGlobalTasksConfig, loadTasksConfig } from "./tasks-config.js";
import type { Task } from "./types.js";
import { applyIntentReminderToSystemPrompt } from "./intent-reminder.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";
import {
  createOrchestratorTask,
  createOrchestratorTaskWithReview,
} from "./orchestrator-task.js";
import { isFeedableTask, registerTaskFeeder } from "./task-feeder.js";
import { TASKS_RPC_DECOMPOSE_MATERIALIZE } from "./event-channels.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult<T = unknown>(msg: string, details?: T) {
  // `details` flows back through the AgentToolCallOutcome envelope
  // (`ctx.executeTool(...).result.details`). Programmatic callers
  // (e.g. pi-orchestrator's other tools) read it to recover structured
  // task IDs without parsing the text body.
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

export default function (pi: ExtensionAPI) {
  // Project overrides require ExtensionContext.cwd, which is unavailable while
  // the extension factory runs. Start with global defaults, then merge the
  // active workspace's overrides on the first context-bearing event.
  const cfg = loadGlobalTasksConfig();
  const piTasks = process.env.PI_TASKS;
  let taskScope = cfg.taskScope ?? "session";

  /** Both session scopes persist one file per session; they differ only in where it
   *  lives, so every lifecycle rule about session files applies to each of them. */
  const isSessionScope = () => taskScope === "session" || taskScope === "session-global";

  /** Resolve both the backing path and a stable identity for the active store. */
  function resolveStoreTarget(cwd?: string, sessionId?: string): { key: string; path?: string } {
    if (piTasks === "off") return { key: "memory:env" };
    if (piTasks?.startsWith("/")) return { key: `path:${piTasks}`, path: piTasks };
    if (piTasks?.startsWith(".")) {
      const path = cwd ? resolve(cwd, piTasks) : undefined;
      return path ? { key: `path:${path}`, path } : { key: "pending:relative" };
    }
    if (piTasks) return { key: `named:${piTasks}`, path: piTasks };
    if (taskScope === "memory") return { key: "memory:config" };
    if (!cwd) return { key: "pending:workspace" };
    if (isSessionScope() && sessionId) {
      const path = sessionTaskFile(cwd, sessionId, taskScope);
      return { key: `path:${path}`, path };
    }
    if (isSessionScope()) return { key: "pending:session" };
    const path = join(cwd, ".pi", "tasks", "tasks.json");
    return { key: `path:${path}`, path };
  }

  // Project and relative paths need ExtensionContext.cwd, which is unavailable
  // while the extension factory runs. Absolute and named PI_TASKS overrides can
  // still be opened immediately; all other stores start in memory.
  let storeTarget = resolveStoreTarget();
  let store = new TaskStore(storeTarget.path);
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store, cfg);

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Maps agent IDs to task IDs for O(1) completion lookup. Shared with the unified task feeder. */
  const agentTaskMap = new Map<string, string>();

  // ── Subagent RPC helpers ──

  /** RPC reply envelope — matches pi-mono's RpcResponse shape. */
  type RpcReply<T = void> =
    | { success: true; data?: T }
    | { success: false; error: string };

  /** Call a subagents RPC method: emit request, wait for scoped reply, unwrap envelope. */
  function rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub(); clearTimeout(timer);
        debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      pi.events.emit(channel, { requestId, ...params });
      debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string }>("subagents:rpc:spawn", { type, prompt, options }, 30_000)
      .then(d => { debug("spawn:ok", d); return d.id; });
  }

  /** Stop a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000).catch(() => {});
  }

  /** Tell subagents its result has been handed to the model, which suppresses the
   *  completion notification it would otherwise deliver for the same result — the
   *  same consumption `get_subagent_result` performs when it returns one.
   *
   *  Fire-and-forget rather than an `rpcCall`: the reply carries nothing to act on,
   *  and the channel is deliberately outside the version handshake so a pi-subagents
   *  without the handler keeps notifying instead of failing the read. */
  function consumeSubagentResult(agentId: string): void {
    pi.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId });
  }

  // ── Subagent extension presence & version detection ──
  const PROTOCOL_VERSION = 2;
  let subagentsAvailable = false;
  let pendingWarning: string | undefined;

  /** GC-2026-fix-pending-spawn-after-ready: the message we attach to a
   *  spawn failure when subagents is not yet available. Used both as the
   *  thrown error and as a marker for the `subagents:ready` retry sweep
   *  to identify which pending tasks should be re-spawned when
   *  subagents finally comes online. */
  const SUBAGENTS_UNAVAILABLE_MESSAGE =
    "subagents extension unavailable; Planner fallback engages";

  /** Ping subagents and check protocol version. Returns a Promise that
   *  resolves when the ping settles (success OR timeout). Works with any
   *  handler version. */
  function checkSubagentsVersion(): Promise<void> {
    if (subagentsAvailable) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const requestId = randomUUID();
      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        resolve();
      };
      const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
        const remoteVersion = (raw as any)?.data?.version as number | undefined;
        if (remoteVersion === undefined) {
          pendingWarning =
            "@tintinweb/pi-subagents is outdated — please update for task execution support.";
        } else if (remoteVersion > PROTOCOL_VERSION) {
          pendingWarning =
            `@tintinweb/pi-tasks is outdated (protocol v${PROTOCOL_VERSION}, ` +
            `pi-subagents has v${remoteVersion}) — please update for task execution support.`;
        } else if (remoteVersion < PROTOCOL_VERSION) {
          pendingWarning =
            `@tintinweb/pi-subagents is outdated (protocol v${remoteVersion}, ` +
            `pi-tasks has v${PROTOCOL_VERSION}) — please update for task execution support.`;
        } else {
          subagentsAvailable = true;
        }
        finalize();
      });
      const timer = setTimeout(finalize, 5_000);
      pi.events.emit("subagents:rpc:ping", { requestId });
    });
  }

  /** GC-2026-fix-pending-spawn-after-ready: when subagents comes online,
   *  retry every pending task that previously failed because subagents
   *  wasn't yet ready. Without this sweep, a TaskCreate fired before
   *  `subagents:ready` would leave the task in pending with
   *  `lastError = SUBAGENTS_UNAVAILABLE_MESSAGE` — never consumed.
   *
   *  Implementation note: we do NOT block the spawn callback waiting for
   *  subagents to come online — that would slow TaskCreate by up to 10s
   *  in the genuine "subagents absent" case and break tests that depend
   *  on fast spawn failures. Instead, the spawn callback throws
   *  immediately (pre-fix behavior) and this sweep re-spawns the
   *  failed task once `subagents:ready` fires. Tradeoff: a TaskCreate
   *  that hits the race window sees its task briefly as "pending with
   *  lastError" before the sweep fires the retry — typically within a
   *  few hundred ms of subagents:ready. */
  async function retryPendingSpawnsAfterReady(): Promise<void> {
    for (const t of store.list()) {
      if (t.status !== "pending") continue;
      if (!isFeedableTask(t)) continue;
      const lastError = t.metadata?.lastError;
      if (typeof lastError !== "string" || !lastError.includes(SUBAGENTS_UNAVAILABLE_MESSAGE)) continue;
      // Clear the lastError marker so the feeder has a clean slate and
      // we don't loop forever if the retry also fails.
      store.update(t.id, {
        metadata: { ...t.metadata, lastError: null },
      });
      const fresh = store.get(t.id);
      if (fresh) await feeder.maybeAutoSpawn(fresh);
    }
  }

  checkSubagentsVersion();
  pi.events.on("subagents:ready", () => {
    // Re-ping to set subagentsAvailable, then sweep pending tasks that
    // previously failed because subagents wasn't ready. The sweep is
    // gated on the ping reply — `checkSubagentsVersion` resolves when
    // the ping settles, by which point subagentsAvailable reflects the
    // handshake outcome.
    void checkSubagentsVersion().then(() => {
      if (subagentsAvailable) {
        void retryPendingSpawnsAfterReady();
      }
    });
  });

  /** Build a prompt for a task being executed by a subagent.
   *  Injects completed dependency results so cascaded agents have context from prerequisites.
   */
  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    // Inject completed dependency results so cascaded agents have full context
    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > 4000
            ? dep.metadata.result.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ── Unified task feeder (GC-2026-113 FU0 Phase 2b + GC-2026-117) ──
  // Replaces the three previous cascade listeners (workflow-handler
  // direct spawn [GC-2026-remove-workflow-run-prod: module deleted],
  // decompose-cascade cascade [GC-2026-117: module deleted; the cascade
  // logic is here, not in a dedicated module], TaskExecute ad-hoc cascade).
  // ONE feeder owns spawn + completion for ALL task types
  // (decompose / user / TaskExecute).
  //
  // GC-2026-114 FU3: the `cfg.autoCascade` config key + the related
  // settings-menu toggle are removed entirely (cascade is unconditional).
  // The settings-menu item is gone; tasks-config.ts no longer declares
  // the key.
  //
  // The feeder's spawn callback dispatches with current-workspace
  // isolation (managed worktree isolation is now a subagent concern,
  // configured by the LLM when it creates each task).
  const feeder = registerTaskFeeder({
    store,
    events: pi.events,
    spawn: async (task: Task) => {
      // GC-2026-121: if pi-subagents is not available, refuse the spawn
      // gracefully — the task stays in pending state and the existing
      // before_agent_start reminder fires for the LLM as the fallback.
      // Without this guard, a missing subagents extension hangs the
      // feeder forever waiting for an RPC reply that never comes.
      //
      // GC-2026-fix-pending-spawn-after-ready: throw synchronously when
      // subagents is unavailable (preserves pre-fix behavior — the spawn
      // callback is a fast path and never blocks). The task is reverted
      // to pending with `lastError = SUBAGENTS_UNAVAILABLE_MESSAGE`,
      // and the `subagents:ready` listener below sweeps that marker
      // and re-spawns every pending failed task once subagents
      // broadcasts ready.
      //
      // The race we close: pre-fix, pi-subagents registers its RPC
      // handlers in session_start, AFTER pi-tasks's extension factory
      // emits the boot ping. A TaskCreate that runs in that gap threw
      // "subagents extension unavailable" and the task was stuck in
      // pending forever. Post-fix, the listener walks pending tasks on
      // subagents:ready and re-spawns each one whose lastError matches
      // the marker.
      if (!subagentsAvailable) {
        throw new Error(SUBAGENTS_UNAVAILABLE_MESSAGE);
      }
      // GC-2026-121 follow-up: tasks created BEFORE the Planner
      // agentType stamp shipped (or loaded from a pre-fix store file)
      // have kind=intent but no agentType. Default the spawn type to
      // Planner in that case so the unified feeder still consumes them.
      const explicitType = task.metadata.agentType;
      const type =
        typeof explicitType === "string" && explicitType.length > 0
          ? explicitType
          : task.metadata.kind === "intent"
            ? "Planner"
            : String(task.subject);

      const spawnOpts: Record<string, unknown> = {
        description: task.subject,
        isBackground: true,
      };
      // GC-2026-121 AC3: for the Planner agent, the spawn prompt must
      // include the originating user task's subject + description + id
      // so Planner can pass it to `decompose_task` without an extra
      // lookup. The subject is included as a fallback when description
      // is empty (the user often runs /tasks create "<subject>" without
      // --description; the subject alone is enough hint for Planner to
      // either produce specs or BLOCK).
      // Format:
      //   Subject: <subject>
      //   Description: <description>   (may be empty)
      //   Task ID: <id>
      //   Call `decompose_task(user_task_id="<id>", specs=[...])` to materialize the chain.
      let prompt = task.description;
      if (type === "Planner") {
        prompt =
          `Subject: ${task.subject}\n` +
          `Description: ${task.description}\n` +
          `Task ID: ${task.id}\n\n` +
          `Call \`decompose_task(user_task_id="${task.id}", specs=[...])\` to materialize the chain.`;
      }
      return spawnSubagent(type, prompt, spawnOpts);
    },
    agentTaskMap,
    onTaskChange: (taskId, status) => {
      if (status === "completed") {
        widget.setActiveTask(taskId, false);
        autoClear.trackCompletion(taskId, currentTurn);
      } else {
        widget.setActiveTask(taskId, false);
        autoClear.resetBatchCountdown();
      }
      widget.update();
    },
  });

    // ── Decompose-materialize RPC (GC-2026-task-feeding-and-decomposition AC3) ──
  // decompose_task (in pi-orchestrator) emits a request on this channel
  // with chain specs; this handler materializes the chain in the TaskStore,
  // spawns T1 (so the cascade can pick up the rest), and replies with chain
  // metadata on the reply channel.
  //
  // Channel constants are duplicated across packages (string literals) —
  // see pi-orchestrator/src/decompose-task.ts.
  pi.events.on(TASKS_RPC_DECOMPOSE_MATERIALIZE, async (raw: unknown) => {
    const payload = raw as { requestId?: unknown; params?: unknown };
    if (typeof payload.requestId !== "string" || !payload.params) return;
    const requestId = payload.requestId;
    const replyChannel = `tasks:rpc:decompose-materialize:reply:${requestId}`;
    try {
      const params = payload.params as {
        user_task_id?: string;
        specs: Array<{ subject: string; description: string; activeForm?: string }>;
      };
      const result = await materializeDecomposeChain(params);
      pi.events.emit(replyChannel, { success: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pi.events.emit(replyChannel, { success: false, error: message });
    }
  });

  async function materializeDecomposeChain(params: {
    user_task_id?: string;
    specs: Array<{ subject: string; description: string; activeForm?: string }>;
  }): Promise<{
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
  }> {
    if (!Array.isArray(params.specs) || params.specs.length < 1 || params.specs.length > 20) {
      throw new Error(`specs.length must be in [1, 20], got ${params.specs?.length}`);
    }
    for (let i = 0; i < params.specs.length; i++) {
      const spec = params.specs[i];
      if (!spec || typeof spec.subject !== "string" || spec.subject.length === 0) {
        throw new Error(`specs[${i}].subject is required`);
      }
      if (typeof spec.description !== "string" || spec.description.length < 10) {
        throw new Error(`specs[${i}].description must be ≥ 10 chars`);
      }
    }
    let userTask: Task | undefined;
    if (params.user_task_id !== undefined) {
      userTask = store.get(params.user_task_id);
      if (!userTask) throw new Error(`user_task_id ${params.user_task_id} not found`);
      if (userTask.metadata.created_by !== "user") {
        throw new Error(
          `user_task_id ${params.user_task_id} is not user-created (created_by=${userTask.metadata.created_by})`,
        );
      }
    }

    const created: Task[] = [];
    let reviewer: Task | undefined;
    const chainSubjects = params.specs.map((s) => s.subject);
    const chainDescriptions = params.specs.map((s) => s.description);
    // GC-2026-120 AC6: capture the user task's pre-state so we can roll it
    // back if the chain materialization throws after AC3's auto-complete
    // fires.
    let userTaskAutoCompleted = false;
    const priorUserTaskMetadata = userTask ? { ...userTask.metadata } : undefined;
    try {
      for (let i = 0; i < params.specs.length; i++) {
        const spec = params.specs[i];
        const baseMeta: Record<string, unknown> = {
          phase: "decomposition_chain",
          agentType: "Developer",
          created_by: "orchestrator",
          ...(userTask ? { user_task_ref: userTask.id } : {}),
        };
        if (i === 0) {
          // GC-2026-120 AC3: T1 is the chain head — no `blockedBy` on the
          // user task. The user task is auto-completed below, so T1's only
          // dependency is the feeder noticing `blockedBy === []` and
          // spawning. The old code's `blockedBy: userTask ? [userTask.id] : []`
          // created a deadlock: userTask had no agent to complete it.
          const out = createOrchestratorTaskWithReview(
            store,
            {
              subject: spec.subject,
              description: spec.description,
              activeForm: spec.activeForm,
              agentType: "Developer",
              blockedBy: [],
              metadata: baseMeta,
            },
            {
              kind: "decompose",
              parentSubject: spec.subject,
              parentDescription: spec.description,
              parentAgentType: "Developer",
              parentIteration: 1,
              chainSubjects,
              chainDescriptions,
              branch: "",
              ...(userTask ? { userTaskRef: userTask.id } : {}),
            },
          );
          created.push(out.task);
          reviewer = out.reviewer;
        } else {
          const task = createOrchestratorTask(store, {
            subject: spec.subject,
            description: spec.description,
            activeForm: spec.activeForm,
            agentType: "Developer",
            blockedBy: [created[i - 1].id],
            metadata: baseMeta,
          });
          created.push(task);
        }
      }

      // GC-2026-120 AC3: auto-complete the user task on successful chain
      // materialization. The user task was a record of intent; once it is
      // decomposed into actionable sub-tasks, it has served its purpose.
      // This eliminates the pre-GC deadlock where T1.blockedBy contained
      // userTask.id but no agent ever completed userTask.
      if (userTask) {
        store.update(userTask.id, {
          status: "completed",
          metadata: {
            ...userTask.metadata,
            completed_via: "decomposition",
            completed_at: new Date().toISOString(),
          },
        });
        userTaskAutoCompleted = true;
      }
    } catch (err) {
      // GC-2026-120 AC6: transactional rollback. Delete every chain task
      // (and the reviewer) created before the throw, and revert userTask
      // auto-completion if it already fired.
      for (const t of created) store.delete(t.id);
      if (reviewer) store.delete(reviewer.id);
      if (userTaskAutoCompleted && userTask && priorUserTaskMetadata) {
        store.update(userTask.id, {
          status: "pending",
          metadata: priorUserTaskMetadata,
        });
      }
      throw err;
    }

    let firstSpawned: { task_id: string; agent_id: string } | undefined;
    const t1 = created[0];
    if (t1) {
      // GC-2026-113 FU0 Phase 2b: delegate T1's first spawn to the
      // unified feeder. The feeder populates agentTaskMap + emits the
      // events the unified listener watches.
      // GC-2026-117: the legacy `decompose:spawn` event channel was removed;
      // the unified feeder's `subagents:completed` listener now handles
      // decompose-chain cascade via its generic `cascadeSpawn` walk (any
      // pending feedable task with satisfied blockers).
      // GC-2026-120 AC3: the prior `(!userTask || userTask.status === "completed")`
      // gate simplified — userTask is auto-completed above iff it existed.
      try {
        await feeder.maybeAutoSpawn(t1);
      } catch (spawnErr) {
        // AC6 extension: if the spawn RPC fails (e.g., subagents extension
        // not registered), the chain is still materialised — tasks are
        // persisted, just unowned. The caller can retry the spawn later
        // (e.g., via TaskExecute). Do NOT roll back the chain on a spawn
        // failure — that would discard work the user asked for.
        const message = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        // eslint-disable-next-line no-console
        console.error("[materializeDecomposeChain] T1 spawn failed:", message);
      }
      const afterT1 = store.get(t1.id);
      if (afterT1?.owner) {
        widget.setActiveTask(t1.id, true);
        firstSpawned = { task_id: t1.id, agent_id: afterT1.owner };
      }
    }

    const tasks = created.map((t, i) => ({
      task_id: t.id,
      subject: t.subject,
      reviewer_id: i === 0 ? reviewer?.id : undefined,
      is_top_level: i === 0,
    }));
    const user_task_chain = userTask
      ? [userTask.id, ...created.map((t) => t.id)]
      : undefined;

    return {
      status: "success",
      summary: `Decomposed into ${created.length} task(s); 1 Reviewer on T1. Chain will execute serially.`,
      tasks,
      ...(user_task_chain ? { user_task_chain } : {}),
      ...(firstSpawned ? { first_task_spawned: firstSpawned } : {}),
    };
  }

  // ── Decompose-chain cascade ──
  // Decompose-chain tasks (phase: "decomposition_chain") are cascaded by the
  // unified task-feeder registered above. The feeder's generic cascadeSpawn
  // walks all pending feedable tasks with satisfied blockers, which includes
  // decompose-chain tasks (their `blockedBy` edges are serial: T_i depends on
  // T_{i-1}; the chain head has no orchestrator-created predecessors so it
  // spawns immediately when materializeDecomposeChain calls
  // `feeder.maybeAutoSpawn(t1)`).
  //
  // Pre-GC-2026-114 FU3, a dedicated `registerDecomposeCascade` module owned
  // this responsibility. After FU3 the module was retired and the cascade
  // moved entirely into the feeder. The module itself is deleted as of
  // GC-2026-117 — the listener no longer exists in the source tree.

  // ── Context-scoped store initialization ──
  // Project paths cannot be resolved until an ExtensionContext is available.
  // Initialize on the first context-bearing event and reinitialize when a host
  // switches this extension instance to a session in another workspace.
  let configuredCwd: string | undefined;
  let persistedTasksShown = false;
  let agentsReattached = false;
  function initializeStoreForContext(ctx: ExtensionContext, reloadConfig = false) {
    // Keep the config object identity stable because the widget and auto-clear
    // manager retain references to it, but replace every value so overrides
    // from a previous workspace cannot leak into the next one.
    if (reloadConfig || configuredCwd !== ctx.cwd) {
      for (const key of Object.keys(cfg) as (keyof typeof cfg)[]) delete cfg[key];
      Object.assign(cfg, loadTasksConfig(ctx.cwd));
      taskScope = cfg.taskScope ?? "session";
    }

    // `pi --no-session` mints a session ID but never a session file. Keying off the
    // ID alone would write tasks-<id>.json for a session that can never be resumed
    // and is orphaned the moment pi exits: if pi is not persisting the conversation,
    // don't persist the task list either.
    const sessionId = isSessionScope() && !piTasks && ctx.sessionManager.getSessionFile()
      ? ctx.sessionManager.getSessionId()
      : undefined;
    const nextTarget = resolveStoreTarget(ctx.cwd, sessionId);
    if (nextTarget.key !== storeTarget.key) {
      store = new TaskStore(nextTarget.path);
      widget.setStore(store);
      storeTarget = nextTarget;
      // The new store owns a different task list, so the agent map has to be
      // rebuilt from it rather than kept from the previous one.
      agentsReattached = false;
    }
    configuredCwd = ctx.cwd;
  }

  /** Delete an emptied session file, and — under `session-global` only — the
   *  directory that held it once its last session is gone. Nothing else is ours
   *  to reclaim: a PI_TASKS path can point anywhere, and `<workspace>/.pi/tasks/`
   *  is left standing exactly as it always has been. */
  function deleteSessionFileIfEmpty() {
    if (!store.deleteFileIfEmpty()) return;
    if (taskScope === "session-global" && !piTasks && configuredCwd) {
      reclaimGlobalSessionTasksDir(configuredCwd);
    }
  }

  /** Re-link persisted in-progress tasks to the subagents still running for them.
   *  `agentTaskMap` lives only in this extension instance, so a reload starts empty
   *  while the agents keep going — their completion events would then be dropped and
   *  the tasks would stay in_progress forever. Everything needed is already on disk:
   *  GC-2026-113's unified task feeder stores the agent ID on `task.owner` (set
   *  by the feeder's `spawnAndTrack` after a successful spawn). The legacy path
   *  also recorded `metadata.agentId`; we read both for backward compat.
   *
   *  Only in_progress tasks are relinked. A task reverted to pending keeps its
   *  `owner` / `metadata.agentId`, and relinking that would let a late event
   *  resurrect work the user has already reset. Only runs once — the first caller wins. */
  function reattachAgents() {
    if (agentsReattached) return;
    agentsReattached = true;
    for (const task of store.list()) {
      if (task.status !== "in_progress") continue;
      // GC-2026-113 FU0 Phase 2b: prefer `task.owner` (set by the
      // unified feeder); fall back to `metadata.agentId` for tasks
      // spawned by the legacy `TaskExecute` tool path.
      const agentId =
        typeof task.owner === "string" && task.owner
          ? task.owner
          : typeof task.metadata?.agentId === "string"
            ? task.metadata.agentId
            : undefined;
      if (agentId) {
        agentTaskMap.set(agentId, task.id);
      }
    }
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (isSessionScope()) deleteSessionFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking (for autoClear's "completed N turns ago" math) ──
  // GC-2026-system-reminder-remove: the cadence module used to track
  // currentTurn too, but with the reminder mechanism removed we only need
  // a counter for autoClear's per-task linger window. Keep it local here
  // so autoClear doesn't have to import reminder-cadence.
  let currentTurn = 0;

  // GC-2026-120 AC5 + follow-up + GC-2026-122 + GC-2026-continuous-intent-reminder:
  // per-intent decomposition reminder. GC-2026-122 fixed the transport
  // (system-prompt injection, not `ctx.ui.notify`). GC-2026-continuous-
  // intent-reminder dropped the per-session `remindedIds` dedup so the
  // reminder keeps firing on every `before_agent_start` until the
  // intent is consumed (auto-completed by `materializeDecomposeChain`
  // or marked completed by the LLM via `TaskUpdate`). The reminder is
  // composed by `pi-tasks/src/intent-reminder.ts` and injected into
  // the LLM's system prompt via the `before_agent_start` handler's
  // return value (see the `pi.on("before_agent_start", ...)` block
  // further down). No caller-side state needed — the predicate is
  // `status === "pending" && kind === "intent"`, evaluated fresh each
  // call against the live store.

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn += 1;
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    if (autoClear.onTurnStart(currentTurn)) {
      if (isSessionScope()) deleteSessionFileIfEmpty();
      widget.update();
    }
  });

  // The end of a run is the only signal that separates a new batch of tasks from the
  // same batch still being built — the store looks identical either way. Nothing is
  // cleared here; this only marks the boundary for the next TaskCreate.
  pi.on("agent_settled", async () => {
    autoClear.onRunEnded();
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
  });

  // session_start replaces the never-emitted session_switch event. Rehydrating
  // here matters because before_agent_start only fires once the user prompts.
  pi.on("session_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const reason = event.reason;
    // new/resume/fork reuse the running extension instance (getExtensions() is
    // cached), so session-scoped state must be reset. startup/reload re-run the
    // factory and start clean.
    const isSwitch = reason === "new" || reason === "resume" || reason === "fork";
    // A fork branches the conversation, so its tasks carry over as an independent
    // copy. Snapshot before the store re-points to the new (empty) session file.
    const forkSeed = reason === "fork" ? store.snapshot() : undefined;
    if (isSwitch) {
      persistedTasksShown = false;
      agentsReattached = false;
      // GC-2026-continuous-intent-reminder: no per-session reminder
      // state to reset — the reminder is stateless and reads the live
      // store on every `before_agent_start`. The reminder naturally
      // re-surfaces any pending intent on the first turn of a new
      // session without explicit reset.
      // Task IDs restart at 1 in every session, so a mapping held over from the
      // previous one points at an unrelated task here — the agent's completion would
      // close a task it never ran. reattachAgents() rebuilds what this session owns.
      agentTaskMap.clear();
      autoClear.reset();
      // Memory mode has no file to switch — clear tasks explicitly on /new.
      if (reason === "new" && taskScope === "memory") {
        store.clearAll();
      }
    }

    initializeStoreForContext(ctx, true);
    if (forkSeed?.tasks.length) store.seed(forkSeed); // carry the parent's tasks into the fork
    reattachAgents(); // subagents outlive a reload; relink them before events arrive
    // resume/reload/fork keep tasks; startup/new auto-clear an all-completed list.
    const keepsTasks = reason === "reload" || reason === "resume" || reason === "fork";
    showPersistedTasks(keepsTasks);
    // Those tasks are shown for review, but the run that produced them ended with the
    // session before this one — so the next batch must not be added to them either.
    if (keepsTasks) autoClear.onRunEnded();

    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Fallback for hosts that init UI lazily. Guarded by persistedTasksShown, so
  // it never double-renders after session_start.
  //
  // GC-2026-122: the reminder now reaches the LLM via the handler's
  // return value (`{ systemPrompt: ... }`), not `ctx.ui.notify` (which
  // is UI-level and invisible to the LLM). The pattern mirrors
  // `pi-orchestrator/src/extension.ts:215-226`. If no new intent tasks
  // are pending, the handler returns undefined (no system-prompt change).
  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    reattachAgents();
    showPersistedTasks();
    const existingSystemPrompt =
      typeof event === "object" && event !== null && "systemPrompt" in event
        ? (event as { systemPrompt?: string }).systemPrompt
        : undefined;
    const reminderResult = applyIntentReminderToSystemPrompt(
      store,
      existingSystemPrompt,
    );
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
    return reminderResult;
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated). Create them all in one response with one TaskCreate call per task
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include \`agentType\` (e.g., "general-purpose", "Explore") to mark tasks for subagent execution via TaskExecute
- To create several tasks at once, call TaskCreate multiple times in a single response — independent tool calls run in parallel, so the whole batch is created in one turn (one task per call).`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({
        description: "Agent type for subagent execution (e.g., 'Developer', 'Explore'). With agentType set, the task is kind=actionable and the unified task-feeder auto-spawns a subagent. Without agentType, the task is kind=intent (planning data) — the assistant must decompose it via decompose_task or claim it via TaskUpdate when starting work.",
      })),
      kind: Type.Optional(Type.Unsafe<"intent" | "actionable">({
          description: "GC-2026-120 AC1/AC2. Optional override for the inferred kind. Defaults to actionable if agentType is set, otherwise intent. step is reserved for orchestrator-internal tasks (decompose chain) — pass it only via createOrchestratorTask, not here.",
      })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
      created_by: Type.Optional(
        Type.Unsafe<"orchestrator" | "user">({
          description: 'GC-2026-task-feeding-and-decomposition (D1): task source provenance. "orchestrator" routes through the helper (no auto-Reviewer); "user" (default) creates the task directly.',
          default: "user",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // A finished list must not collect the batch that follows it. The turn countdowns
      // cannot be relied on for that: they only tick at `turn_start`, so a run that ends
      // right after its last completion freezes one mid-count.
      autoClear.startNewBatch();
      const meta = params.metadata ?? {};
      if (params.agentType) meta.agentType = params.agentType;
      // GC-2026-120 AC1/AC2: optional explicit kind override. The store
      // infers kind from created_by + agentType when this is omitted.
      if (params.kind) meta.kind = params.kind;
      const task = store.create(params.subject, params.description, params.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
      widget.update();
      // GC-2026-113 FU0 Phase 2b: unified feeder auto-spawns feedable
      // tasks. We `await` (not `void`) so the TaskCreate tool doesn't
      // return until the spawn RPC has at least populated task.owner.
      // Without this, downstream tools like TaskOutput that look up
      // `task.owner` immediately after TaskCreate race the spawn.
      await feeder.maybeAutoSpawn(task);
      // GC-2026-120 AC1: surface a hint when the assistant created a
      // kind=intent task without an explicit decomposition route. The
      // assistant is expected to follow up with decompose_task.
      const hint =
        task.metadata.kind === "intent"
          ? " — intent task; decompose via decompose_task or claim via TaskUpdate."
          : "";
      return textResult(
        `Task #${task.id} created successfully: ${task.subject}${hint}`,
        { id: task.id, task },
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      lines.push(`Description: ${desc}`);

      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      // Show metadata if non-empty
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      // GC-2026-113 FU0 Phase 2b: capture the prior agentType so we can
      // detect an add/change and trigger the unified feeder once.
      const prior = store.get(taskId);
      const priorAgentType =
        prior && typeof prior.metadata?.agentType === "string"
          ? prior.metadata.agentType
          : "";
      const { task, changedFields, warnings } = store.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return textResult(`Task #${taskId} not found`);
      }

      // Update widget active task tracking
      if (fields.status === "in_progress") {
        widget.setActiveTask(taskId);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "pending") {
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
        if (fields.status === "completed") autoClear.trackCompletion(taskId, currentTurn);
      }

      // GC-2026-113 FU0 Phase 2b: if metadata.agentType was added (was
      // empty, now non-empty) or changed (different non-empty value),
      // the task just became feedable. Trigger the unified feeder.
      //
      // GC-2026-115: `await` (not `void`) so the spawn RPC completes
      // before the tool returns. Without this, a followup TaskOutput
      // call from the LLM races the spawn: task.owner is still
      // undefined when TaskOutput reads it, and TaskOutput errors
      // with "No background process".
      const newAgentType =
        task && typeof task.metadata?.agentType === "string"
          ? task.metadata.agentType
          : "";
      if (
        task &&
        task.status === "pending" &&
        newAgentType.length > 0 &&
        newAgentType !== priorAgentType
      ) {
        await feeder.maybeAutoSpawn(task);
      }

      widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      return textResult(msg);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;
      // Reject an empty id up front: every agent ID starts with "", so the prefix
      // match below would resolve it to whichever agent the map yields first.
      if (!task_id) throw new Error("task_id is required");

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs (resolve agent ID → task ID)
        let resolvedId = task_id;
        if (!store.get(resolvedId)) {
          // Check if this is an agent ID mapped to a task
          for (const [agentId, taskId] of agentTaskMap) {
            if (agentId === task_id || agentId.startsWith(task_id)) { resolvedId = taskId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        // GC-2026-113 FU0 Phase 2b: the unified feeder sets the agent
        // ID on `task.owner` (and also on `task.metadata.agentId` for
        // legacy TaskExecute-spawned tasks). Either signals "this is a
        // subagent task".
        const subagentId: string | undefined =
          (typeof task.owner === "string" && task.owner) ||
          (typeof task.metadata?.agentId === "string" ? task.metadata.agentId : undefined);
        if (subagentId) {
          // Subagent task — wait for completion if blocking
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, timeout ?? 30000);
              const cleanup = () => { clearTimeout(timer); resolve(); };
              const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
                if ((d as any).id === subagentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
                if ((d as any).id === subagentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              // Re-read before committing to the wait. Nothing awaits since the outer
              // check, so this only differs on a shared file-backed list, where
              // store.get() reloads and another session may have finished the task.
              const current = store.get(resolvedId);
              if (current && current.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
              signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
            });
          }
          // Re-read by resolved ID — `task` predates the wait, and a file-backed
          // store deserializes a fresh object on every load, so it is stale here.
          const updated = store.get(resolvedId) ?? task;
          // GC-2026-113 FU0 Phase 2b: agent ID lives on `task.owner`
          // (preferred) or `task.metadata.agentId` (legacy TaskExecute
          // path). The earlier `if (subagentId)` guard ensures
          // `updated.owner || updated.metadata.agentId` is defined here.
          const agentId: string = subagentId;
          // Consume only what is actually handed over: the agent has reported back
          // (it leaves the map when it does) and the task carries its outcome. Short
          // of both — still running, or an update that never landed — the model is
          // getting a status, and the notification pi-subagents is holding is the
          // only thing that will announce the result.
          if (!agentTaskMap.has(agentId) && updated.status !== "in_progress") consumeSubagentResult(agentId);
          const output = updated.metadata?.result
            ?? (updated.metadata?.lastError ? `Error: ${updated.metadata.lastError}` : undefined);
          return textResult(
            `Task #${resolvedId} [${updated.status}] — subagent ${agentId}${output ? `\n\n${output}` : ""}`,
          );
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs
        let resolvedId = taskId;
        if (!store.get(resolvedId)) {
          for (const [agentId, tId] of agentTaskMap) {
            if (agentId === taskId || agentId.startsWith(taskId)) { resolvedId = tId; break; }
          }
        }
        const task = store.get(resolvedId);
        // GC-2026-113 FU0 Phase 2b: the unified feeder sets the agent
        // ID on `task.owner` (preferred) or `task.metadata.agentId`
        // (legacy TaskExecute path). Either signals "this is a subagent
        // task that's safe to stop".
        const subagentId: string | undefined =
          (typeof task?.owner === "string" && task.owner) ||
          (typeof task?.metadata?.agentId === "string" ? task.metadata.agentId : undefined);
        if (subagentId && task?.status === "in_progress") {
          store.update(resolvedId, { status: "completed" });
          autoClear.trackCompletion(resolvedId, currentTurn);
          await stopSubagent(subagentId);
          widget.setActiveTask(resolvedId, false);
          widget.update();
          return textResult(`Task #${resolvedId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      store.update(taskId, { status: "completed" });
      autoClear.trackCompletion(taskId, currentTurn);
      widget.setActiveTask(taskId, false);
      widget.update();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable (@tintinweb/pi-subagents not loaded " +
          "or version mismatch). You can run these as plain Agent-tool spawns, but pi-tasks " +
          "won't track them — status stays pending, cascade won't fire, TaskOutput stays empty."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];

      for (const taskId of params.task_ids) {
        const task = store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        // Check all blockers are completed
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return !blocker || blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          results.push(`#${taskId}: blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
          continue;
        }

        // GC-2026-113 FU0 Phase 2b: delegate to the unified task feeder.
        // The feeder owns the spawn + agentTaskMap population. The
        // additional_context / model / max_turns options are plumbed
        // through via the prompt (buildTaskPrompt appends
        // additional_context) and the spawn options below.
        const before = store.get(taskId);
        try {
          await feeder.maybeAutoSpawn(task);
          const after = store.get(taskId);
          if (after?.owner) {
            launched.push(`#${taskId} → agent ${after.owner}`);
            widget.setActiveTask(taskId);
          } else if (after?.metadata?.lastError) {
            // Spawn failed inside the feeder; surface to caller.
            results.push(`#${taskId}: spawn failed — ${after.metadata.lastError}`);
          } else if (before === after) {
            // Feeder skipped the spawn (e.g. blockers changed mid-flight).
            results.push(`#${taskId}: not dispatched (status: ${after?.status ?? "unknown"})`);
          }
        } catch (err: any) {
          debug(`spawn:error task=#${taskId}`, err);
          results.push(`#${taskId}: spawn failed — ${err.message ?? String(err)}`);
        }
      }

      // GC-2026-113 FU0 Phase 2b: cascade is unconditional via the unified
      // feeder. No cascadeConfig to maintain here.

      widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed. Subcommand: /tasks create \"<subject>\" [--description \"...\"] [--agent-type T]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      latestCtx = ctx;
      widget.setUICtx(ctx.ui as UICtx);
      initializeStoreForContext(ctx);
      const ui = ctx.ui;

      // GC-2026-task-feeding-and-decomposition (AC6): route the `create`
      // subcommand to a no-UI arg parser. Empty args fall through to the
      // existing interactive menu (back-compat).
      const trimmed = args.trim();
      if (trimmed.startsWith("create")) {
        await handleCreateCommand(trimmed.slice("create".length).trim(), ui);
        return;
      }

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
          if (isSessionScope()) deleteSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (isSessionScope()) deleteSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const glyphs = resolveTaskGlyphs(cfg.glyphs);
        const statusGlyph = (status: string) => {
          switch (status) {
            case "completed": return glyphs.completed;
            case "in_progress": return glyphs.inProgress;
            default: return glyphs.pending;
          }
        };

        const choices = tasks.map(t =>
          `${statusGlyph(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Matched by row position rather than parsed out of the label: both the glyph
        // and the subject are free text, and either can contain something like "#42".
        const picked = tasks[choices.indexOf(selected)];
        if (picked) await viewTaskDetail(picked.id);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          store.update(taskId, { status: "in_progress" });
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          store.update(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY, ctx.cwd);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks create (arg-style subcommand)
  // ──────────────────────────────────────────────────

  /**
   * Minimal shell-style parser: captures the first quoted token as `subject`,
   * then walks remaining `--flag "value"` (or `--flag value`) pairs.
   *
   * The parser is intentionally narrow — complex shell syntax (nested quotes,
   * escaped characters, env expansion) is out of scope. Users with complex
   * inputs should call the LLM-facing TaskCreate tool via chat.
   */
  function parseCreateArgs(
    raw: string,
  ): {
    subject?: string;
    description?: string;
    agentType?: string;
    kind?: "intent" | "actionable" | "step";
    decomposeSpec?: string;
    flags: Set<string>;
  } {
    const out: {
      subject?: string;
      description?: string;
      agentType?: string;
      kind?: "intent" | "actionable" | "step";
      decomposeSpec?: string;
      flags: Set<string>;
    } = { flags: new Set() };
    let rest = raw.trim();
    // First quoted token → subject.
    const subjectMatch = rest.match(/^"([^"]*)"/);
    if (subjectMatch) {
      out.subject = subjectMatch[1];
      rest = rest.slice(subjectMatch[0].length).trim();
    } else {
      const untilSpace = rest.match(/^(\S+)/);
      if (untilSpace) {
        out.subject = untilSpace[1];
        rest = rest.slice(untilSpace[0].length).trim();
      }
    }
    // Walk --flag [value] pairs.
    while (rest.length > 0) {
      const flagMatch = rest.match(/^--([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(?:"([^"]*)"|(\S+)))?/);
      if (!flagMatch) {
        // Unknown token — skip silently (lenient).
        rest = rest.replace(/^\S+/, "").trim();
        continue;
      }
      const flag = flagMatch[1];
      const value = flagMatch[2] ?? flagMatch[3];
      out.flags.add(flag);
      if (flag === "description" && value !== undefined) out.description = value;
      if (flag === "agent-type" && value !== undefined) out.agentType = value;
      // GC-2026-120: --kind is the user-facing knob (AC1/AC2). `step`
      // is orchestrator-internal — accept the literal for forward
      // compatibility but do not propagate (orchestrators always stamp
      // via createOrchestratorTask).
      if (
        flag === "kind" &&
        (value === "intent" || value === "actionable" || value === "step")
      ) {
        if (value !== "step") out.kind = value;
      }
      // GC-2026-120 AC4: --decompose-spec triggers inline materialization.
      if (flag === "decompose-spec" && value !== undefined) out.decomposeSpec = value;
      rest = rest.slice(flagMatch[0].length).trim();
    }
    return out;
  }

  /**
   * Parse a `--decompose-spec` value into chain specs.
   *
   * Format: `"T1:subject|T1 description;T2:subject|T2 description;..."`.
   * The pipe separates subject from description; semicolons separate entries.
   * Whitespace is trimmed. Trailing/empty entries are ignored.
   *
   * Throws on entries missing the pipe, subject, or description.
   *
   * GC-2026-120 AC4: this is the inline-spec parser that lets the user
   * decompose without a chat round-trip.
   */
  function parseDecomposeSpec(
    raw: string,
  ): Array<{ subject: string; description: string }> {
    const out: Array<{ subject: string; description: string }> = [];
    for (const entry of raw.split(";")) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const pipeAt = trimmed.indexOf("|");
      if (pipeAt < 0) {
        throw new Error(`decompose-spec entry missing '|': "${trimmed}"`);
      }
      const subject = trimmed.slice(0, pipeAt).trim();
      const description = trimmed.slice(pipeAt + 1).trim();
      if (subject.length === 0) {
        throw new Error(`decompose-spec entry missing subject: "${trimmed}"`);
      }
      if (description.length === 0) {
        throw new Error(`decompose-spec entry missing description: "${trimmed}"`);
      }
      out.push({ subject, description });
    }
    return out;
  }

  async function handleCreateCommand(
    rawArgs: string,
    ui: { notify: (msg: string, kind?: "info" | "warning" | "error") => void },
  ): Promise<void> {
    if (rawArgs.length === 0) {
      ui.notify(
        'Usage: /tasks create "<subject>" [--description "..."] [--agent-type T] [--kind intent|actionable] [--decompose-spec "T1:s|T1 d;T2:s|T2 d"]',
        "warning",
      );
      return;
    }
    const parsed = parseCreateArgs(rawArgs);
    // Reject --decompose explicitly (AC6 / historical). The flag is parsed
    // as a known unknown; we surface a clear warning rather than silently
    // ignore. (--decompose-spec is the new GC-2026-120 inline path.)
    if (parsed.flags.has("decompose")) {
      ui.notify(
        "--decompose is not exposed. Decomposition is chat-driven (LLM calls the decompose_task tool) — or use --decompose-spec for inline decomposition.",
        "warning",
      );
      return;
    }
    if (!parsed.subject || parsed.subject.length === 0) {
      ui.notify("Task subject is required.", "warning");
      return;
    }

    // GC-2026-120 AC4: --decompose-spec triggers immediate inline
    // decomposition. The user task becomes the user_task_ref root of the
    // chain. materializeDecomposeChain auto-completes the user task on
    // success — see AC3.
    if (parsed.decomposeSpec) {
      let specs: Array<{ subject: string; description: string }>;
      try {
        specs = parseDecomposeSpec(parsed.decomposeSpec);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.notify(`decompose-spec parse error: ${msg}`, "error");
        return;
      }
      if (specs.length < 1) {
        ui.notify("decompose-spec must contain at least one entry.", "error");
        return;
      }
      // Create the user task first so we have a user_task_id to attach.
      const userTask = store.create(parsed.subject, parsed.description ?? "", undefined, {
        created_by: "user",
      });
      widget.update();
      try {
        const result = await materializeDecomposeChain({
          user_task_id: userTask.id,
          specs,
        });
        ui.notify(
          `Task #${userTask.id} decomposed into ${result.tasks.length} subtask(s); chain is executing.`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.notify(`decomposition failed: ${msg}`, "error");
      }
      return;
    }

    const task = store.create(
      parsed.subject,
      parsed.description ?? "",
      undefined,
      {
        created_by: "user",
        ...(parsed.kind ? { kind: parsed.kind } : {}),
        ...(parsed.agentType ? { agentType: parsed.agentType } : {}),
      },
    );
    widget.update();
    // GC-2026-113 FU0 Phase 2b: await the auto-spawn so task.owner
    // is populated by the time /tasks create returns (avoids race with
    // followup TaskOutput / TaskUpdate calls).
    await feeder.maybeAutoSpawn(task);
    ui.notify(`Task #${task.id} created: ${task.subject}`, "info");
  }
}

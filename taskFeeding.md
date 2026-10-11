# Task Feeding — design summary

## Overview

Task Feeding is the workflow that ties the three Sages packages
together: `pi-tasks/` (the persistent task board), `pi-orchestrator/`
(the LLM-driven orchestrator in the main session), and
`pi-subagents/` (the worker that runs a single task at a time).

The flow is a closed loop: the orchestrator appends tasks to the
board, the board dispatches each ready task to a subagent, the
subagent reports the result back through the event bus, and the
orchestrator consumes the result and decides what to do next.

## The three roles

| Role | Package | What it owns |
|---|---|---|
| **Task Board** | `pi-tasks/` | The persistent file store (under `ORCHESTRATOR_WORKDIR`, see below) + the widget above the editor. Holds the DAG, emits lifecycle events, but never decides shape. |
| **Task Orchestrator** | `pi-orchestrator/` (you) | The LLM in the main session. The **sole writer** that appends new tasks to the board, and the **sole consumer** that reads them. |
| **Task Executor** | `pi-subagents/` | The worker. Spawned by the orchestrator via the board, runs a subagent session, reports the result back. Does not see the board. |

These role names are descriptive shorthand. No package calls itself by
that name in its own code; they exist for docs and conversation.

## The loop

```
Task Orchestrator (LLM, main session)
        │
        │ 1. append task(s) to the board
        │    (TaskCreate × N, or orchestrate(plan) for the standard shape)
        ▼
Task Board (pi-tasks, file-backed TaskStore)
        │
        │ 2. ready tasks surface as the widget's running list
        │ 3. TaskExecute on the first ready task spawns the Executor
        ▼
Task Executor (pi-subagents, spawned subagent session)
        │
        │ 4. runs the work, returns its result as plain text
        │    (4-state verdict for Reviewer: CLEAN / NEEDS_WORK /
        │     NEEDS_REDESIGN / NEEDS_CLARIFICATION)
        ▼
Task Board emits subagents:completed { id, result }
        │
        │ 5. board marks the task completed, stashes the result
        │    in task.metadata.result
        ▼
Task Orchestrator reads the result via TaskOutput,
        │
        │ 6. decides: declare done, spawn another task, or fix
        └────► (back to step 1)
```

## The boundary — single creator, single consumer

Only the Task Orchestrator:

- **Creates** tasks (`TaskCreate`, or `orchestrate(plan)` as the
  batch-DAG shortcut)
- **Updates** tasks (`TaskUpdate` for status, dependencies, metadata)
- **Reads** task results (`TaskOutput`, or the in-place
  `subagents:completed` event)

The Task Executor:

- **Does not** have `TaskCreate` / `TaskUpdate` / `TaskOutput` /
  `orchestrate` in its tool allowlist
- **Does not** see the board at all
- Reports its result as plain text in its own session output; the
  board only sees the final transcript

The Task Board:

- **Does not** call subagents directly under normal operation. The
  exception is `autoCascade: true`, where the board fans out
  newly-unblocked dependents whose `agentType` is set. The shape of
  the DAG is still owned by the orchestrator (it pre-created every
  task via `TaskCreate`); the board only chooses *when* to spawn.
- For strict "orchestrator consumes every completion" behavior, leave
  `autoCascade: false` and let the orchestrator call `TaskExecute`
  explicitly after each completion.

## How the boundary is enforced

The orchestrator's toolset is curated at `session_start` in
`pi-orchestrator/src/extension.ts` via `pi.setActiveTools(...)`. The
allowed set is:

- `PI_TASKS_TOOLS` (7): `TaskCreate`, `TaskList`, `TaskGet`,
  `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute`
- `SUBAGENT_TOOLS` (7): `Agent`, `get_subagent_result`,
  `steer_subagent`, `subagent_status`, `subagent_steer`,
  `subagent_abort`, `subagent_resume`
- `AFT_TOOLS` (11): the indexed code-search suite
- `BASELINE_TOOLS` (7): `bash`, `read`, `edit`, `write`, `grep`,
  `find`, `ls`

A subagent spawned by `Agent` / `TaskExecute` does NOT see the
PI_TASKS_TOOLS — its tool allowlist is scoped at spawn time. So a
Task Executor cannot bypass the boundary by guessing tool names; the
host enforces the partition.

## Where the board lives

Every sages workspace has its own task store, kept outside the
repository so `.pi/` never accumulates project state:

```
${ORCHESTRATOR_WORKDIR}/${projectKey(cwd)}/tasks/tasks.json
```

Where:

- **`ORCHESTRATOR_WORKDIR`** is an env var. Defaults to
  `<tmpdir>/sages-orchestrator`. One root directory holds every
  sages workspace's orchestrator state (task store, brainstorming
  design drafts, anything else that needs to survive across sessions
  without leaking into the repo).
- **`projectKey(cwd)`** is the same path-encoded identifier pi-tasks
  uses for its `session-global` scope:
  `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`.
  Two workspaces with the same basename (e.g. two `/.../foo`)
  produce different keys because the full path is part of the key.

The resolver lives in `pi-tasks/src/task-paths.ts` as
`orchestratorProjectTaskFile(cwd)`. Both surfaces use it:

- The orchestrator's `orchestrate(plan)` tool goes through
  `tasksStorePath(cwd) → orchestratorProjectTaskFile(cwd)`.
- The board's own `taskScope: "project"` mode goes through the same
  function in `resolveStoreTarget`.

This means `orchestrate` writes and `TaskCreate` writes land on the
same file — the LLM's `TaskList` shows what `orchestrate` just
created, and vice versa. The two `TaskStore` instances (orchestrator's
and the board's) coordinate through the file lock in
`pi-tasks/src/task-store.ts` (`<pid>:<uuid>` token, atomic temp-file
rename), so concurrent writes are safe.

## How the orchestrator reaches the board

Two parallel paths, both wired at extension boot:

**Path 1 — via the LLM's tool surface.** The LLM in the main session
calls `TaskCreate` etc. directly. Three things have to be true:
`pi-tasks/src/index.ts` registers the tool handlers (it owns the
implementation); `pi-orchestrator/src/extension.ts` calls
`pi.setActiveTools([...])` at `session_start` to whitelist them for
the LLM; pi routes the call to the board's handler. The orchestrator
is purely a curator of the LLM's view here, not an implementer.

**Path 2 — via direct file write.** The orchestrator's
`orchestrate(plan)` tool imports `TaskStore` from
`@sages/pi-tasks/task-store` and instantiates its own store at the
same path. The orchestrator and the board share **the file**, not an
instance. The file-lock protocol in `pi-tasks/src/task-store.ts`
keeps their concurrent writes safe.

```
LLM ─► pi (route) ─► pi-tasks TaskCreate handler ─► TaskStore.create()
 ◄───────────────────────────────────────────────
                                                  │
orchestrator orchestrate() ─► new TaskStore(...) ─┘ (same file, file-locked)
```

## Subtle interactions

**Auto-cascade.** When `autoCascade: true`, the board itself spawns
newly-unblocked dependents with `agentType` set (see
`pi-tasks/src/index.ts` ~lines 311–335). This looks like the board is
dispatching executors, but the shape of the DAG is still implicit in
the orchestrator's earlier `TaskCreate` calls. For the strict
"orchestrator consumes every completion" model, turn auto-cascade off
and let the orchestrator call `TaskExecute` explicitly.

**Completion side-effect updates.** The board updates task status
(`store.update(taskId, { status: "completed", metadata: { result } })`)
when the executor reports back. That is state mutation, not task
creation, so the single-creator rule still holds.

**4-state verdict.** The Reviewer agent emits one of CLEAN /
NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION as plain text in
its result. The orchestrator reads it via `TaskOutput` and decides
next step. This is the Reviewer agent's contract, not a board feature.

## Executor side — how the subagent actually runs

When the board's `TaskExecute` fires, it walks through the executor
runtime in `pi-subagents/`:

```
LLM TaskExecute
        │
        │  pi.events.emit("subagents:rpc:spawn", { type, prompt, options })
        ▼ (30s timeout, PROTOCOL_VERSION = 2)
pi-subagents AgentManager.spawn(pi, ctx, type, prompt, options)
        │
        ├─ create AgentRecord (random 17-char id, handle, lifetimeUsage=0)
        ├─ poolFor(record) → "background" | "foreground" | undefined
        ├─ if pool full → queue (startGate promise, release on drain)
        │   else → launch(id, record, args, undefined)
        ▼
launch → startAgent(id, record, args)
        │
        ├─ re-validate cwd (queued spawns: TOCTOU against removed dir)
        ├─ claim pool slot (BEFORE first await, so the queue drain
        │   can't start everyone while the first is still copying)
        ├─ if isolation === "worktree":
        │     createWorktree(pi, baseCwd, id)
        │     → /tmp/pi-agent-{id}-{uuid} detached at HEAD,
        │       branch pi-agent-{id}
        ├─ wire parent abort signal → record.abortController
        ▼
runAgent(ctx, type, prompt, options)
        │
        ├─ getConfig(type) → builtinToolNames, extensions, skills, prompts
        ├─ build system prompt (config.systemPrompt + memory block +
        │  parent context if inheritContext, etc.)
        ├─ DefaultResourceLoader.reload() — discover extensions / skills
        │  (in a child session context; this extension doesn't re-enter)
        ├─ createAgentSession({ cwd, model, tools, excludeTools, ... })
        ├─ session.bindExtensions() — fires extensions' session_start
        ├─ installExtensionToolScope() — live filter for ext: narrowing
        ├─ session.prompt(effectivePrompt) — the actual model call
        │  (turn-count tracking enforces max_turns at the agent level)
        ▼ (settle, success)
record.status = completed | steered
record.result = responseText
record.completedAt = Date.now()
        │
        ├─ if worktree used: cleanupWorktree() → if changes, create
        │  branch pi-agent-{id}-{ts}, commit with --no-verify
        ├─ abortOwnedChildren(parentId) — nested children die with parent
        ├─ settleRun(record, true, pool) — decrement pool, drain queue,
        │  call onComplete
        ▼
onComplete(record)
        │
        │  pi.events.emit("subagents:completed", { id, result })
        │  (or "subagents:failed" / no-emit on stopped)
        ▼
pi-tasks subagents:completed listener
        │
        └─ store.update(taskId, { status: "completed",
           metadata: { ...task.metadata, result } })
           then maybe cascade
```

Three layers of pool enforcement:

- **Background pool** (`maxConcurrent = 10` by default) — what
  `TaskExecute` uses for `isBackground: true` spawns.
- **Foreground pool** (`maxConcurrentForeground = 0` by default — off)
  — what `spawnAndWait` charges against.
- **Queue** — when a pool is full, the record flips to `"queued"` with
  a `startGate` promise that resolves on drain. A drain slot is freed
  by `settleRun` (decrement → `drainQueue` → next entry's `start`).

The cross-extension RPC uses scoped reply channels:

```
pi-tasks  ──emit("subagents:rpc:spawn", { requestId, type, prompt, options })──►  pi-subagents
pi-tasks  ◄──emit("subagents:rpc:spawn:reply:{requestId}", { success, data }) ──  pi-subagents
```

`requestId` is a UUID minted by the caller and echoed in the reply
channel. `pi-tasks/src/index.ts:rpcCall()` waits up to 30s for the
reply and unwraps `RpcReply<T>` (`{ success, data? } | { success:
false, error }`). The handshake on boot is `subagents:rpc:ping` —
pi-subagents replies with `{ version: PROTOCOL_VERSION: 2 }`; a
mismatch sets `pendingWarning` (notified at session start).

A side-channel called `consume` exists for callers that have already
shown the model an agent's result. After `TaskOutput` reads one, it
emits `subagents:rpc:consume { agentId }`; pi-subagents suppresses the
follow-up completion notification that would otherwise arrive on top
of the inline read and cost the parent a turn. Deliberately outside
the ping version handshake: an older pi-subagents without the handler
keeps notifying, exactly as before.

## Brainstorming → board handoff

The `/brainstorm` slash command is a 5-phase state machine in
`pi-orchestrator/src/brainstorming/{index,state,types}.ts`. Each
phase produces a `BrainstormResponse` the LLM surfaces to the user;
the user drives the state forward with prose (yes/proceed, defer,
exit).

```
exploring           clarifying              proposing
   │                    │                     │
   │ discoverProject-   │ ask ONE question    │ propose 2-3
   │ Context(cwd)       │ at a time, with     │ approaches with
   │ (lang, framework,  │ recommended answer  │ tradeoffs and
   │ existing files)    │ (grill-me)          │ recommendation
   │                    │                     │
   └──────  LLM proposes design  ──────────────┘
                          │
                       designing              approved
                          │   user approves each
                          │   section, one at a time
                          │
                          └────  finalizeDesign()  ─────►
                                  │
                                  │ writeDesignDoc()
                                  │ → .pi/orchestrator/designs/<date>-<topic>.md
                                  ▼
                          createOrchestratorContext()
                          = OrchestratorPlanContext
                          { planName, request, designDoc, projectContext }
                                  │
                                  ▼  (in-memory handoff — no orchestrator tool mediates)
                          LLM drives raw TaskCreate × N + TaskExecute
                          with agentType set per task
```

The hand-off surface is `OrchestratorPlanContext` (in
`pi-orchestrator/src/brainstorming/index.ts`):

```ts
export interface OrchestratorPlanContext {
  planName: string;
  request: string;
  designDoc: DesignDoc;
  projectContext: BrainstormContextResult;
}
```

It's a pure in-memory type. The brainstorming skill feeds it into the
LLM's next turn, and the LLM extracts `TaskCreate × N` calls from
`designDoc` itself — there is no tool that converts the design into
a DAG. The single-creator / single-consumer invariant holds
throughout: the design is data the LLM reads, not a side-channel
write to the board.

`RESPONSE_PATTERNS` in the same file:

```
proceed  /^(proceed|yes|y|start|implement|go|...)/i
defer    /^(defer|save|later|pause|not now|wait|...)/i
exit     /^(exit|cancel|quit|end|stop|never mind|...)/i
```

Anything unparseable defaults to `proceed` (the user is most likely
saying "yes, go on"). An empty response also defaults to `proceed`.

Design doc writes land at
`${ORCHESTRATOR_WORKDIR}/${projectKey(cwd)}/designs/`, the same
per-workspace root the task store lives under. Resolved through
`pi-tasks/src/task-paths.ts:orchestratorDesignsDir(cwd)`, so a single
env var (`ORCHESTRATOR_WORKDIR`) controls where every piece of
orchestrator state lives.

## Task lifecycle (one task's eye view)

```
pending       ─►  in_progress   ─►  completed
   │                  │
   │                  │ (on failure)
   │                  └──────────►  pending  (reverted)
   │
   └──────────►  deleted  (only via TaskUpdate status: "deleted")
```

`TaskExecute` moves `pending → in_progress` and spawns the executor.
The executor's completion moves `in_progress → completed` and stashes
the result. A failure reverts to `pending` (the next `TaskExecute`
retries). The orchestrator is the only entity that should ever move a
task to `deleted` (typically when the plan is wrong and the task is
no longer wanted).
# `pi-tasks` — Task Board (tracking layer)

> Source: `pi-tasks/` (workspaces member by indirect dep; npm namespace
> `@sages/pi-tasks`).
> File count: 10 source files in `src/`, 20 `.test.ts` files in `test/`
> (plus `setup.ts`, `global-setup.ts`, and `helpers/` which are not tests).
> Line counts: `index.ts` 1431, `task-store.ts` ~405, `ui/task-widget.ts`
> ~325.

## Purpose

`pi-tasks` is the file-backed task board the orchestrator and the
subagent runtime share. It owns the persistent DAG, the seven
LLM-facing `Task*` tools, the cross-extension RPC that drives
`TaskExecute` → `AgentManager.spawn`, the `subagents:completed`
listener that updates the store and fires cascade, and the above-editor
task widget. It is the only package that touches disk on every task
mutation, so it owns the file-locking contract that makes concurrent
sessions safe.

The package is "dumb" on purpose: it holds the DAG and emits lifecycle
events, but it never decides the shape of the workflow. The orchestrator
decides; the board persists.

## Entry points

Per `pi-tasks/package.json:22–26`:

```jsonc
"exports": {
  ".":             "./src/index.ts",   // the pi extension entry + the 7 tools
  "./task-store":  "./src/task-store.ts",
  "./task-paths":  "./src/task-paths.ts"
}
```

Per `pi-tasks/package.json:44–50`, the `pi` manifest declares a single
extension at `./src/index.ts` and ships a media link. The package's
default export (`pi-tasks/src/index.ts:1`) is the pi extension factory.

The orchestrator imports two named entry points — `@sages/pi-tasks/task-store`
(`pi-orchestrator/src/orchestrator-tool.ts:38`) and
`@sages/pi-tasks/task-paths` (`pi-orchestrator/src/orchestrator-tool.ts:39`,
`pi-orchestrator/src/brainstorming/index.ts:48`) — so it can share
the same `TaskStore` + path resolver the board itself uses.

## Key symbols

Top 10, ordered by importance:

1. **`TaskStore`** — `pi-tasks/src/task-store.ts:105`. The CRUD
   primitive. File-backed when constructed with an absolute path or
   list id (default home `~/.pi/tasks/<listId>.json`), in-memory when
   constructed without arguments. Owns its own file lock
   (`acquireLock` at `task-store.ts:31` / `releaseLock` at `:72` /
   `isProcessRunning` at `:78`, all in the `:21–80` block).
   - `create(subject, description, activeForm?, metadata?, type="plan"): Task`
       (`task-store.ts:192`)
   - `get(id): Task | undefined` (`task-store.ts:215`)
   - `list(sortOrder="id"): Task[]` (`task-store.ts:221`)
   - `update(id, fields): { task, changedFields, warnings }`
       (`task-store.ts:226`) — wires bidirectional `blocks` /
       `blockedBy` edges with cycle / self-dep / dangling warnings.
   - `delete(id): boolean` / `clearAll(): number` /
     `clearCompleted(): number` (`task-store.ts:338`, `:352`, `:385`).
   - `snapshot(): TaskStoreData` / `seed(data): void`
     (`task-store.ts:361`, `:368`) — fork-time handoff.
   - `normalizeTask` (`task-store.ts:91`) hardens hand-edited / older
     files: defaults `type` to `"plan"`, fills missing `metadata` /
     `blocks` / `blockedBy` / timestamps.

2. **`task-paths.ts`** — `pi-tasks/src/task-paths.ts`. Where files live.
   - `orchestratorWorkdir()` (`task-paths.ts:36`) — resolves
     `process.env.ORCHESTRATOR_WORKDIR ?? join(tmpdir(), "sages-orchestrator")`.
   - `projectKey(cwd)` (`task-paths.ts:50`) — encodes the cwd the way
     pi encodes session log dirs (`--/Users/me/work/repo/--`).
   - `orchestratorProjectTaskFile(cwd)` (`task-paths.ts:90`) — the file
     the orchestrator's `task_convert_intent` and `task_consume` read
     from. Same file the board writes under `taskScope: "project"`.
   - `orchestratorDesignsDir(cwd)` (`task-paths.ts:105`) — where
     brainstorm-approved design drafts land (next to the task store).
   - `sessionTaskFile` / `globalSessionTasksDir` /
     `workspaceSessionTaskFile` / `reclaimGlobalSessionTasksDir` —
     the four session-scope resolvers.

3. **The default extension export** — `pi-tasks/src/index.ts:1`.
   - Registers 7 tools: `TaskCreate` (`:628`), `TaskList` (`:715`),
     `TaskGet` (`:792`), `TaskUpdate` (`:874`), `TaskOutput` (`:1020`),
     `TaskStop` (`:1114`), `TaskExecute` (`:1165`).
   - Registers the `/tasks` interactive command at `:1296`.
   - Wires every lifecycle hook: `turn_start` (`:463`),
     `agent_settled` (`:477`), `turn_end` (`:485`), `tool_result`
     (`:513`), `context` (`:541`), `session_start` (`:559`),
     `before_agent_start` (`:604`), `tool_execution_start` (`:617`).

4. **`AutoClearManager`** — `pi-tasks/src/auto-clear.ts:27`. Turn-based
   completion sweep. Two modes: `"on_task_complete"` (per-task linger)
   and `"on_list_complete"` (batch linger). `startNewBatch`
   (`auto-clear.ts:84`) catches the freeze-after-finish case so a new
   run starts on a clean list.

5. **`TaskWidget`** — `pi-tasks/src/ui/task-widget.ts`. The above-editor
   widget. Renders the persistent row list with status glyphs, a
   10-frame spinner (`✳✴✵…✽`), per-task metrics (elapsed + tokens),
   and the blocker suffix. `setActiveTask` (`task-widget.ts:106`)
   toggles the spinner on / off; `update` (`task-widget.ts:266`)
   triggers a re-render.

6. **`resolveTaskGlyphs`** — `pi-tasks/src/task-glyphs.ts:88`. Pure
   function; merges config-supplied glyphs over built-in defaults
   (`DEFAULT_GLYPHS` at `task-glyphs.ts:54`). Hardens every glyph
   against control characters and bidi overrides so a
   `.pi/tasks-config.json` from a cloned repo cannot break the widget.

7. **`sortTasks`** — `pi-tasks/src/task-sort.ts:88`. Sort spec
   compiler. Accepts `"id"` / `"status"` / `"active"` / `"recent"` /
   `"oldest"` presets (`task-sort.ts:34`) or an arbitrary sort spec
   (`task-sort.ts:22`, type `SortSpec`) — see `SortKey` interface at
   `:14`. Built for data-only config —
   no executable JS.

8. **`loadTasksConfig` / `saveTasksConfig` / `loadGlobalTasksConfig`** —
   `pi-tasks/src/tasks-config.ts:44 / 58 / 40`. Merges global +
   project config. Glyphs merge one level deeper than the rest of the
   config (`tasks-config.ts:50`) so a single overridden glyph keeps
   the global ones.

9. **Cadence pure functions** — `pi-tasks/src/reminder-cadence.ts`.
   - `createCadenceState` (`reminder-cadence.ts:24`)
   - `onTurnStart` (`reminder-cadence.ts:41`) — bumps the turn counter.
   - `evaluateToolResult(state, toolName, hasTasks, config)`
       (`reminder-cadence.ts:55`) — resets cadence on task-tool use;
       otherwise flips `reminderDue` when the interval has elapsed.
   - `drainReminderForContext` (`reminder-cadence.ts:84`) — the consumer
       side; called from the `context` hook to inject a
       `<system-reminder>` into the upcoming LLM request without ever
       persisting it.

10. **`ProcessTracker`** — `pi-tasks/src/process-tracker.ts:20`. Buffers
    stdout / stderr per background task id, supports `waitForCompletion`
    (`process-tracker.ts:87`) with timeout + abort signal, and `stop`
    with SIGTERM → 5s → SIGKILL (`process-tracker.ts:110`).

The two `TaskType` literals (`"intent"` / `"plan"`) are exported as
the union `TaskType` at `pi-tasks/src/types.ts:22`. The `Task`
interface itself is at `types.ts:24`. The `BackgroundProcess` record
for shell processes is at `types.ts:46`.

## Dependencies

From `pi-tasks/package.json`:

- **peerDependencies** (`:16–20`): `@earendil-works/pi-coding-agent >=0.80.5`,
  `@earendil-works/pi-tui >=0.80.5`, `typebox *`. These are the host
  packages — pi itself + pi-tui (TUI primitives used by the widget) +
  TypeBox (tool parameter schemas).
- **dependencies**: `none`.
- **devDependencies** (`:36–42`): `@biomejs/biome ^2.4.13`,
  `@earendil-works/pi-coding-agent 0.84.2`, `@earendil-works/pi-tui 0.84.2`,
  `@types/node ^25`, `typescript ^6.0`, `vitest ^4.1.5`.

The orchestrator and pi-tasks are deliberately a tight pair:
`@sages/pi-orchestrator` depends on `@sages/pi-tasks` (`pi-orchestrator/package.json:35`),
and the orchestrator imports the `TaskStore` class + path resolver
through the `task-store` / `task-paths` subpath exports above. There is
no reverse dependency.

## Key flows

### Tool lifecycle (one task creation through cascade)

1. The LLM calls `TaskCreate` (`index.ts:628`). The factory reads
   `params.metadata`, stamps `agentType` when supplied, and calls
   `store.create(..., type=params.type ?? "plan")` (`:699`).
2. The LLM calls `TaskExecute` (`index.ts:1166`) on one or more task
   ids. `index.ts:1216` validates each candidate: `status === "pending"`,
   `metadata.agentType` set, no open `blockedBy` deps.
3. For each candidate, `index.ts:1245` calls `spawnSubagent` which goes
   over `subagents:rpc:spawn` (`index.ts:213`). The RPC layer is
   implemented in `pi-subagents/src/cross-extension-rpc.ts:97` (the
   `registerRpcHandlers` export).
4. `pi-subagents`' `AgentManager` (`pi-subagents/src/agent-manager.ts:489`)
   starts a detached pi session. The agent id is mapped to the task id
   in `agentTaskMap` (`index.ts:179`).
5. When the subagent completes, the manager emits `subagents:completed`
   or `subagents:failed` (`pi-subagents/src/index.ts:579–581`, inside the
   `onComplete` callback that begins at `:568`).
6. The `subagents:completed` listener (`index.ts:303`) updates the
   task: `store.update(task.id, { status: "completed", metadata: { ...task.metadata, result } })`.
   Then the auto-cascade block (`:314`) walks `store.list()` for tasks
   that are now unblocked and have `metadata.agentType`, marking each
   `in_progress` and spawning the next subagent.
7. The `widget.setActiveTask(task.id, false)` call stops the spinner
   for the completed task and starts it for the new one.

### Soft-mode task-count threshold

`index.ts:541` (`context` hook) consults
`drainReminderForContext(cadence)` (`reminder-cadence.ts:84`). The
reminder text is built by `buildSystemReminder(tasks)` (`index.ts:82`)
and appended as a transient user message. `intervalFor` (`index.ts:65`)
halves the interval to `ACTIVE_REMINDER_INTERVAL = 2` whenever any
task is `in_progress`. Truncates to `REMINDER_MAX_TASKS = 10`,
dropping completed rows first.

### `/tasks` interactive command

`index.ts:1296` registers the `tasks` slash command. `mainMenu`
(`:1304`) lists `View all tasks`, `Create task`, optional
`Clear completed`, optional `Clear all`, `Settings`. `createTask`
(`:1411`, with `store.create(..., "intent")` at `:1423`) writes a new
task with `type='intent'` — every `/tasks` task is user-facing raw
material until the orchestrator's `task_convert_intent` materializes
it into plan tasks.

### Shared list / file-backed mode

`TaskStore` is file-backed whenever its constructor receives a
non-empty argument (`task-store.ts:113`). `PI_TASKS=off` (env) yields
in-memory mode regardless; `PI_TASKS=/abs/path.json` or
`PI_TASKS=./relative.json` or `PI_TASKS=name` selects the named list
mode. The `withLock` wrapper (`task-store.ts:174`) re-reads state on
every mutation, applies the closure, then writes atomically (`save`
at `:161`). The lock file uses `<pid>:<uuid>` tokens so the staleness
check (`isProcessRunning` at `:78`) does not delete a successor's
lock when the PID is unreadable in another namespace.

## Verification

- `cd pi-tasks && bun run typecheck` (or `npm run typecheck`) — TS check.
- `cd pi-tasks && bun test` — 20 vitest files (see `pi-tasks/test/`,
  including `task-store.test.ts`, `subagent-integration.test.ts`,
  `auto-cascade.test.ts`, `stale-task-reminder.test.ts`,
  `task-paths.test.ts`, etc.).

## Where to learn more

- [`pi-orchestrator.md`](./pi-orchestrator.md) — the consumer that drives
  this board.
- [`pi-subagents.md`](./pi-subagents.md) — the executor that this board
  dispatches to over `subagents:rpc:spawn`.
- `pi-tasks/README.md` — package-level README.
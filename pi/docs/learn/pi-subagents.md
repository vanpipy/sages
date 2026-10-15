# `pi-subagents` — Task Executor (executing layer)

> Source: `pi-subagents/` (workspaces member; npm namespace
> `@sages/pi-subagents`).
> File count: 35+ source files in `src/` (the main `index.ts` is
> 3988 lines; supporting modules cover agent files, scheduling,
> nested tools, UI widgets, workflows, worktrees, settings, and an
> RPC bridge to pi-tasks).

## Purpose

`pi-subagents` is the autonomous-subagent runtime. It owns:

- The `AgentManager` singleton that tracks every spawned agent
  (foreground + background pools, with queueing, lifecycle callbacks,
  and cleanup).
- The cross-extension RPC bridge — `subagents:rpc:spawn` /
  `subagents:rpc:stop` / `subagents:rpc:consume` / `subagents:rpc:ping`
  — that pi-tasks's `TaskExecute` uses to launch agents and that
  pi-orchestrator's `setActiveTools` includes in the allowlist.
- The two built-in agent types: `Developer` (full read/write/edit/bash
  + worktree-isolated) and `Reviewer` (read-only + 4-state verdict
  emitter).
- The above-editor AgentWidget + the below-editor FleetList, the
  `@handle message` prompt-mention flow, the SubagentScheduler for
  cron / interval / one-shot jobs, the scripted workflow runtime
  (`src/workflow/`), and the worktree isolation helper.

It is also the package's only ship surface for pi, so the
default-agent registry, the subagent settings file (`subagents.json`),
and the `pi.extensions` install all flow through here.

## Entry points

Per `pi-subagents/package.json:51–57`:

```jsonc
"pi": {
  "extensions": [ "./src/index.ts" ],
  "video":      "https://github.com/tintinweb/pi-subagents/raw/master/media/demo.mp4",
  "image":      "https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png"
}
```

The package's pi entry point is `src/index.ts` (3988 lines). The
default export is the pi extension factory
(`pi-subagents/src/index.ts:301`), which wires every tool registration,
the agent-manager singleton, the RPC handlers, the UI widgets, the
`/agents` menu, the scheduled-jobs menu, and the workflows menu.

The package exposes a few named module exports:

- `pi-subagents/src/index.ts:85` — `renderRunningAgentStatus` (used by
  the widget render path).
- `pi-subagents/src/index.ts:276` — `formatToolsSuffix` (the
  `*` / `none` / `no built-ins, extension tools only` text that
  accompanies each agent type in the `Agent` tool description).
- `pi-subagents/src/index.ts:292` — `WORKFLOW_FILE_FLAG =
  "subagents-workflow-file"` (the CLI flag that runs a workflow script
  at session start).
- `pi-subagents/src/index.ts:299` — re-exports the workflow entry type
  (`WORKFLOW_ENTRY_TYPE`, `WorkflowEntryData`, `workflowEntryData`).
- `pi-subagents/src/agent-runner.ts:40` — `SUBAGENT_TOOL_NAMES` (the
  canonical `{ AGENT, WORKFLOW, GET_RESULT, STEER }` map).

## Key symbols

Top 10, ordered by importance:

1. **`AgentManager`** — `pi-subagents/src/agent-manager.ts:363`.
   Tracks every spawned agent. Two independent concurrency pools, never
   one: background (`maxConcurrent`, default 10) bounds detached
   agents; foreground (`maxConcurrentForeground`, default 0 = unlimited)
   bounds blocking agents. Excess spawns queue.
   - `spawn(pi, ctx, type, prompt, options): string` (`:489`) — returns
     the agent id synchronously; if isolation is `"worktree"`, the
     startup is async.
   - `spawnAndWait(...)` — spawns a blocking foreground agent and awaits
     it.
   - `awaitStartup(id): Promise<void>` (`:661`) — used by spawn
     sites that must fail the tool call on a startup failure.
   - `resume(id, prompt, signal, opts): Promise<AgentRecord | undefined>`
     — re-enter an evicted agent's existing session.
   - `setMaxConcurrent(n)` / `setMaxConcurrentForeground(n)`
     (`:433` / `:444`) — runtime ceilings, both drain the queue when
     changed.
   - `getRecord(id)` / `listAgents()` / `abort(id)` / `abortAll()` /
     `dispose(pi)` — the rest of the public surface.
   - The `startups` map (`:385`) and the `queue` array (`:409`) are
     the engine internals that make worktree-isolated spawns awaitable
     and slot-aware.
   - `isTopLevelAgent(record)` (`:122`) — the single source of truth
     for "is this agent owned by the session's manager, or by a parent
     agent / a workflow". Owned children report through their owner.

2. **The default pi extension factory** —
   `pi-subagents/src/index.ts:301`. Wires:
   - 4 LLM-facing tools: `Agent` (`defineTool` at `:1581`,
     registered at `:2302`), `SubagentWorkflow` (`:2408` /
     registered at `:2582`), `get_subagent_result` (`:2732` /
     `:2733`), `steer_subagent` (`:2821` / `:2822`).
    - 1 message renderer (`subagent-notification`, `:308`) for the
      Claude-Code-style `<task-notification>` cards.
   - 1 entry renderer for workflow runs (`:378`).
   - 1 CLI flag (`WORKFLOW_FILE_FLAG`, `:384`).
   - 1 slash command (`/agents`, `:3968`).
    - The `AgentManager` singleton (constructed at `:568` in the
      default export body), assigned to
      `Symbol.for("pi-subagents:manager")` for cross-package access.
   - The `registerRpcHandlers` call (`:799`) — the bridge pi-tasks's
     `TaskExecute` reaches.

3. **`DEFAULT_AGENTS`** — `pi-subagents/src/default-agents.ts:22`. The
   two built-in agent configs (`Developer`, `Reviewer`). The canonical
   names are exported as `DEFAULT_AGENT_NAMES = ["Developer", "Reviewer"]`
   (`pi-subagents/src/types.ts:15`). The orchestrator's `task_consume`
   and the Reviewer prompt both reference these names.

4. **`agent-runner.ts`** — `pi-subagents/src/agent-runner.ts`. The
   execution engine: `runAgent` (`:610`), `resumeAgent` (`:1154`),
   `steerAgent` (`:1209`), `getAgentConversation` (`:1219`). Also
   ships the canonical `SUBAGENT_TOOL_NAMES` (`:40`), the extension
   resolution helpers (`extensionCanonicalName` `:57`,
   `extensionCanonicalNames` `:121`, `parseExtensionsSpec` `:138`,
   `parseExtSelectors` `:177`, `installExtensionToolScope` `:231`),
   and the turn budget helpers (`normalizeMaxTurns` `:315`,
   `getDefaultMaxTurns` `:321`, `setDefaultMaxTurns` `:323`,
   `resolveEffectiveMaxTurns` `:334`, `getRememberAgents` `:348`,
   `setRememberAgents` `:350`, `getGraceTurns` `:356`,
   `setGraceTurns` `:358`).

5. **`AgentManager` lifecycle callbacks** —
   `pi-subagents/src/index.ts:568` constructs the manager with 4
   callbacks that wire the host into the runtime:
   - `onComplete` (`:568`): emits `subagents:completed` or
     `subagents:failed` (at `:579–581`), persists `subagents:record`
     entry, drives notification scheduling (group join vs. individual
     nudge).
   - `onStart` (`:614`): emits `subagents:started` (at `:625`),
     refreshes the widget / fleet list.
   - `onCompact` (`:630`): emits `subagents:compacted` (at `:633`).
   - `onUsage` (`:641`): every assistant `message_end` accumulates
     into `record.lifetimeUsage` (used by `PendingUsagePool`).
   - The cross-package registry is held via
     `Symbol.for("pi-subagents:manager")` (declared `:659` as
     `MANAGER_KEY`), claimed only if free so child sessions don't
     overwrite the root slot (the `ownsManagerRegistry` guard at
     `:747` checks the slot and writes only when free at `:748–750`).

6. **`registerRpcHandlers`** —
   `pi-subagents/src/cross-extension-rpc.ts:97`. The RPC bridge
   pi-tasks's `TaskExecute` talks to. Methods:
   - `subagents:rpc:ping` → returns `{ version: PROTOCOL_VERSION (2) }`.
   - `subagents:rpc:spawn` → spawns an agent, returns the agent id.
   - `subagents:rpc:stop` → aborts a running agent.
   - `subagents:rpc:consume` → marks a settled agent's result as read
     (suppresses the completion notification).
   - Reply envelope (`RpcReply<T>`, `:28`):
     `{ success: true, data? } | { success: false, error }`. Version
     pin at `:33`.

7. **`AgentWidget` + `FleetList`** — `src/ui/agent-widget.ts` and
   `src/ui/fleet-list.ts`. The above-editor live widget shows the
   running agents with spinner frames, elapsed time, token counts,
   and the active tool; the below-editor fleet list is the
   navigable `Claude Code`-style dashboard. The widget is built in
   `pi-subagents/src/index.ts:1132` (via `getWidgetMode()` +
   `isShowCostEnabled()` + `isShowModelEnabled()`); the fleet at
   `:1138` (with `isFleetViewEnabled()` at `:1141` +
   `getViewerMarkdown()` at `:433`).

8. **`SubagentScheduler`** — `pi-subagents/src/schedule.ts:50`.
   Cron / interval / one-shot jobs for agents. Trigger sources:
   `cron`, `interval`, `+10m`, ISO timestamps. `isActive` /
   `addJob` / `list` / `remove` / `start` / `stop`. The companion
   `ScheduleStore` (`src/schedule-store.ts`) persists the job roster
   to `<agent-dir>/schedules.json`.

9. **`agent-types.ts` registry** —
   `pi-subagents/src/agent-types.ts`. The agent-type registry and its
   lookup helpers: `BUILTIN_TOOL_NAMES` (`:20`),
   `getAgentConfig(name)` (`:232`), `getAvailableTypes()` (`:237`),
   `getAllTypes()` (`:242`), `getDefaultAgentNames()` (`:247`),
   `getUserAgentNames()` (`:254`), `isValidType(name)` (`:261`),
   `resolveTypeIn` (`:99`), `resolveEnabledTypeIn` (`:143`),
   `resolveSpawnType` (`:222`), `resolveSpawnTypeIn` (`:174`),
   `registerAgents(map)` (`:76`), `getFallbackSubagent()` (`:51`) /
   `setFallbackSubagent(v)` (`:54`), `isDefaultsDisabled()` /
   `setDefaultsDisabled(b)` (`:31` / `:34`), `NO_FALLBACK`
   (`"none"` literal at `:37`), `getMemoryToolNames` / etc.

10. **Workflow runtime** — `pi-subagents/src/workflow/`. The script-
    based workflow engine: `runtime.ts` (the interpreter),
    `host.ts` (the binding the script calls),
    `journal.ts` (the progress journal),
    `task.ts` (the per-run task record),
    `entry.ts` (`WORKFLOW_ENTRY_TYPE` at `:21`,
    `WorkflowEntryData` at `:24`, `workflowEntryData(task)` at `:36`),
    `tool-description.ts` (the LLM-visible description for
    `SubagentWorkflow`), `worker-source.ts` (the worker thread
    source), `saved.ts` (persisted workflow scripts),
    `collisions.ts` (`FOREIGN_WORKFLOW_TOOL_NAMES`,
    `decideWorkflowCollision`), `meta.ts` /
    `progress.ts` / `json-schema.ts`.

Supporting modules worth knowing about:

- `worktree.ts` — `createWorktree` (`:85`), `cleanupWorktree` (`:125`),
  `pruneWorktrees` (`:201`), `setWorktreeIsolationEnabled` (`:47`) /
  `isWorktreeIsolationEnabled` (`:51`).
- `nested-tools.ts` — `createNestedSubagentTools` (`:146`) injects
  `Agent` / `get_subagent_result` / `steer_subagent` as scoped tools
  inside a child session; `getMaxSubagentDepth` / `setMaxSubagentDepth`
  (`:47` / `:48`).
- `prompts.ts` — `buildAgentPrompt` (`:55`) composes the system
  prompt + skill preloads + memory block.
- `memory.ts` — `resolveMemoryDir` (`:61`), `ensureMemoryDir` (`:89`),
  `readMemoryIndex` (`:104`), `buildMemoryBlock` (`:123`),
  `buildReadOnlyMemoryBlock` (`:165`).
- `structured-output.ts` — `createStructuredCapture` (`:49`),
  `createStructuredOutputTool` (`:60`), `structuredRetryPrompt` (`:125`),
  `STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput"` (`:37`).
- `output-file.ts` — `createOutputFilePath` (`:64`),
  `ensureOutputFile` (`:77`), `writeInitialEntry` (`:84`),
  `streamToOutputFile` (`:100`); defaults
  `getOutputTranscriptDefault` / `setOutputTranscriptDefault`
  (`:24` / `:25`).
- `custom-agents.ts` — `loadCustomAgents` (`:44`), the loader that
  reads `~/.pi/agents/*.md` and `.pi/agents/*.md` with strict /
  warning modes.
- `invocation-config.ts` — `isolationParam` (`:53`),
  `resolveAgentInvocationConfig` (`:96`), `resolveJoinMode` (`:153`).
- `usage.ts` — `getLifetimeTotal` (`:30`), `getLifetimeCost` (`:35`),
  `addUsage` (`:40`), `toReportedUsage` (`:81`),
  `PendingUsagePool` (`:108`), `getSessionTokens` (`:151`),
  `getSessionContextPercent` (`:163`).
- `model-resolver.ts` — `describeModel` (`:26`), `resolveModel` (`:40`).
- `settings.ts` — `applyAndEmitLoaded` (`:561`),
  `applySettings(s, appliers)` (`:513`), `loadSettings` (`:492`),
  `saveSettings` (`:501`), `persistToastFor` (`:547`),
  `saveAndEmitChanged` (`:578`), `ToolDescriptionMode` (`:307`).
- `group-join.ts` — `GroupJoinManager` (`:28`); the smart /
  group / async notification collector.
- `custom-agents.ts` — see above; also frontmatter parsers for
  `tools`, `extensions`, `memory`, `isolation`, `inheritContext`.
- `agent-file-toggle.ts` — `findAgentFile` (`:46`),
  `locateAgentFile` (`:73`), `disableInContent` / `enableInContent`
  / `isDisabledContent` / `isEmptyStub` / `buildNewAgentFile` /
  `serializeAgentFile`.
- `agent-color.ts` — `resolveAgentColor` (`:63`),
  `renderAgentNameLabel` (`:122`), `hasAgentBadge` (`:148`),
  `renderAgentName` (`:153`).

## Dependencies

From `pi-subagents/package.json`:

- **peerDependencies** (`:18–22`):
  `@earendil-works/pi-ai >=1.1.0`,
  `@earendil-works/pi-coding-agent >=1.1.0`,
  `@earendil-works/pi-tui >=1.1.0`,
  `typebox *`.
- **dependencies** (`:24–27`):
  `croner ^10.0.1` (cron parsing for the scheduler),
  `nanoid ^5.1.16` (id generation for records + transient handles).
- **devDependencies** (`:29–42`):
  `@biomejs/biome ^2.4.14`, `@earendil-works/pi-ai 1.1.0`,
  `@earendil-works/pi-coding-agent 1.1.0`,
  `@earendil-works/pi-tui 1.1.0`,
  `@sinclair/typebox ^0.34.49`,
  `@types/node ^25.5.0`, `@vitest/coverage-istanbul ^4.1.10`,
  `typebox ^1.3.27`, `typescript ^6.0.0`, `vitest ^4.0.18`.

## Key flows

### Spawn (background path)

1. The LLM calls the `Agent` tool
   (`pi-subagents/src/index.ts:1581`). The `execute` body resolves
   the type via `resolveSpawnType` (`:1780`) and constructs a
   `createActivityTracker` (`:107`) for the spinner / token counts.
2. `manager.spawn(pi, ctx, type, prompt, options)` returns the id
   synchronously. If `options.isolation === "worktree"`, the agent is
   queued and `awaitStartup(id)` (`:661`) waits for the worktree git
   call to complete.
3. The `onStart` callback (`:614`) fires `pi.events.emit("subagents:started", { id, type, description })`.
4. The agent runs. Each assistant `message_end` accumulates into
   `record.lifetimeUsage` via `onUsage` (`:641`). The `PendingUsagePool`
   (`:108` of `usage.ts`) drains into the next tool result when
   `reportUsage` is on (the `withUsageReporting` wrapper at `:2295`).
5. The `onComplete` callback (`:568`) emits `subagents:completed`
   (or `subagents:failed`), persists a `subagents:record` session
   entry, and routes the notification through `GroupJoinManager`
   (`group-join.ts`) so a smart-mode batch arrives as a single
   `<task-notification>` block.
6. pi-tasks's `subagents:completed` listener
   (`pi-tasks/src/index.ts:303`) writes `metadata.result`, advances
   cascade, and updates the task widget.

### Foreground (blocking) path

Same as above except `manager.spawnAndWait` is awaited inline. The
tool description (`:1581`) surfaces the activity line via
`onUpdate` callbacks; a `setInterval(80ms)` drives the spinner.

### Resume

`resumeAgent` (`:1154`) reopens a tombstoned session file via the
agent's `resumeSessionFile` option (declared at
`agent-manager.ts:183`). The orchestrator's mention path
(`mention-clone.ts`) and the `Agent` tool's `resume` branch both go
through `startBackgroundResume` (`pi-subagents/src/index.ts:1278`).

### Workflow run

1. The LLM calls `SubagentWorkflow` (`:2408`).
2. `runWorkflowTask(ctx, task)` (`:2318`) drives the script via
   `runWorkflow({ script, args, signal, host, onProgress, journal })`
   in `src/workflow/runtime.ts`.
3. The `host` (`src/workflow/host.ts:1`) is the binding the script
   calls — agents, journals, control signals, etc.
4. The result renders as a session entry through
   `registerEntryRenderer(WORKFLOW_ENTRY_TYPE, ...)` (`:378`).

### Cross-extension RPC

`subagents:rpc:spawn` is consumed in `pi-tasks/src/index.ts:213`
(`rpcCall`). The handler in `cross-extension-rpc.ts:97` resolves the
`type`, calls `spawnTopLevel` (`pi-subagents/src/index.ts:698`),
which delegates to `manager.spawn`. `consumeResult`
(`pi-subagents/src/index.ts:811`) is the symmetric path pi-tasks's
`get_subagent_result` uses to suppress the duplicate completion
notification.

### Settings bootstrap

`applyAndEmitLoaded` (defined in `pi-subagents/src/settings.ts:561`)
is called from the `session_start` wiring to read
`~/.pi/agent/subagents.json` and project `.pi/subagents.json`,
merge them, and apply them via the appliers map (one entry per
subagent setting). Emits `subagents:settings_loaded`. Same shape on
`saveAndEmitChanged` (`:578` of `settings.ts`) for writes.

## Verification

- `cd pi-subagents && bun run typecheck` — TS check.
- `cd pi-subagents && bun test` — vitest, ~multiple suites under
  `pi-subagents/test/` (agent-manager, worktree, schedule, RPC,
  settings, etc.).
- `cd pi-subagents && bun run lint` — biome check.

## Where to learn more

- [`pi-tasks.md`](./pi-tasks.md) — the consumer that talks to this
  runtime over `subagents:rpc:spawn`.
- [`pi-orchestrator.md`](./pi-orchestrator.md) — the package that
  curates the tool allowlist including this runtime's tools.
- [`root.md`](./root.md) — the soft-mode policy that lets the
  orchestrator's `Developer` / `Reviewer` agents do their work.
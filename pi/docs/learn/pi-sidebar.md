# `pi-sidebar` — Sidebar (visual surface)

> Source: `pi-sidebar/` (vendored sage peer; npm namespace
> `@sages/pi-sidebar`; **not** a bun workspace member).
> File count: 1 extension entry (`extensions/sidebar.ts`), 3 shared
> modules under `extensions/sidebar/` (`types.ts`, `utils.ts`,
> `sidebar-event-tool.ts`), 2 section renderers under
> `extensions/sidebar/sections/` (`git.ts` + `tasks.ts`), and one
> vitest file (`tests/sidebar.test.ts`).
> Line counts: `sidebar.ts` 594, `tasks.ts` 441, `types.ts` 151,
> `sidebar-event-tool.ts` 180, `utils.ts` 74, `git.ts` 65,
> `sidebar.test.ts` 1441.
> Reference target: the post-trim tree at `251a102` — the sidebar
> renders **only** `Git` and `Tasks`.

## Purpose

`pi-sidebar` is a floating right-side overlay for the pi TUI that
renders git status and the Sages task board as a read-only panel. It
owns no pi host lifecycle beyond four hooks (`session_start`,
`session_shutdown`, `turn_start`, `turn_end`), registers no tools that
read or mutate the repo, and never blocks the editor. The package is a
**passive visual surface**: it listens on `pi.events`, polls the
orchestrator's task files on a fixed cadence, and shells out to `git`
on a timer.

It is a fork of [`jrimmer/pi-sidebar`][upstream] (BSD-3-Clause,
Copyright (c) 2026 Jason Rimmer), retargeted at the Sages runtime and
seeded with a `sidebar_event` tool plus a `sidebar:event` channel that
the rest of the monorepo emits into.

The complementary doc [`pi-sidebar-sages.md`](./pi-sidebar-sages.md)
documents the **emit side** — the five `pi.events.emit("sidebar:event")`
call sites in `pi-orchestrator`, `pi-tasks`, and `pi-evaluator`. This
file documents the **package itself**: the overlay, the renderer, the
listener, and the env surface. The two together describe the end-to-end
sidebar channel.

> **The section list is trimmed.** `SIDEBAR_SECTIONS`
> (`pi-sidebar/extensions/sidebar.ts:70–73`) holds exactly two
> renderers: `renderGitSection`, then `renderTasksSection`. The four
> sections the upstream fork shipped (`Model`, `Context`, `Location`,
> `Hint`) were deleted in `251a102 refactor(sidebar): trim to Git +
> Tasks sections only` — their source files
> (`sections/{model,context,location,hint}.ts`) are gone and the
> `turnCount` / `lastTool` state fields and the `model_select` +
> `tool_execution_start` listeners that fed them are gone with them.
> The trimming is pinned by
> `pi-sidebar/tests/sidebar.test.ts:396` ("renders only Git and Tasks
> sections in order (no Model / Context / Location / Hint)"), so a
> regression that re-adds a removed section breaks the suite before
> this doc goes stale.

## Entry points

Per `pi-sidebar/package.json:19–24`:

```jsonc
"pi": {
  "extensions": [
    "./extensions/sidebar.ts"
  ],
  "image": "https://raw.githubusercontent.com/jrimmer/pi-sidebar/main/assets/sidebar-screenshot.png"
}
```

That is the whole manifest: **one** registered extension. The default
export is `sidebarPlugin` at
`pi-sidebar/extensions/sidebar.ts:194`, and that single function is
the entire pi integration surface. It:

- reads every `PI_SIDEBAR_*` env var into locals (`:195–211`),
- constructs the module-scope `SidebarState` (`:248–258`),
- wires the `sidebar_event` tool + `sidebar:event` listener via
  `registerSidebarEventTool` (`:275–280`), eagerly so the channel is
  hot before `session_start` fires,
- registers four `pi.on(...)` lifecycle hooks (`:466–494`),
- registers four slash commands (`:496–560`) and two keyboard
  shortcuts (`:562–593`).

The TUI surface is requested lazily inside `startSidebar`
(`:398`) through `ctx.ui.custom<void>(...)` (`:403`) with
`{ overlay: true, overlayOptions: { … } }` (`:434–462`).

`pi-sidebar/extensions/sidebar.ts` also re-exports the data-shaping
helpers the test suite exercises (`:37–58`): the types from
`sidebar/types.js`, and `countTasks`, `emptyTasksState`,
`loadTasksState`, `orchestratorWorkdir`, `parseTasksJson`,
`projectKey`, `renderTasksSection`, `resolveTasksSource`,
`toTaskRows` from `sidebar/sections/tasks.js`, plus `envBool`,
`envInt`, `envSignedInt`, `formatFileLine`, `padAnsi`,
`parseNumstat`, `parseShortstat`, `shouldHideSidebar` from
`sidebar/utils.js`.

## Key symbols

Ordered roughly by importance.

| Symbol | File:line | Role |
|---|---|---|
| `sidebarPlugin` (default export) | `pi-sidebar/extensions/sidebar.ts:194` | The sole pi extension entry. Reads env, wires `SidebarState`, registers hooks / commands / shortcuts, owns the poll timer. |
| `SidebarComponent` (class) | `pi-sidebar/extensions/sidebar.ts:103` | The pi-tui `Component`. `render` (`:124`) computes `innerWidth`, builds a `SidebarSectionContext`, then walks `SIDEBAR_SECTIONS`. `renderCollapsed` (`:166`) draws the 2-char restore rail. |
| `SIDEBAR_SECTIONS` (const) | `pi-sidebar/extensions/sidebar.ts:70` | Ordered render array — post-trim it holds only `renderGitSection` then `renderTasksSection`. This is the single source of truth for what the sidebar draws. |
| `refreshGit` | `pi-sidebar/extensions/sidebar.ts:291` | Runs the `git` subprocess fan-out (`rev-parse --is-inside-work-tree`, `branch --show-current`, `diff --shortstat`, `status --porcelain=v1`, `diff --numstat HEAD --`) and rewrites `state.git`. Each call has a 1500 ms timeout. Re-entrancy guarded by `refreshing` (`:265`, checked `:292`). |
| `refreshTasks` | `pi-sidebar/extensions/sidebar.ts:371` | Calls `loadTasksState(cwd, { sessionId, maxRows })` and replaces `state.tasks` wholesale. Re-entrancy guarded by `refreshingTasks` (`:266`, checked `:372`). |
| `startSidebar` | `pi-sidebar/extensions/sidebar.ts:398` | Idempotent (`if (!ctx.hasUI \|\| component) return` at `:399`). Kicks the first `refreshGit` + `refreshTasks`, then mounts the overlay and starts the `setInterval` (`:418–421`). |
| `applyVisibility` | `pi-sidebar/extensions/sidebar.ts:282` | `overlayHandle?.setHidden(shouldHideSidebar(state, autohideWorking))` then `requestRender()`. Called on every turn boundary and after every command. |
| `registerSidebarEventTool` | `pi-sidebar/extensions/sidebar/sidebar-event-tool.ts:69` | Wires both halves of the channel: the LLM-facing `sidebar_event` tool (`:75`) **and** the `pi.events.on("sidebar:event", …)` listener (`:114`). |
| `parseTasksJson` | `pi-sidebar/extensions/sidebar/sections/tasks.ts:69` | Validates `{ tasks: Task[] }` and returns the array, or `null` on non-JSON / missing `tasks` array / any entry missing `id`, `type`, `subject`, or a valid `status`. Tolerates extra fields. |
| `resolveTasksSource` | `pi-sidebar/extensions/sidebar/sections/tasks.ts:206` | Picks the first readable source in the 3-scope priority order (orchestrator → session → workspace). Returns `null` when none exist. |
| `loadTasksState` | `pi-sidebar/extensions/sidebar/sections/tasks.ts:299` | The full poll: resolve source → read (single file or workspace merge) → parse → `countTasks` → `toTaskRows` → wrap into `TasksState`. |
| `toTaskRows` | `pi-sidebar/extensions/sidebar/sections/tasks.ts:166` | Projects the on-disk `Task[]` to the slim `TaskRow[]` the renderer sees, deriving the 5-value display status and truncating to `maxRows`. |
| `countTasks` | `pi-sidebar/extensions/sidebar/sections/tasks.ts:131` | Bucket counts for the header line. `blocked` is derived — a `pending` `plan` task with at least one non-completed blocker. |
| `emptyTasksState` | `pi-sidebar/extensions/sidebar/sections/tasks.ts:334` | Pre-first-poll initializer. Mirrors what `loadTasksState` returns when no source file is readable. |
| `renderTasksSection` | `pi-sidebar/extensions/sidebar/sections/tasks.ts:411` | Section renderer: heading, summary header, one line per `TaskRow`, `…N more` overflow. |
| `renderGitSection` | `pi-sidebar/extensions/sidebar/sections/git.ts:36` | Section renderer: branch, `N files  +I -D` summary, capped per-file list with delta coloring. |
| `sidebarOverlayWidth` | `pi-sidebar/extensions/sidebar.ts:75` | Pure width calculator: collapsed → `COLLAPSED_SIDEBAR_WIDTH` (2), else `width + (fullHeight ? buffer : 0)`. |
| `setSidebarCollapsed` / `toggleSidebarCollapsed` | `pi-sidebar/extensions/sidebar.ts:85` / `:93` | The only mutators of `enabled` / `collapsed`. Both force `enabled = true` on the way in, so a toggle never strands the sidebar off. |
| `requestRender` | `pi-sidebar/extensions/sidebar.ts:268` | `component?.invalidate()` + `tuiRef?.requestRender()`. The single re-render entry point; every mutator ends here. |
| `pickTopTaskId` | `pi-sidebar/extensions/sidebar.ts:220` | Reverse-channel picker. Walks the priority list `["in_progress", "intent", "pending", "blocked"]`, then falls back to `rows[0]`. |
| `selectTask` | `pi-sidebar/extensions/sidebar.ts:239` | The reverse-channel wire: `pi.appendEntry("system", "Sidebar: user selected task #N — …")`, `try/catch`-wrapped for hosts that don't wire `appendEntry`. |
| `piTitle` | `pi-sidebar/extensions/sidebar.ts:185` | Reads `ctx.sessionManager.getSessionName?.()`. Unused by any post-trim section (it was the Model section's title source); still exported. |
| `shouldHideSidebar` | `pi-sidebar/extensions/sidebar/utils.ts:56` | `!state.enabled \|\| (autohideWorking && state.isStreaming)`. The single visibility predicate. |
| `SIDEBAR_EVENT_ACTIONS` | `pi-sidebar/extensions/sidebar/sidebar-event-tool.ts:18` | The 6 allowed actions, `as const satisfies readonly SidebarEventAction[]` — the compile-time source for the TypeBox union at `:29–32`. |
| `SIDEBAR_EVENT_LOG_MAX` | `pi-sidebar/extensions/sidebar/types.ts:151` | `50` — the FIFO cap on `SidebarState.eventLog`. |
| `COLLAPSED_SIDEBAR_WIDTH` | `pi-sidebar/extensions/sidebar.ts:68` | `2` — the width of the collapsed restore rail. |

## Sections

Render order is fixed by `SIDEBAR_SECTIONS`
(`pi-sidebar/extensions/sidebar.ts:70–73`):

```ts
const SIDEBAR_SECTIONS: Array<(section: SidebarSectionContext) => void> = [
	renderGitSection,
	renderTasksSection,
];
```

Every renderer is `(section: SidebarSectionContext) => void` and is
expected to emit lines only through the `add` / `heading` helpers the
component supplies — a renderer cannot mutate state or re-truncate.
`SidebarComponent.render` (`sidebar.ts:124`) computes `innerWidth` as
`max(8, contentWidth - 3)` (`:130`, the 3 chars being the `│ ` border)
and pads the frame with `padAnsi` (`:135`).

### Git

`renderGitSection` (`sections/git.ts:36`) draws:

1. `section.heading("Git")` (`:38`).
2. Either the `git.error` string in warning color, or `not a git
   repo` muted, when `state.git.insideRepo === false` (`:40–45`).
3. The branch in accent color, truncated to `innerWidth` (`:47–48`).
4. A summary line `N files  +I -D` with the `+` and `-` split into
   `toolDiffAdded` / `toolDiffRemoved` (`:49–50`).
5. Either `clean working tree` in success color (`:52–55`), or a
   capped per-file list.

The per-file cap is `section.options.maxFiles` when
`state.gitDetail` is on, and `Math.min(5, maxFiles)` when it is off
(`:57–59`). Each row comes from `gitFileLine` (`:13`): the two-char
status code is colored `toolDiffRemoved` on `D`, `toolDiffAdded` on
`A` / `?`, else `warning`; the path is truncated with `…`; the delta
is appended by `colorDelta` (`:4`), which split-colors `+N/-M` and
collapses binary files to a single `bin`. Overflow renders
`…N more` (`:63–64`).

### Tasks (Sages-specific)

`renderTasksSection` (`sections/tasks.ts:411`) draws:

1. An early `return` when `state.tasks.enabled === false` (`:414`) —
   this is what `PI_SIDEBAR_TASKS=0` produces.
2. `section.heading("Tasks")` (`:415`).
3. `muted("no tasks")` when either `tasks.available === false`
   (`:417–420`) or `tasks.total === 0` (`:422–425`).
4. A summary header joining `completed/total` with `◼ N running`,
   `⌥ N blocked` (warning), `◌ N intent` (muted) — each part
   conditional on being non-zero (`:427–433`).
5. One line per `TaskRow` via `renderTaskLine` (`:386`), each
   prefixed with the `▶` selectable affordance (`:397`), the status
   glyph, the truncated subject, the colored status label, and
   `[agentType]` in dim when `metadata.agentType` is a string.
6. `…N more` when `tasks.truncatedCount > 0` (`:439–441`).

Three parallel lookup tables drive the row styling, all keyed by the
5-value `TaskRow["status"]`:

| Table | Line | Values |
|---|---|---|
| `TASK_GLYPHS` | `tasks.ts:350` | `◌` intent, `▷` pending, `⌥` blocked, `◼` in_progress, `✓` completed |
| `TASK_STATUS_LABELS` | `tasks.ts:358` | `intent`, `open`, `blocked`, `running`, `done` |
| `TASK_STATUS_TOKENS` | `tasks.ts:366` | `muted`, `muted`, `warning`, `accent`, `success` |

Note the label mapping: `pending` renders as **"open"**, not
"pending", so a row never reads as if it were itself blocked.

The two removed sections are worth naming because their absence is
observable: `Model` was the only consumer of `state.isStreaming`,
`turnCount`, `lastTool`, and `piTitle`; `Context` owned
`getThinkingLevel` on `SidebarRenderOptions`; `Location` and `Hint`
were chrome. The trimmed tree is intentionally minimal — Git status and
the task board are the two surfaces that carry workflow signal.

## State model

`SidebarState` (`pi-sidebar/extensions/sidebar/types.ts:86`) is the
single mutable bag the plugin owns. It is constructed once at
`sidebar.ts:248` and never reassigned; every mutator replaces or edits
a slice in place.

| Field | Type | Declared | Mutated by |
|---|---|---|---|
| `enabled` | `boolean` | `:87` | `setSidebarCollapsed` (`sidebar.ts:85`, forces `true`); `/sidebar off` (`sidebar.ts:504`, forces `false`). |
| `collapsed` | `boolean` | `:88` | `toggleSidebarCollapsed` (`:93`) via `ctrl+shift+s` or `/sidebar toggle`. |
| `gitDetail` | `boolean` | `:89` | `/sidebar-git-detail` (`sidebar.ts:553`). |
| `fullHeight` | `boolean` | `:90` | `/sidebar full` / `/sidebar floating` (`sidebar.ts:509–512`). |
| `git` | `GitState` | `:91` | `refreshGit` (`sidebar.ts:291`) replaces the whole slice. |
| `lastGitRefresh` | `number?` | `:92` | `refreshGit` (`:359`). |
| `lastTasksRefresh` | `number?` | `:93` | `refreshTasks` (`:384`). |
| `isStreaming` | `boolean` | `:101` | `turn_start` (`sidebar.ts:484`, `true`) / `turn_end` (`:490`, `false`). Powers `PI_SIDEBAR_AUTOHIDE_WORKING`. |
| `tasks` | `TasksState` | `:102` | `refreshTasks` (`sidebar.ts:371`) replaces the whole slice. |
| `highlightedId` | `string?` | `:104` | `sidebar:event` `show` / `highlight` (`sidebar-event-tool.ts:134`); cleared by `clear` (`:166–174`). |
| `badges` | `EventLogEntry[]` | `:106` | `sidebar:event` `badge` (`:137`); cleared or filtered by `clear`. |
| `eventLog` | `EventLogEntry[]` | `:108` | `sidebar:event` `log` (`:158`) with FIFO eviction at 50. |

The doc comment at `types.ts:94–100` calls out explicitly why
`isStreaming` survived the trim: the Model section was its only
*visible* consumer, but `PI_SIDEBAR_AUTOHIDE_WORKING` still reads it,
and dropping it would silently break the autohide contract.
`pi-sidebar/tests/sidebar.test.ts:173` pins that survival.

### The supporting types

| Type | File:line | Holds |
|---|---|---|
| `Theme` | `types.ts:3` | Alias for `ExtensionContext["ui"]["theme"]`. The renderer never imports a theme type. |
| `GitState` | `types.ts:5` | `insideRepo`, `branch?`, `files[]` (`{ code, path, delta? }`), `insertions`, `deletions`, `changedFiles`, `error?`. |
| `Task` | `types.ts:20` | The on-disk task shape written by the Sages task store. `status` carries the board's **3** literals; `metadata`, `blocks`, `blockedBy`, `createdAt`, `updatedAt` are read but never rendered. |
| `TaskRow` | `types.ts:40` | `{ id, subject, status, agentType? }` — what the renderer sees. `status` carries **5** literals. |
| `TasksState` | `types.ts:58` | `enabled`, `available`, `source?`, `total`, `completed`, `inProgress`, `intents`, `blocked`, `rows`, `truncatedCount`. |
| `EventLogEntry` | `types.ts:80` | `{ ts, target?, data? }`. Shared by both `badges` (transient) and `eventLog` (FIFO-capped). |
| `SidebarRenderOptions` | `types.ts:111` | Static render-time config: `maxFiles`, `buffer`, `fillRows`, `verticalPadding`, `tasks.maxRows`. |
| `SidebarSectionContext` | `types.ts:121` | The bag each renderer receives: `ctx`, `state`, `theme`, `innerWidth`, `add`, `heading`, `muted`, `dim`, `options`, `selectTask?`. |
| `SidebarEvent` | `types.ts:143` | The `{ ts, action, target?, data? }` payload on the `sidebar:event` channel. |

The `Task` / `TaskRow` status split is the load-bearing distinction.
The board has three statuses (`pending` / `in_progress` /
`completed`, matching `pi-tasks/src/types.ts`) plus a `type` field
(`intent` / `plan`). The row adds two *display-only* derivations
computed in `toTaskRows` (`tasks.ts:178–183`):

1. `type === "intent"` → display status `intent`, checked first so an
   intent never renders as `pending`.
2. `blocked` — `blockedBy` references at least one id not in the
   completed set. Checked after `completed` and `in_progress`, so a
   running or finished task is never shown as blocked.

Both derivations are skipped for `type === "intent"`, which matches
`countTasks`'s rule (`tasks.ts:149–155`) so the header counts and the
row glyphs can never disagree.

## Task board polling

The Tasks section is fed by `loadTasksState`
(`sections/tasks.ts:299`), which calls `resolveTasksSource` (`:206`)
to pick a file in this fixed priority order.

| # | Scope | Path | Read via |
|---|---|---|---|
| 1 | `orchestrator` | `${ORCHESTRATOR_WORKDIR}/${projectKey(cwd)}/tasks/tasks.json` (`tasks.ts:211`) | `readSingleFile` (`:284`) |
| 2 | `session` | `${cwd}/.pi/tasks/tasks-${sessionId}.json` (`tasks.ts:216`) | `readSingleFile` (`:284`) |
| 3 | `workspace` | `${cwd}/.pi/tasks/tasks-*.json` (`tasks.ts:221–237`) | `readWorkspaceTasks` (`:247`) |

Scope 1 is the Sages project scope and is cross-session shared — it
is the same file the orchestrator's `task_convert_intent` /
`task_consume` read and the same file the board writes under
`taskScope: "project"`. Scope 2 is only attempted when a non-empty
`sessionId` was resolved. Scope 3 merges **every** `tasks-*.json` in
the directory, sorted by filename, deduping by task `id` with later
occurrences winning — the newest write carries the authoritative
status (`tasks.ts:262–276`).

`loadTasksState` (`:306–313`) branches: scopes 1 and 2 take the single
file, scope 3 takes the merge. When `resolveTasksSource` returns
`null`, `available` is `false` (`:318`) and the section renders
`muted("no tasks")` — a non-Sages session is a silent no-op, never a
throw.

### `projectKey` parity requirement

`projectKey` (`tasks.ts:41`) **must** match
`pi-tasks/src/task-paths.ts:50` byte-for-byte. Both are the same
one-liner:

```ts
`--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
```

The duplication is deliberate and load-bearing. The package has zero
`@sages/*` imports (see [Dependencies](#dependencies)), so it cannot
import the reference implementation — the encoder is copied and pinned
instead. Two tests guard it:

- `tests/sidebar.test.ts:520` — `projectKey("/Users/me/work/repo")`
  is `--Users-me-work-repo--`, and two workspaces sharing a basename
  (`/Users/alice/foo` vs `/Users/bob/foo`) encode differently.
- `tests/sidebar.test.ts:1166` — "projectKey byte-matches
  pi-tasks/src/task-paths.ts:projectKey", which re-implements the
  reference expression inline and compares across three sample paths.

Drift here fails **silently and expensively**: the orchestrator would
write to `orchestratorWorkdir()/projectKey_A/tasks/tasks.json` while
the sidebar reads `orchestratorWorkdir()/projectKey_B/tasks/tasks.json`.
Scope 1 would never resolve, the sidebar would fall through to scopes
2 and 3, and the panel would render "no tasks" with no error anywhere.
`orchestratorWorkdir` itself (`tasks.ts:49`) is a second parity point:
`process.env.ORCHESTRATOR_WORKDIR ?? join(tmpdir(), "sages-orchestrator")`,
matching `pi-tasks/src/task-paths.ts:36`. It is resolved **per call**,
never captured at module load, so an env change between polls is picked
up.

### Poll cadence

Three independent triggers, all routed through the same two functions:

| Trigger | Location | When |
|---|---|---|
| Initial open | `sidebar.ts:401–402` | `startSidebar` fires `refreshGit` + `refreshTasks` before the overlay mounts. |
| `setInterval` | `sidebar.ts:418–421` | Every `PI_SIDEBAR_REFRESH_MS` (default 5000). Cleared in `dispose()` (`:424`). |
| `turn_end` | `sidebar.ts:488–494` | After every model turn: `refreshGit(ctx)` + `refreshTasks(ctx)` (`:491–492`). |

`turn_end` is what makes the Tasks panel feel live: a subagent
finishing flips a task to `completed` in the board, and the panel
re-reads the store before the next render rather than waiting out the
remainder of the interval.

Concurrency is guarded by two plain booleans, not promises:
`refreshing` (`:265`) and `refreshingTasks` (`:266`). A call that
arrives while one is in flight returns immediately (`:292`, `:372`)
rather than queueing — the in-flight call will pick up the current
filesystem state anyway. Both `finally` blocks call `requestRender()`
(`:367`, `:394`) so the panel always repaints, including on the
early-return path of the outer caller.

`refreshTasks` resolves the session id defensively
(`sidebar.ts:376–378`), reading `ctx.sessionId` first and falling back
to `ctx.sessionManager.sessionId`, both through `unknown` casts
because neither is on the public `ExtensionContext` type. That fallback
is what makes scope 2 reachable on hosts that nest it.

## The `sidebar_event` channel

The sidebar subscribes to exactly one pi event channel,
`"sidebar:event"`. The contract (`types.ts:143`):

```ts
{
  ts: number;
  action: "show" | "highlight" | "badge" | "toast" | "log" | "clear";
  target?: string;
  data?: Record<string, unknown>;
}
```

`registerSidebarEventTool` (`sidebar-event-tool.ts:69`) wires it in
two halves that share one function but nothing else.

### Half 1 — the LLM-facing tool

`pi.registerTool({ name: "sidebar_event", … })` at `:75`. Its
parameter schema is the TypeBox `SidebarEventParams` at `:28–49`: a
union of `SIDEBAR_EVENT_ACTIONS` literals (`:29–32`), an optional
`target` string (`:33–38`), and an optional open
`additionalProperties: true` `data` object (`:39–48`). The
`execute` body (`:84–111`) does exactly one thing — emit one
`sidebar:event` with `ts = Date.now()` (`:91–97`) — and returns a
success envelope whose `details` carries `{ emitted: true, event:
"sidebar:event", ts }` (`:105–109`).

Note the tool does **not** mutate state. It is a pure re-emitter: the
listener below is what applies the effect. That means a caller cannot
bypass the channel by using the tool, and the two paths (tool
invocation vs. a direct `pi.events.emit` from another extension) are
guaranteed to take identical code.

### Half 2 — the internal listener

`pi.events.on("sidebar:event", …)` at `:114`. Before the switch it
hardens the payload: an unknown or missing `action` returns early
(`:117–119`), `target` is coerced to a string or `undefined`
(`:120–121`), non-object `data` is dropped (`:122–125`), and a
non-finite `ts` falls back to `Date.now()` (`:126–129`). The
`as Partial<SidebarEvent>` cast at `:115` is the trust boundary —
nothing upstream is type-checked at runtime.

The switch at `:131–177` routes each action:

| Action | Line | State mutation |
|---|---|---|
| `show`, `highlight` | `:134` | `state.highlightedId = target`. Both actions share one arm — they are aliases. |
| `badge` | `:137` | `state.badges.push({ ts, target, data })`. Unbounded by design; `clear` is the release valve. |
| `toast` | `:141–155` | `ctx?.ui.notify(data.message ?? "sidebar", level)` where `level` is `warning` / `error` or defaults to `info` (`:145–149`). Wrapped in `try/catch` (`:150–154`) so an unloaded `ctx` or a throwing `notify` cannot break the listener. |
| `log` | `:158–164` | `state.eventLog.push({ ts, target, data })`, then FIFO eviction. |
| `clear` | `:166–174` | With no `target`: resets `highlightedId` and empties `badges`. With a `target`: clears `highlightedId` only if it matches, and filters `badges` to those whose target differs. `eventLog` is never cleared. |
| unknown | `:175–176` | `return` — unreachable via the tool, reachable via a direct emit. |

Every branch falls through to `requestRender()` at `:178`.

### FIFO-capped event log

`SIDEBAR_EVENT_LOG_MAX` is `50` (`types.ts:151`). When a `log` push
would exceed it, the listener splices from the **front**
(`sidebar-event-tool.ts:159–163`):

```ts
if (state.eventLog.length > SIDEBAR_EVENT_LOG_MAX) {
	state.eventLog.splice(0, state.eventLog.length - SIDEBAR_EVENT_LOG_MAX);
}
```

This is a hard FIFO eviction, not a time-window or size-bounded
buffer — an entry stays until it is displaced by a newer one. The cap
bounds memory on long sessions without ever dropping the newest state.
Post-trim no section renders `eventLog` (the panel that did was
deleted with the Model section), so the array is currently write-only
state: it is a channel-level contract with the Sages side, not a
visible surface. `pi-sidebar-sages.md` is the doc that gives it
meaning.

### Reverse channel via `ctrl+shift+t`

The overlay is `nonCapturing: true` (`sidebar.ts:454`), so it cannot
take keyboard focus and rows are not directly addressable. The Tasks
renderer still prefixes every row with a `▶` affordance marker
(`tasks.ts:397`, commented as the selection affordance at `:394–396`),
and the bridge is a global shortcut:

```text
user presses ctrl+shift+t                              (sidebar.ts:580)
  → pickTopTaskId()                                    (sidebar.ts:585)
      priority ["in_progress", "intent", "pending", "blocked"]   (:222)
      fallback rows[0] of any status                             (:228)
  → no row? notify("No Sages task to select.")                  (:586–589)
  → selectTask(picked.id, picked.subject)              (sidebar.ts:590 → :239)
      try { pi.appendEntry("system",
             `Sidebar: user selected task #${taskId} — ${subject}`); }  (:240–245)
      catch { /* appendEntry may not be wired in older pi hosts */ }
  → notify(`Sidebar: selected task #${picked.id}`)                (:591)
```

The next LLM turn sees the appended system note. Two details are
load-bearing: `pickTopTaskId` prefers `in_progress` because that is
what the user is most likely looking at mid-run, and the whole
`appendEntry` is `try/catch`-wrapped so a host that does not wire it
degrades to "the shortcut notifies but nothing is injected" rather
than throwing inside a keybinding handler.

The same `selectTask` function is passed into `SidebarComponent`'s
constructor (`sidebar.ts:417`, defaulted to a no-op at `:116–119`)
and reaches renderers as `SidebarSectionContext.selectTask`
(`types.ts:139`), so a renderer could bind a row directly if a future
pi host adds overlay focus.

For the **emit** side — the five call sites across `pi-orchestrator`,
`pi-tasks`, and `pi-evaluator` that fire these payloads — see
[`pi-sidebar-sages.md`](./pi-sidebar-sages.md).

## Overlay mechanics

The sidebar mounts as an overlay, not as a layout region: the host pi
TUI is never modified. `startSidebar` (`sidebar.ts:398`) calls
`ctx.ui.custom<void>(…)` with the options block at `:434–462`:

| Option | Value (line) | Why |
|---|---|---|
| `overlay` | `true` (`:435`) | Floating window over the editor rather than a reserved column. |
| `anchor` | `fullHeight ? "top-right" : "right-center"` (`:437–441`) | A **getter**, so toggling `/sidebar full` re-anchors live without remounting. |
| `width` | `currentSidebarOverlayWidth()` (`:442–444`) | Also a getter, reading `sidebarOverlayWidth(state, sidebarWidth, sidebarBuffer)` (`:287`). Collapsed → `2`; else `PI_SIDEBAR_WIDTH + (fullHeight ? PI_SIDEBAR_BUFFER : 0)`. |
| `maxHeight` | `"100%"` (`:445`) | Lets full-height mode fill the column. |
| `margin` | `fullHeight ? { top: 0, right: 0, bottom: 0 } : { right: 0 }` (`:446–450`) | Floating mode keeps a right margin so the panel breathes; full-height pins flush. |
| `offsetY` | `fullHeight ? 0 : PI_SIDEBAR_OFFSET_Y` (`:451–453`) | Default `-6` rows, so the floating panel rides above the editor's input box. |
| `nonCapturing` | `true` (`:454`) | The overlay never steals keyboard or mouse input from the editor. This is what forces the `ctrl+shift+t` reverse channel instead of in-panel navigation. |
| `visible` | `(termWidth) => termWidth >= minTermWidth` (`:455`) | Default threshold `110`. Below it the overlay is not shown at all. |

Every one of these is a getter rather than a plain value, which is
the mechanism behind live re-configuration: `/sidebar full`,
`/sidebar collapse`, and `ctrl+shift+s` mutate `SidebarState` and call
`applyVisibility()`, and the next host frame reads the new values —
no overlay teardown, no remount, no state loss.

`onHandle` (`:457–461`) stores the handle, calls `handle.unfocus()`
(`:459`) so the panel cannot steal editor focus on session open, then
`applyVisibility()` (`460`) to apply `PI_SIDEBAR_ENABLED` on first
paint. `session_shutdown` (`:474–480`) calls `overlayHandle?.hide()`
and drops the handle.

`dispose()` (`:423–429`) clears the interval, drops `component` and
`tuiRef`, and calls `done()`.

### Autohide while working

`shouldHideSidebar` (`utils.ts:56`) is the whole predicate:

```ts
return !state.enabled || (autohideWorking && state.isStreaming);
```

`state.isStreaming` is set `true` at `turn_start` (`:484`) and `false`
at `turn_end` (`:490`), and `applyVisibility()` runs on both
boundaries. With the default `PI_SIDEBAR_AUTOHIDE_WORKING=true` the
panel disappears for the duration of a model turn and returns when the
turn settles — which is also why `turn_end` is the natural refresh
trigger. When the panel is hidden, `state` keeps accumulating, so
nothing is lost across the hide.

This is the reason `isStreaming` survived the section trim. The Model
section was its only visible consumer; `types.ts:94–100` records that
the field was kept deliberately because the autohide contract still
reads it, and `tests/sidebar.test.ts:173` pins the survival.

### Documented limitation

The sidebar **covers** the right edge of the interface; it does not
change how pi lays out anything. Chat messages, tool output, the
editor, and the footer still wrap to the full terminal width, so on a
wide-enough terminal the panel overlays their rightmost columns rather
than displacing them.

This is not fixable inside the extension. A reflowing sidebar needs
the pi TUI to expose first-class **window regions** — the host would
have to reserve columns and shrink its own layout accordingly — and
that primitive does not exist. Until it does, the fork's compromise is
the combination documented above: overlay rather than reserve, and hide
entirely below `PI_SIDEBAR_MIN_TERM_WIDTH` rather than steal columns
at every width. The upstream fork documents the intended native
window-region design in its `docs/architecture/native-tui-window-future.md`
(in the standalone `~/Project/pi-sidebar-sages/` repo — see
[Fork lineage](#fork-lineage)).

## Environment variables

Every `PI_SIDEBAR_*` variable the package reads. All are read **once**
at `sidebarPlugin` entry (`sidebar.ts:195–211` and `:249–252`), except
where noted.

| Variable | Default | Read at | Parser | Effect |
|---|---|---|---|---|
| `PI_SIDEBAR_ENABLED` | `true` | `:249` | `envBool` | Master switch. `false` hides the panel outright and forces it collapsed on the next toggle. |
| `PI_SIDEBAR_WIDTH` | `34` | `:195` | `envInt` | Panel width in columns for the expanded overlay. |
| `PI_SIDEBAR_BUFFER` | `1` | `:196` | `envInt` | Gutter added to the width in full-height mode; also the left indent of every row (`:133–134`). |
| `PI_SIDEBAR_FILL_ROWS` | `200` | `:197` | `envInt` | Blank rows appended in full-height mode to reach a full column (`:160–162`). |
| `PI_SIDEBAR_VERTICAL_PADDING` | `1` | `:200` | `envSignedInt` | Blank rows above and below the content in floating mode. Clamped `>= 0` at `:198–201`; negative values are ignored by the clamp, not by the parser. |
| `PI_SIDEBAR_MIN_TERM_WIDTH` | `110` | `:202` | `envInt` | Threshold for `overlayOptions.visible`. Below it the overlay is hidden. |
| `PI_SIDEBAR_REFRESH_MS` | `5000` | `:203` | `envInt` | `setInterval` cadence for `refreshGit` + `refreshTasks`. |
| `PI_SIDEBAR_GIT_LINES` | `12` | `:205` | `envInt` | Cap on per-file rows in the Git section. Takes precedence when set. |
| `PI_SIDEBAR_MAX_FILES` | `12` | `:206` | `envInt` | Fallback cap, used as the default argument of `PI_SIDEBAR_GIT_LINES` (`:204–207`). Same effect when `GIT_LINES` is unset. |
| `PI_SIDEBAR_AUTOHIDE_WORKING` | `true` | `:208` | `envBool` | Hides the panel while a model turn is in flight. |
| `PI_SIDEBAR_OFFSET_Y` | `-6` | `:209` | `envSignedInt` | Vertical offset of the floating panel, in rows. |
| `PI_SIDEBAR_TASKS` | `true` | `:210` | `envBool` | Enables the Tasks section. `false` short-circuits `refreshTasks` (`:372`) and `renderTasksSection` (`:414`). |
| `PI_SIDEBAR_TASKS_MAX` | `10` | `:211` | `envInt` | Max rendered task rows. Clamped to `>= 1` at `:211`. |
| `PI_SIDEBAR_FULL_HEIGHT` | `false` | `:252` | `envBool` | Initial layout. `/sidebar full` / `/sidebar floating` flip it at runtime. |
| `PI_SIDEBAR_GIT_DETAIL` | `true` | `:251` | `envBool` | Initial per-file detail. `false` caps rows at `min(5, maxFiles)`. `/sidebar-git-detail` flips it at runtime. |

The three parsers (`utils.ts:4`, `:10`, `:15`) are worth knowing
because their edge cases are not all the same:

- `envBool` (`:4`) treats `""` as unset, and `0` / `false` / `no` /
  `off` (case-insensitive) as false. **Any other** value is true, so
  `PI_SIDEBAR_TASKS=maybe` enables it.
- `envInt` (`:10`) requires a **positive** value — a parsed `0` or
  negative number falls back to the default, as does unparseable input.
- `envSignedInt` (`:15`) accepts any finite value, negatives included,
  which is what `PI_SIDEBAR_OFFSET_Y` needs.

One non-`PI_SIDEBAR_*` variable matters:

| Variable | Read at | Default | Effect |
|---|---|---|---|
| `ORCHESTRATOR_WORKDIR` | `sections/tasks.ts:50` | `join(tmpdir(), "sages-orchestrator")` (`:34`) | Root of the Sages project task scope. Resolved **per call**, not captured at load, matching `pi-tasks/src/task-paths.ts:36`. Set by the orchestrator runtime. |

## Commands and shortcuts

Four commands and two shortcuts, all registered in `sidebarPlugin`
(`sidebar.ts:496–593`). All six survived the trim.

### `/sidebar` (`sidebar.ts:496`)

The action dispatcher. Description at `:497–498`:
`/sidebar [collapse|expand|on|off|status|full|floating]`. Every
invocation first calls `startSidebar(ctx)` (`:501`), so the command
doubles as the mount trigger when the overlay has not opened yet.

| Argument | Effect | Line |
|---|---|---|
| _(empty)_ / `toggle` | `toggleSidebarCollapsed(state)` | `:519` |
| `on` | `setSidebarCollapsed(state, false)` — also re-enables | `:503` |
| `off` | `state.enabled = false` | `:504` |
| `collapse`, `collapsed` | `setSidebarCollapsed(state, true)` | `:505–506` |
| `expand`, `expanded` | `setSidebarCollapsed(state, false)` | `:507–508` |
| `full`, `full-height` | `state.fullHeight = true` | `:509–510` |
| `floating`, `window` | `state.fullHeight = false` | `:511–512` |
| `status` | Notifies enabled / collapsed / layout / autohide / git-detail / tasks state, then returns early | `:513–518` |
| anything else | `notify("Unknown sidebar option: …", "warning")`, returns early | `:520–523` |

Non-`status` paths end with `applyVisibility()` (`:524`) then a
confirmation notify (`:525–528`). Note that `off` is one-way through
this dispatcher — re-enabling is `on`, or any collapse/expand action,
since both collapse helpers force `enabled = true`.

### `/sidebar-refresh` (`sidebar.ts:532`)

Forces `refreshGit(ctx)` (`:536`) and notifies. Useful right after a
manual commit when the 5-second timer is mid-interval.

### `/sidebar-refresh-tasks` (`sidebar.ts:541`)

Forces `refreshTasks(ctx)` (`:545`) and notifies. **Survived the
trim** — it is task-board-specific and therefore part of the retained
surface. Useful after a `task_convert_intent` when the cached
snapshot is stale.

### `/sidebar-git-detail` (`sidebar.ts:550`)

Flips `state.gitDetail` (`:553`), calls `requestRender()`, and
notifies "enabled" / "reduced". Switches the per-file cap between
`maxFiles` and `min(5, maxFiles)`.

### `ctrl+shift+s` (`sidebar.ts:562`)

Collapse / expand. Calls `startSidebar(ctx)` (`:566`),
`toggleSidebarCollapsed(state)` (`:567`), then `applyVisibility()`
(`:568`). Idempotent when the sidebar is disabled — the toggle turns
it back on expanded rather than doing nothing.

### `ctrl+shift+t` (`sidebar.ts:580`)

The reverse channel. `pickTopTaskId()` (`:585`) → `selectTask(...)`
(`:590`) → `pi.appendEntry("system", …)` → `notify(...)` (`:591`).
Full flow in [Reverse channel](#reverse-channel-via-ctrlshiftt).

## Dependencies

Per `pi-sidebar/package.json`:

- **peerDependencies** (`:34–38`): `@earendil-works/pi-coding-agent *`,
  `@earendil-works/pi-tui *`, `typebox *`. The host packages — pi
  itself (`ExtensionAPI`, `ExtensionContext`, `ThemeColor`),
  pi-tui (`truncateToWidth`, `visibleWidth`, the `Component` /
  `OverlayHandle` / `TUI` types the overlay is built from), and
  TypeBox (the `sidebar_event` parameter schema at
  `sidebar-event-tool.ts:28–49`).
- **dependencies**: the field is absent. The package ships no runtime
  dependencies at all.
- **devDependencies** (`:39–44`): `@types/node ^24.12.4`,
  `typebox ^1.4.2`, `typescript ^5.9.3`, `vitest ^4.1.7`.

`pi-sidebar` is deliberately **not** a bun workspace member — it keeps
its own npm + vitest + tsc toolchain so those dependencies stay out of
bun's workspace resolution. The practical consequence is that it is
verified separately from the monorepo gates.

### Zero `@sages/*` imports

The package imports **nothing** from the monorepo. Its only
cross-package coupling is:

1. **`pi.events`** — the `sidebar:event` channel. The orchestrator,
   pi-tasks, and pi-evaluator emit; this package listens. No shared
   module, no shared schema: the payload type is duplicated as a
   literal in three places (`pi-evaluator/src/tools/eval-score.ts:49`,
   the orchestrator's emit wrapper, and `types.ts:143` here).
2. **The filesystem layout** — `ORCHESTRATOR_WORKDIR` +
   `projectKey(cwd)` (`sections/tasks.ts:41`, `:49`), a contract with
   `pi-tasks/src/task-paths.ts:50` / `:36` enforced only by tests.

Neither direction imports the other. That is what lets the deploy be
a plain file-copy to `~/.pi/packages/pi-sidebar-sages` with no
`node_modules` bridging, and it is why the contract stays honest only
as long as the integration tests run on both sides:
`pi-orchestrator/test/orchestrator-sidebar-emit.test.ts`,
`pi-tasks/test/task-sidebar-emit.test.ts`,
`pi-evaluator/test/tools/evaluator-sidebar-emit.test.ts`, and this
package's `tests/sidebar.test.ts`.

## Testing

One vitest file, `pi-sidebar/tests/sidebar.test.ts` (1441 lines),
**65 tests across 12 `describe` blocks**.

| Block | Line | Covers |
|---|---|---|
| `configuration helpers` | `:113` | `envBool` / `envInt` / `envSignedInt` edge cases, `setSidebarCollapsed` / `toggleSidebarCollapsed`, `shouldHideSidebar`, and the trim-survivor assertion that `isStreaming` is still on `SidebarState` (`:173`). |
| `git parsing` | `:182` | `parseShortstat` and `parseNumstat` fixtures. |
| `formatting helpers` | `:215` | `padAnsi` and `formatFileLine` width arithmetic. |
| `SidebarComponent rendering` | `:226` | Full-height vs floating layout, buffer gutter, vertical padding, the collapsed rail, `◀` restore marker, per-file row coloring, the git-detail toggle, the "not a git repo" and "clean working tree" paths, and the **trim pin** at `:396` asserting only `Git` then `Tasks` headings appear. |
| `parseTasksJson` | `:422` | Valid JSON, non-JSON, missing `tasks` array, empty store, per-field type violations, and tolerance of extra fields. |
| `projectKey` | `:519` | The encoding itself, basename-collision safety, and the empty-path edge (`/` → `----`). |
| `countTasks` | `:538` | Bucket counts and the completed-blocker exclusion. |
| `toTaskRows` | `:606` | Status mapping, blocker derivation, `maxRows` cap and truncation count. |
| `Tasks section rendering` | `:675` | Heading, both "no tasks" paths, the summary header, per-row glyph / status / `agentType` badge, the `▶` affordance, `…N more` overflow, and the `selectTask` callback. |
| `filesystem source resolution` | `:970` | All three source scopes against real temp dirs, `loadTasksState` parse / merge / dedup, and the `projectKey` byte-parity check (`:1166`). |
| `sidebar_event tool` | `:1275` | Tool registration, parameter shape, per-invocation emission, missing `data` / `target`. |
| `sidebar:event handler` | `:1334` | Each of the 6 actions against `SidebarState` and `ctx.ui.notify`; `clear` with and without a target; FIFO eviction at 50; cross-extension emit; the unloaded-`ctx` swallow. |

The suite has no TUI dependency. Renderer tests build state via the
`state()` helper (`:45`) and a stub `theme` whose `fg` returns the text
uncolored (`:40–43`), so assertions match on visible substrings
(`▶`, the status glyphs, `…N more`, the headings) rather than ANSI
sequences. Listener tests reconstruct the wiring against a fake
`pi` — `makeFakePi` (`:1196`, capturing the registered tool, a
subscriber map, an emit log, and a `vi.fn()` notify that can be made
to throw), `makeFakeCtx` (`:1248`), and `freshState` (`:1254`). Every
`registerSidebarEventTool` test is therefore a fresh wiring against
fresh state, per the note at `sidebar-event-tool.ts:66–67`.

### Verification gates

`npm run verify` (`package.json:49`) is the single combined gate:

```bash
cd pi-sidebar && npm run verify
# = npm run typecheck && npm test && npm run pack:dry
```

- `npm run typecheck` — `tsc --noEmit` against `tsconfig.json`
  (`target: ES2022`, `module: NodeNext`, `strict: true`,
  `include: ["extensions/**/*.ts", "tests/**/*.ts"]`).
- `npm test` — `vitest --run`. Current result: **65 passed / 65**.
- `npm run pack:dry` — `npm pack --dry-run`. Confirms the tarball is
  the 9 files that actually exist: `package.json`, `tsconfig.json`,
  `README.md`, and the 6 source files under `extensions/`.

Because `pi-sidebar` is outside the bun workspace, this gate runs
independently of the root `orchestrator:typecheck` + `orchestrator:test`
pre-commit hook.

## Fork lineage

`pi-sidebar/` is a vendored fork of [`jrimmer/pi-sidebar`][upstream]
(BSD-3-Clause, Copyright (c) 2026 Jason Rimmer). The fork was developed
standalone at `~/Project/pi-sidebar-sages/` and vendored into this
monorepo at `19ea4d5 feat(sidebar): vendor pi-sidebar into Sages as a
sage peer`. Two commits have landed on top of the vendored copy:

- `e74742a chore: remove useless pi-sidebar content`
- `251a102 refactor(sidebar): trim to Git + Tasks sections only`

The fork's three goals, all landed upstream in the standalone repo as
of v0.2.0:

1. **Surface the Sages task board in the sidebar** — the
   `sections/tasks.ts` polling + rendering described above.
2. **Bidirectional `sidebar_event` channel** — the LLM tool plus the
   `pi.events.on("sidebar:event", …)` listener in
   `sidebar-event-tool.ts`.
3. **Inject context back into the LLM on row interaction** — the `▶`
   affordance, `ctrl+shift+t`, and `pi.appendEntry`.

For the per-goal commit SHAs, the "Merged to main" table, upstream
remotes, and upstreaming notes, read `SAGES-FORK.md` in the standalone
`~/Project/pi-sidebar-sages/` repo. That file is the authoritative
lineage record and is not duplicated here.

> **Vendoring caveat.** The `LICENSE`, `SECURITY.md`, `assets/`, and
> `docs/` directories present in the standalone fork are **not** in the
> vendored tree — they were removed in `e74742a`, which also reduced
> `pi-sidebar/README.md` to a stub. Upstream BSD-3-Clause attribution
> is therefore currently recorded only in
> `pi-orchestrator/scripts/install.sh:40–42`, and `package.json:6`
> reads `"license": "MIT"` rather than the upstream SPDX identifier.
> Both are open questions for the maintainer; this doc records the
> current state rather than resolving it.

### Deploy wiring

`pi-orchestrator/scripts/install.sh` owns the sage-peer deploy:

- `:110`, `:112` — `pi-sidebar` is one of the required repo dirs for a
  Sages install.
- `:215–237` — the deploy block, defining
  `PI_SIDEBAR_SRC_REL="pi-sidebar"` (`:236`) and
  `PI_SIDEBAR_DEST_DIR="$PI_DIR/packages/pi-sidebar-sages"` (`:237`).
  The `-sages` suffix keeps a user's upstream `pi-sidebar` install
  from colliding, so both can coexist.
- `:873` — `sidebar_installed()`, probed before the `sages-board-watch`
  routine auto-activates: when the sidebar is present, its Tasks panel
  is the better passive awareness surface.

## Where to learn more

- [`pi-sidebar-sages.md`](./pi-sidebar-sages.md) — the Sages-side
  companion. The five `sidebar:event` emit sites across
  `pi-orchestrator`, `pi-tasks`, and `pi-evaluator`, plus the sage-peer
  packaging table. Read it for the *producer* side of the channel;
  this doc is the *consumer*.
- [`pi-tasks.md`](./pi-tasks.md) — the task board the Tasks panel
  polls. `projectKey` (`pi-tasks/src/task-paths.ts:50`) is the
  reference implementation the sidebar's copy must byte-match, and
  `orchestratorProjectTaskFile` (`:90`) is scope #1's writer.
- [`pi-orchestrator.md`](./pi-orchestrator.md) — the runtime that sets
  `ORCHESTRATOR_WORKDIR` and emits `highlight` on intent conversion.
- [`pi-evaluator.md`](./pi-evaluator.md) — the opt-in reward-mode tool
  whose `eval_score` emits `log` events.
- [`pi-sidebar/extensions/sidebar/sidebar-event-tool.ts`](../../../pi-sidebar/extensions/sidebar/sidebar-event-tool.ts)
  — the listener itself. Small enough (180 lines) to read in full; it
  is the whole consumer-side contract.
- [`pi-sidebar/extensions/sidebar/sections/tasks.ts`](../../../pi-sidebar/extensions/sidebar/sections/tasks.ts)
  — the board-polling implementation: source resolution, parsing,
  counting, row projection, and the renderer, in one 441-line file.
- `pi-sidebar/README.md` — currently a stub (see the vendoring caveat
  above). `~/Project/pi-sidebar-sages/README.md` in the standalone fork
  repo holds the full upstream README.
- `~/Project/pi-sidebar-sages/docs/` — the fork's own documentation,
  including `architecture/native-tui-window-future.md` (the window-region
  design behind the overlay limitation above) and
  `architecture/security-performance.md`.

[upstream]: https://github.com/jrimmer/pi-sidebar

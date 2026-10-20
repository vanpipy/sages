# `pi-sidebar-sages` — fork notes

> **Vendored into Sages at `sages/pi-sidebar/` (GC: sidebar task panel).**
> This copy is now the canonical location; the standalone fork at
> `~/Project/pi-sidebar-sages/` is the pre-vendoring reference. Upstream
> remains `jrimmer/pi-sidebar` (BSD-3-Clause, Copyright (c) 2026 Jason
> Rimmer).
>
> Three names now refer to the same code, and they are deliberately
> different:
>
> | Name | Where | What it is |
> |---|---|---|
> | `@sages/pi-sidebar` | `sages/pi-sidebar/package.json` | The vendored package name, under the Sages scope like `@sages/pi-tasks`. |
> | `~/.pi/packages/pi-sidebar-sages` | deployed by `pi-orchestrator/scripts/install.sh` | The install destination. The `-sages` suffix keeps it from colliding with an upstream `pi-sidebar` install. |
> | `pi-sidebar-sages` | the pre-vendoring standalone repo | The reference copy. Historical commit SHAs below refer to that repo's history and are kept for lineage. |

`pi-sidebar-sages` is a fork of [`jrimmer/pi-sidebar`](https://github.com/jrimmer/pi-sidebar). It tracks upstream on `local-src` (a sibling clone) and `upstream` (`https://github.com/jrimmer/pi-sidebar.git`), and accumulates the divergences listed below.

## Why a fork

The Sages orchestrator needs the sidebar to do three things upstream does not:

1. **Surface the Sages task board** so the user sees intent / plan tasks in the same window they see git status. This replaces the chat-polluting `sages-board-watch` pulse routine (see `pi-orchestrator/templates/sages-routines/sages-board-watch.json`). **Status: landed (stable v0.2.0)** — landed on `feat/sages-tasks-panel` (commit `0fca88a`), see `extensions/sidebar/sections/tasks.ts`.
2. **Receive events from the main LLM** via a new `sidebar_event` tool so the orchestrator can highlight a task as it dispatches, log a verdict as it completes, or show a toast when an evaluation finishes. **Status: landed (stable v0.2.0)** — landed on `feat/sages-sidebar-event` (commit `31eb34f`), see `extensions/sidebar/sidebar-event-tool.ts` (the tool) + the `feat/sidebar-event-wiring` branch in `Project/sages/` (the Sages-side emit points: `pi-orchestrator`, `pi-tasks`, `pi-evaluator`).
3. **Inject context back into the main LLM** when the user interacts with a task row, parallel to how `system` notes work today. **Status: landed (stable v0.2.0)** — landed on `feat/sages-tasks-click` (commit `ae898a3`). Each Tasks row carries a `▶` affordance; `ctrl+shift+t` picks the top task and appends a system note via `pi.appendEntry`. The TUI's non-capturing overlay can't natively focus rows, so the keybinding is the bridge.

The fork keeps the upstream overlay renderer, theming, and section pattern intact. New behaviour is added as new files plus opt-in env vars, so a future rebase against upstream is a clean diff. All 3 goals above are landed on `main` as of v0.2.0; see [Merged to main](#merged-to-main) for the commit list.

## Upstream remotes

| Remote | URL | Purpose |
|---|---|---|
| `local-src` | `/home/leroy/Project/pi-sidebar` | Sibling clone used as the source for the initial fork and ongoing upstream sync |
| `upstream` | `https://github.com/jrimmer/pi-sidebar.git` | The jrimmer/pi-sidebar repository |

Sync cadence: TBD. A typical workflow is `git fetch upstream && git rebase upstream/main` on a `sages` branch, then merge into `main`.

## Diverged areas (filled in as work proceeds)

| Area | Divergence | Reason |
|---|---|---|
| `package.json` | Renamed to `pi-sidebar-sages`, version `0.2.0`, sages keyword added. After vendoring, further renamed to `@sages/pi-sidebar` to match the `@sages/pi-tasks` peer convention (the deploy path keeps the `-sages` suffix). | Identity + npm install differentiation |
| `README.md` | Title + fork banner; new config + commands for the Tasks section | Identity + new feature docs |
| `extensions/sidebar/sections/tasks.ts` | New section: parser, counts, rows, renderer, file loader, `▶` selectable affordance on each row, `selectTask` callback on `SidebarSectionContext` | Render Sages task board in the sidebar (intent / in_progress / completed / blocked counts + per-task glyph + `agentType` badge); keybinding injects `Sidebar: user selected task #N — <subject>` into the next LLM turn |
| `extensions/sidebar/types.ts` | +`Task`, +`TaskRow`, +`TasksState`, +`EventLogEntry`, +`SidebarState.highlightedId`/`badges`/`eventLog`, +`SidebarRenderOptions.tasks.maxRows`, +`SidebarSectionContext.selectTask?` | Section state plumbing + reverse-channel hook + event-channel shape |
| `extensions/sidebar.ts` | +`refreshTasks()` polling (reuses `PI_SIDEBAR_REFRESH_MS`), +`renderTasksSection` in `SIDEBAR_SECTIONS`, +env reads (`PI_SIDEBAR_TASKS`, `PI_SIDEBAR_TASKS_MAX`), +`/sidebar-refresh-tasks` command, +tasks block in `/sidebar status`, +`ctrl+shift+t` shortcut (`pickTopTaskId` → `selectTask` → `pi.appendEntry("system", …)`), +`selectTask` arg on `SidebarComponent` constructor, +`registerSidebarEventTool(...)` call, +`badges`/`eventLog` defaults on `state` | Wire section + wire the `sidebar:event` listener into the existing render path + wire the reverse-channel keybinding |
| `extensions/sidebar/sidebar-event-tool.ts` | New file | LLM-facing `sidebar_event` tool + `pi.events.on("sidebar:event", …)` handler that mutates state and calls `requestRender` |
| `tests/sidebar.test.ts` | Tasks + sidebar_event tests | TDD discipline; the 8 filesystem fixtures added in `feat/sages-tasks-source-fixtures` lock in the 3-source resolution (`loadTasksState`, `resolveTasksSource`, `readWorkspaceTasks`) and the byte-for-byte `projectKey` parity with `pi-tasks/src/task-paths.ts:50` |
| `package.json` | +`typebox` peer + devDep | Required for TypeBox parameter schemas on the LLM tool (transitively available via `pi-coding-agent`) |
| `README.md` | +"Sidebar event channel" section, +Tasks data section, +feature bullets | Docs the new tool + programmatic emit form + the 3-source tasks resolution |
| `.pi/` | Never touched | Sages convention |

## Goal status (filled in as work lands)

- Goal #1 — Surface the Sages task board in the sidebar. Landed on `feat/sages-tasks-panel` (commit `0fca88a`), now on `main` via merge commit `eee4cab`.
- Goal #2 — Bidirectional `sidebar_event` channel. Landed on `feat/sages-sidebar-event` (commit `31eb34f`), now on `main` via merge commit `cf1fbab`. Adds the LLM tool (`show` | `highlight` | `badge` | `toast` | `log` | `clear`) and the `pi.events.on("sidebar:event", …)` listener that mutates `SidebarState` + calls `requestRender`.
- Goal #3 — Inject context back into the LLM on user interaction with a task row. **Landed** on `feat/sages-tasks-click` (commit `ae898a3`), now on `main` via merge commit `f619c5f`. Each Tasks row carries a `▶` affordance; `ctrl+shift+t` picks the top task and appends a system note via `pi.appendEntry`.

## Merged to main

All 3 goals are now on `main` as of stable v0.2.0. The 4 feature commits below landed on their own branches and were merged in the order shown. The bootstrap commit `d3f686c` (`chore(fork): rename to pi-sidebar-sages and add fork identity`) is the fork's identity commit; everything since is the Sages-fork work.

| Feature commit | Branch | Merge commit | Title |
|---|---|---|---|
| `0fca88a` | `feat/sages-tasks-panel` | `eee4cab` | `feat(sidebar): add Tasks panel section with task board polling` |
| `31eb34f` | `feat/sages-sidebar-event` | `cf1fbab` | `feat(sidebar): add sidebar_event tool + sidebar:event channel` |
| `c644f07` | `feat/sages-tasks-source-fixtures` | `7c29e6a` | `test(sidebar): add filesystem fixtures for tasks source resolution` |
| `ae898a3` | `feat/sages-tasks-click` | `f619c5f` | `feat(sidebar): add reverse-channel task pick via ctrl+shift+t` |

`npm run verify` reports 64 tests passing.

## Install (fork)

The fork is a Sages sage peer, so it installs with the rest of the
stack:

```bash
bash sages/pi-orchestrator/scripts/install.sh    # deploys sages/pi-sidebar -> ~/.pi/packages/pi-sidebar-sages
/reload
```

Standalone npm install of the fork is still possible, but it is no
longer the canonical path:

```bash
pi remove git:github.com/jrimmer/pi-sidebar          # if previously installed
pi install /home/leroy/Project/pi-sidebar-sages       # install the fork
/reload
```

For local development against the checkout, edit in place, then `/reload`.

## Upstreaming

Nothing in this fork is incompatible with upstream. If a piece stabilizes, the relevant commits can be cherry-picked into a PR against `jrimmer/pi-sidebar`. The `sidebar_event` tool is the most likely candidate to upstream first, since it is generic enough that any pi session could benefit.

## Linux

BSD-3-Clause, inherited from upstream.
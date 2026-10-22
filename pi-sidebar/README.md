# pi-sidebar

Floating right sidebar for pi. One section: a live task panel driven by a
file. No LLM, no runtime dependencies, and — deliberately — no import of
any other package in the Sages monorepo.

```
# @sages/pi-sidebar
Floating right sidebar for pi with git diff/status, session metadata, and a Sages task board panel
```

## The task panel

The panel polls one of three task files, in priority order, and renders
`{completed}/{total}  ◼ N running …` plus one glyph per task:

1. `${ORCHESTRATOR_WORKDIR}/<projectKey(cwd)>/tasks/tasks.json`
2. `${cwd}/.pi/tasks/tasks-<sessionId>.json`
3. `${cwd}/.pi/tasks/*.json`, merged and deduped by id

Absent all three it renders a muted "no tasks". Nothing else in the
package writes to those files.

## The mailbox

The panel is also an **intake point**. Anyone — a UI button, `curl`, a
cron job, another pi session — drops a JSON file describing an `intent`
task into a mailbox; the sidebar polls it, and when the session goes
genuinely idle it delivers one follow-up turn to the main agent. The
agent claims an intent, breaks it into `plan` tasks, does the work, and
closes it.

```
${ORCHESTRATOR_WORKDIR:-<tmpdir>/sages-orchestrator}/<projectKey(cwd)>/mailbox/tasks.json
```

The mailbox file is byte-compatible with the panel's existing
`parseTasksJson`, so **the panel renders mail with no renderer change**:

- no new status vocabulary — "unplanned" is `pending`, "claimed" is
  `in_progress` + `owner`
- parent linkage is `metadata.sourceIntent` on each `plan` task

```jsonc
{
  "tasks": [
    {
      "id": "m-3",
      "type": "intent",              // "intent" = mail, "plan" = a breakdown step
      "subject": "Add retry to the uploader",
      "description": "…the mail body is the entire brief…",
      "status": "pending",
      "owner": "sess-abc",           // set by mailbox_claim
      "metadata": {},
      "blocks": [],
      "blockedBy": [],
      "createdAt": 1756000000000,
      "updatedAt": 1756000000000
    }
  ]
}
```

The sidebar spawns nothing. No subagent RPC, no dispatcher, no cascade —
that was scoped out deliberately: the main agent is going to claim the
work anyway, and it has the session context a fresh planner would lack.

### Tools

Five LLM tools replace the thirteen the main agent uses today. All five go
through one `MailboxStore`, so they share the lock discipline and the
read-modify-write path, and none can see a torn file.

| Tool | Contract |
|---|---|
| `mailbox_list(filter?)` | Pure read. Unclaimed intents first, then plan tasks. |
| `mailbox_claim(id)` | Atomic `pending → in_progress` + `owner`. Refuses if already claimed. |
| `mailbox_breakdown(intentId, tasks[])` | Writes `plan` tasks linked by `metadata.sourceIntent`. Refuses unless the intent is claimed **by this session**. |
| `mailbox_update(taskId, {status, result})` | Progress on one **plan** task; `result` lands in `metadata`. Refuses on an intent, and refuses to reopen a completed task. |
| `mailbox_complete(intentId, summary)` | Closes the intent. **Refuses unless every child is `completed`.** |

### Wake

The wake speaks only at a real idle boundary. `turn_end` is not that
signal — pi emits it after every assistant message, including ones inside
an ongoing tool-call chain — so a `turn_end` carrying a `toolCall` /
`toolUse` block is ignored, and the announcement waits for the next clean
one. The board is re-read inside `fire()` before speaking, and each id is
announced once (plus one re-announce after the backoff).

Delivery is **fire-and-forget**. `pi.sendUserMessage` is a synchronous
wrapper that discards the promise the underlying async call returns, and
the host swallows that promise's rejection into its own error emitter — so
a lost note is not observable here. It self-heals through the backoff
rather than an immediate retry.

**Print mode is off by default.** `pi -p` is a one-shot invocation and a
wake appends a follow-up turn, so unclaimed mail would turn it into a
drain loop. Set `PI_SIDEBAR_MAILBOX_PRINT_MODE=on` to opt a headless host
back in. The intake tools stay registered either way; only the automatic
wake is gated.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PI_SIDEBAR_ENABLED` | `on` | Master switch for the panel. |
| `PI_SIDEBAR_WIDTH` | `34` | Panel width in columns. |
| `PI_SIDEBAR_MAX_HEIGHT` | `60%` | Height cap — rows or `"NN%"`. |
| `PI_SIDEBAR_BOTTOM_RESERVE` | `10` | Rows reserved for the composer (floating layout). |
| `PI_SIDEBAR_BUFFER` | `1` | Left gutter in full-height layout. |
| `PI_SIDEBAR_REFRESH_MS` | `5000` | Panel poll interval. |
| `PI_SIDEBAR_TASKS` | `on` | The task section. |
| `PI_SIDEBAR_TASKS_MAX` | `10` | Max rows before `…N more`. |
| `PI_SIDEBAR_AUTOHIDE_WORKING` | `off` | Hide the panel while a turn runs. |
| `PI_SIDEBAR_FULL_HEIGHT` | `off` | Span the window instead of floating. |
| `PI_SIDEBAR_MIN_TERM_WIDTH` | `0` | Opt-in hard term-width gate; `0` = shrink-to-fit. |
| `PI_SIDEBAR_MIN_PANEL_WIDTH` | `20` | Narrowest legible panel. |
| `PI_SIDEBAR_MIN_TERM_HEIGHT` | `12` | Height floor. |
| `PI_SIDEBAR_MIN_CONTENT_ROWS` | `4` | Usable rows floor. |
| `PI_SIDEBAR_OFFSET_Y` | `0` | Vertical nudge from the top-right anchor. |
| `PI_SIDEBAR_INSET_RIGHT` | `0` | Right-edge breathing room. |
| `PI_SIDEBAR_FILL_ROWS` | `200` | Fill rows in full-height mode. |
| `PI_SIDEBAR_VERTICAL_PADDING` | `1` | Blank rows above/below the section. |

### Mailbox

| Variable | Default | Meaning |
|---|---|---|
| `PI_SIDEBAR_MAILBOX` | `on` | `off` disables intake, poll and wake entirely. |
| `PI_SIDEBAR_MAILBOX_POLL_MS` | `10000` | The mailbox poll floor. |
| `PI_SIDEBAR_WAKE_DEBOUNCE_MS` | `1500` | Collapses idle→idle→idle flaps into one announcement. |
| `PI_SIDEBAR_WAKE_BACKOFF_MS` | `300000` | How long an announced, still-unclaimed intent sits quiet before one re-announce. |
| `PI_SIDEBAR_MAILBOX_PRINT_MODE` | `off` | `on` drains the mailbox on a headless `pi -p` host. Off because a wake turns one-shot into a loop. |

## Commands

- `/sidebar [collapse|expand|on|off|status|full|floating]`
- `/sidebar-refresh`, `/sidebar-refresh-tasks`
- `ctrl+shift+s` — collapse / expand
- `ctrl+shift+t` — inject a system note naming the top task. A mailbox id
  in the note points at `mailbox_list`; a board id keeps the `TaskGet` path.

## Development

```
npm install
npm run typecheck
npm test
npm run verify     # typecheck + test + pack --dry-run
```

`pi-sidebar` is deliberately **not** a bun workspace member: it keeps its
own npm + vitest + tsc toolchain so those dependencies stay out of bun's
workspace resolution, which means it is verified separately from the
monorepo gates.

## Design

`docs/design-mailbox.md` is the approved design for the mailbox — the
loop, the file format, the wake state machine, and the calls made along
the way.
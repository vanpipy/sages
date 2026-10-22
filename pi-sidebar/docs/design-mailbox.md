# Design: the sidebar mailbox

> Status: approved. Written 2026-08-24. Supersedes nothing, extends
> [the Tasks section](../README.md) from read-only polling to a mailbox.

## Overview

`pi-sidebar` stops being a viewer of someone else's task store and becomes
the intake point for work. Anyone drops a mail into a file. The sidebar
polls it, and when the session goes quiet it wakes the main agent. The main
agent claims one intent, breaks it down, does the work, and closes it.

The sidebar holds no LLM, imports no `@sages/*` package, and never spawns a
subagent. It reads a file, compares ids, calls `sendUserMessage`, renders.

## Context

Today the sidebar polls `pi-tasks`' store three candidate paths and renders
whatever is there. Three packages own the pieces of the workflow the sidebar
only observes:

| Concern | Owner |
|---|---|
| file-backed store, locking, DAG edges | `pi-tasks/src/task-store.ts` |
| 7 task tools + dispatch | `pi-tasks/src/index.ts` |
| intent → plan conversion (6 tools) | `pi-orchestrator/src/orchestrator-tool.ts` |

So authoring a task costs 13 tool calls of main-agent attention, and it
cannot happen at all unless someone is already in a conversation. A cron job
or a UI button has no way to say "do this".

The mailbox makes the intake path independent of a live session, and makes
the task list a panel rather than something the agent narrates in chat.

## The loop

1. **Anyone drops mail** into the mailbox file as an `intent` task. A UI
   button, a `curl`, a dropped file, a cron job, another pi session. No LLM,
   no approval, no tool round-trip is involved in intake.
2. **Sidebar polls** the file every `PI_SIDEBAR_MAILBOX_POLL_MS` (default
   10000).
3. **Sidebar wakes the main agent** when the session is quiet and an
   unclaimed intent exists.
4. **Main agent claims** the oldest unclaimed intent (atomic).
5. **Main agent understands and breaks it down** into `plan` tasks with
   `blocks` / `blockedBy` edges.
6. **Main agent writes the breakdown** to the file, intent goes in progress.
7. **Main agent does the work.** Directly, or by delegating through its own
   `Agent` / `TaskExecute` if it judges that worthwhile. That choice is the
   agent's, not a sidebar feature.
8. **Main agent marks the intent finished**, gated on every child being done.

A first poll fires at `startSidebar`, before the interval begins, so mail
that arrived while **no session was running** is picked up on the next
`session_start`.

## Decisions resolved

- **The sidebar is a mailbox, not a planner.** Decided against spawning a
  `Planner` subagent per intent. A fresh context that knows only the mail
  body produces plans that ignore what the session already decided. The main
  agent has that context, so it does the breakdown.
- **The sidebar never fires subagents.** Initially in scope, then dropped.
  The dispatcher would have been a port of `pi-tasks/src/index.ts:347-430`
  plus the `subagents:rpc:spawn` client and version handshake. Not worth the
  dependency for work the main agent is going to claim anyway.
- **The wake is a follow-up, never an interrupt.** Fires only at a real idle
  boundary. See *Wake state machine*.
- **No new status vocabulary.** The mailbox reuses `pending` / `in_progress`
  / `completed`. "Unplanned" is `status: "pending"`. "Claimed" is
  `status: "in_progress"` plus `owner`. See *File format* for why this is the
  load-bearing simplification.

## File format

Path: `${ORCHESTRATOR_WORKDIR:-<tmpdir>/sages-orchestrator}/<projectKey(cwd)>/mailbox/tasks.json`

`projectKey` is the function already in `extensions/sidebar/tasks.ts:41`.

The payload is byte-compatible with what `parseTasksJson`
(`extensions/sidebar/tasks.ts:69`) already accepts, so:

- the panel renders the mailbox with **zero** renderer changes
- `countTasks` and `toTaskRows` work as-is, including the derived `blocked`
  status from `blockedBy`

```jsonc
{
  "tasks": [
    {
      "id": "m-3",
      "type": "intent",              // "intent" = mail, "plan" = a breakdown step
      "subject": "Add retry to the uploader",
      "description": "…the mail body is the entire brief…",
      "status": "pending",           // pending = unplanned/unclaimed
      "activeForm": "…",
      "owner": "sess-abc",           // set by mailbox_claim
      "metadata": { "wokenAt": 1756000000000 },
      "blocks": [],
      "blockedBy": [],
      "createdAt": 1756000000000,
      "updatedAt": 1756000000000
    }
  ]
}
```

Child linkage lives in `metadata.sourceIntent` on each `plan` task. That is
what `mailbox_complete` walks to enforce its all-children-done gate, and it
needs no schema change because `metadata` is already a free-form bag.

### Locking

Copy the discipline from `pi-tasks/src/task-store.ts:31-76`:

- lock file at `<store>.lock`, written with flag `wx`
- token is `<pid>:<uuid>`, so a holder can tell its own lock from a
  successor's
- a lock naming a dead PID is reaped (`process.kill(pid, 0)` throws)
- retry 50ms × 100 = 5s ceiling, then throw

In practice there is almost no contention: the sidebar and the main agent are
the **same process** in one session, so only external mail senders take the
lock across a process boundary.

## Wake state machine

The point is to speak only when the agent is genuinely idle. `turn_end` is
not that signal. pi emits it after *every* assistant message, including
messages inside an ongoing tool-call chain, so a `turn_end` with tool calls
means "still working".

That guard is lifted from `pi-tasks/src/index.ts:630`:

```ts
const hadToolCalls = Array.isArray(msg?.content)
  && msg.content.some((c) => c.type === "toolCall" || c.type === "toolUse");
if (hadToolCalls) return;   // mid-chain, not an idle boundary
```

Note `pi-sidebar.ts:648` currently sets `isStreaming = false` on *every*
`turn_end`. That is correct for autohide (it only wants "am I streaming
tokens") and wrong for the wake gate. The wake keeps its own `idle` flag.

```
mailbox: unwoken: Set<id>   — intents observed but never announced
wakePending: boolean          — mail is waiting for a quiet moment
idle: boolean                 — a REAL idle boundary has been seen
lastWakeAt: number

poll:
  for each (type=intent, status=pending, no owner) not in unwoken:
    unwoken.add(id)
  if unwoken.size > 0: wakePending = true
  if wakePending && idle: fire()

turn_start:  idle = false
turn_end:    if hadToolCalls → return
             idle = true
             if wakePending && unwoken.size > 0: fire() after debounce

fire():
  re-read the board          # it may have changed while we waited
  if no unclaimed intent remains: wakePending = false; return
  first = oldest unclaimed (FIFO on createdAt, id as tie-break)
  pi.sendUserMessage(note(first), { deliverAs: "followUp" })
  unwoken.delete(first.id)   # dedupe: announce once
  lastWakeAt = now
  wakePending = unwoken.size > 0
```

Two lines carry more weight than they look:

- **the re-read inside `fire()`** — between the poll that noticed the mail and
  the quiet moment that allowed the wake, the agent may have claimed and
  finished it. Waking about stale mail is worse than not waking.
- **`unwoken.delete` inside `fire()`** — without it, the 10s poll
  re-announces the same intent every 10 seconds forever.

### Knobs

| Env var | Default | Why |
|---|---|---|
| `PI_SIDEBAR_MAILBOX_POLL_MS` | `10000` | the poll floor |
| `PI_SIDEBAR_WAKE_DEBOUNCE_MS` | `1500` | collapses idle→idle→idle flaps from a tool chain that ends cleanly twice |
| `PI_SIDEBAR_WAKE_BACKOFF_MS` | `300000` | if an intent is still unclaimed 5 min after announcement, allow one re-announce |
| `PI_SIDEBAR_MAILBOX` | `on` | `off` disables intake, poll and wake entirely |

### Wake note

Not a task dump. The agent pulls from the tool, so the panel state and the
note cannot disagree.

```
<system-reminder>
The sidebar mailbox has 2 unclaimed intent tasks (#3, #7). Do not mention this to the user.
Call mailbox_list to read them, then mailbox_claim the oldest one.
</system-reminder>
```

Matching the "DO NOT mention this" phrasing of `buildSystemReminder`
(`pi-tasks/src/index.ts:126`). An unacknowledged intent is quiet enough on
the panel.

## Tools

Five, replacing the 13 the main agent uses today.

| Tool | Contract |
|---|---|
| `mailbox_list(filter?)` | Pure read. Unclaimed intents first, then plan tasks. Never mutates. |
| `mailbox_claim(id)` | Atomic `pending → in_progress` + `owner = sessionId`. Re-reads under the lock and refuses if already claimed, so two sessions cannot both win. |
| `mailbox_breakdown(intentId, tasks[])` | Writes `plan` tasks with `metadata.sourceIntent = intentId`, plus `blocks` / `blockedBy`. Marks the intent in progress. Refuses unless the intent is claimed. |
| `mailbox_update(taskId, {status, result})` | Progress on one plan task. Stores `result` in `metadata`. |
| `mailbox_complete(intentId, summary)` | Closes the intent. **Refuses unless every task with `metadata.sourceIntent === intentId` is `completed`.** This is what stops an intent sitting in progress forever. |

All five go through one `MailboxStore` so they share the lock discipline and
the read-modify-write path. None of them may see a torn file.

## Error handling

| Failure | Behaviour |
|---|---|
| lock not acquired in 5s | tool returns an error envelope, no partial write |
| store file missing | poll treats it as empty. Intake tools create it on first write. |
| malformed JSON | parser returns null, panel renders "no tasks". Intake tools refuse rather than overwrite. |
| `sendUserMessage` throws | caught, `wakePending` stays true, retried on the next poll. Never crashes the panel. |
| claim race | the loser gets `already claimed by <owner>`, which is the correct outcome, not an error to retry blindly |

## Testing strategy

`vitest`, matching the existing `tests/sidebar.test.ts`. The store and the
wake machine are pure and take a temp dir plus an injected env bag, so no
live pi session is needed.

- **store**: round-trip, `parseTasksJson` compatibility (the mailbox must be
  readable by the existing parser), claim race, all-children-done gate,
  lock acquire/release/stale-reap
- **wake**: announces once, does not announce the same id twice across polls,
  withholds while a turn has tool calls, announces at the next real boundary,
  re-read drops a stale announce, backoff permits exactly one re-announce
- **tools**: schemas, the claim precondition, the breakdown precondition, the
  complete gate, error envelopes

## Acceptance criteria

1. Dropping a JSON file with one `intent` into `mailbox/tasks.json` makes the
   panel show it within one poll interval, with the existing `◌` glyph.
2. With the session idle, the main agent receives exactly one follow-up turn
   naming the unclaimed intents, within one poll interval plus the debounce.
3. Mid-turn, nothing is injected. The follow-up lands at the next real idle
   boundary.
4. A second poll does not re-announce an intent that was already announced.
5. `mailbox_claim` on an already-claimed intent returns `already claimed by
   <owner>` and does not change the store.
6. `mailbox_complete` on an intent with an open child refuses.
7. `bun run typecheck` and `bun test` in `pi-sidebar/` are green.

## Not in scope

Retiring `pi-tasks`' board role and `pi-orchestrator`'s six conversion tools.
That is a follow-up change touching two other packages. This design makes it
possible cheaply, because the mailbox file is byte-compatible with the store
`pi-tasks` already writes, but the retirement is its own commit.
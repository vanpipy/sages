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

On a headless host (`pi -p`) the loop does **not** run. See *Print mode*.

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
(`extensions/sidebar/tasks.ts:77`) already accepts, so:

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
observed: Set<id>     — intents ever seen unclaimed on THIS mailbox
pending:  Set<id>     — announcements still owed
announced: Map<id, {count, lastAt}> — announced, and when
idle: boolean         — a REAL idle boundary has been seen
lastWakeAt: number

poll(tasks):
  live = unclaimed intents in tasks
  forget any id in observed/pending/announced that left `live`
  for id in live:
    if id not in announced: observed += id; pending += id
    else if backoff elapsed and count <= 1:   pending += id
  wakePending = pending.size > 0
  if wakePending and idle: fire()

turn_start:  idle = false
turn_end:    if hadToolCalls → return
             idle = true
             if wakePending and pending.size > 0: fire() after debounce

fire():
  re-read the board          # it may have changed while we waited
  drop any pending id the board no longer shows as unclaimed
  if nothing unclaimed or nothing owed: wakePending = false; return
  first = oldest owed (FIFO on createdAt, id as tie-break)
  pi.sendUserMessage(note(live), { deliverAs: "followUp" })
  pending.delete(first.id)
  announced[first.id] = { count: previous + 1, lastAt: now }
  wakePending = pending.size > 0

session_shutdown: dispose() — cancel the debounce, clear all three sets
```

Three lines carry more weight than they look:

- **the re-read inside `fire()`** — between the poll that noticed the mail
  and the quiet moment that allowed the wake, the agent may have claimed and
  finished it. Waking about stale mail is worse than not waking.
- **`pending.delete` inside `fire()`** — without it the 10s poll
  re-announces the same intent every 10 seconds forever.
- **`dispose()` on shutdown** — `observed` / `pending` / `announced` are
  facts about ONE mailbox, and the store is re-pointed at the next
  session's `cwd`. Carried over, they would suppress a same-id intent in a
  different workspace until the backoff expired.

### Why three sets and not one `unwoken`

The first draft of this doc had a single `unwoken` set: `poll` added every
unclaimed intent not in it, and `fire` deleted the one it announced. Taken
literally those two lines **cancel each other**: the next poll re-adds the
id `fire` just deleted, so the intent is announced again 10s later, then
again, forever. The set that was supposed to prevent the loop was what
caused it.

Splitting "I have seen this" (`observed`) from "I still owe an
announcement" (`pending`) makes the loop unrepresentable rather than
merely unlikely. `announced` is a third thing entirely — a record of what
has been said and when — and it is what `PI_SIDEBAR_WAKE_BACKOFF_MS` reads
to permit exactly one re-announce.

### Why `idle` starts `true`

A literal reading of the pseudo-code (`idle: false` initially, set true only
by a clean `turn_end`) means a freshly started session never wakes: the
first `turn_end` sets `idle = true` but by then the poll may have already
run with `idle = false` and owed nothing, and if no mail arrives during the
turn the boundary has nothing to fire about. The feature would silently
depend on the user typing something before any mail is ever seen.

A session that has just started has a real idle boundary by definition, so
`idle` starts `true`. `dispose()` sets it back to `false` — a disposed
machine must not speak until it observes a fresh boundary.

### Print mode

`pi -p` is a **one-shot** invocation: ask once, print once. The wake is
incompatible with that shape by default, because a wake appends a
follow-up turn: `session_start` builds the machine, the first `turn_end`
fires it, and unclaimed mail extends the run one intent per turn. It is
bounded — `announced.count > 1` is terminal — but silently redefining
one-shot in a supported mode is not acceptable.

So `turn_end` is gated on `ctx.hasUI`, and a headless host opts in by name
with `PI_SIDEBAR_MAILBOX_PRINT_MODE=on`. A cron-driven `pi -p` that *wants*
the drain sets it; everything else keeps the one-shot contract.

The five intake **tools** stay registered either way — intake is a pure
file API and never speaks to the agent. Only the automatic wake is gated.

### Knobs

| Env var | Default | Why |
|---|---|---|
| `PI_SIDEBAR_MAILBOX_POLL_MS` | `10000` | the poll floor |
| `PI_SIDEBAR_WAKE_DEBOUNCE_MS` | `1500` | collapses idle→idle→idle flaps from a tool chain that ends cleanly twice |
| `PI_SIDEBAR_WAKE_BACKOFF_MS` | `300000` | if an intent is still unclaimed 5 min after announcement, allow one re-announce |
| `PI_SIDEBAR_MAILBOX` | `on` | `off` disables intake, poll and wake entirely |
| `PI_SIDEBAR_MAILBOX_PRINT_MODE` | `off` | `on` drains the mailbox on a headless `pi -p` host. Off because a wake turns one-shot into a loop |

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
| `mailbox_breakdown(intentId, tasks[])` | Writes `plan` tasks with `metadata.sourceIntent = intentId`, plus `blocks` / `blockedBy`. Marks the intent in progress. **Refuses unless the intent is claimed by THIS session** — claimedness alone is not enough, or a second session would append children to a brief another session owns. Self-edges are dropped; every edge is mirrored onto its blocker, including across the batch boundary onto a pre-existing task. |
| `mailbox_update(taskId, {status, result})` | Progress on one **plan** task. Stores `result` in `metadata`. Refuses on an intent (mail is closed by `mailbox_complete`) and refuses to move a `completed` task back — a silent reopen would re-block the gate below. Recording a result on a completed task is still allowed. |
| `mailbox_complete(intentId, summary)` | Closes the intent. **Refuses unless every task with `metadata.sourceIntent === intentId` is `completed`.** This is what stops an intent sitting in progress forever, which is why `mailbox_update` cannot reach an intent and vacate the check on a childless one. |

All five go through one `MailboxStore` so they share the lock discipline and
the read-modify-write path. None of them may see a torn file.

One consequence of the ownership rule worth stating plainly: an intent
claimed by a session that no longer exists — including the pre-`/new`
session in the same cwd — is stuck. `mailbox_claim` already refused to
steal it, and `mailbox_breakdown` now refuses to work on it too. That is
the intended fail-closed reading of `owner` (the field is the durable
claim record, and it is not timestamped, so nothing can tell a dead owner
from a live one), and the recovery is to clear `owner` in the file by
hand.

## Error handling

| Failure | Behaviour |
|---|---|
| lock not acquired in 5s | tool returns an error envelope, no partial write |
| store file missing | poll treats it as empty. Intake tools create it on first write. |
| malformed JSON | parser returns null, panel renders "no tasks". Intake tools refuse rather than overwrite. |
| `owner` present but not a string | treated as **claimed** by `(malformed owner)`. The file is written by anyone, so the fail-closed reading is the only safe one: coercing to `undefined` would read a claimed brief as fresh mail and re-announce it forever. Un-stick it by hand. |
| `sendUserMessage` rejects | **not observable.** Delivery is fire-and-forget: the extension-facing `pi.sendUserMessage` is a synchronous wrapper that discards the promise the underlying `async` call returns, and the host routes that promise's rejection into its own error emitter rather than back to the wake. The wake records the announcement as delivered, so a lost note stays lost until `PI_SIDEBAR_WAKE_BACKOFF_MS` permits the single re-announce. There is no immediate retry to schedule, and a `.catch()` at the call site would be dead code — the loader detached the promise first. |
| `sendUserMessage` throws synchronously | caught; the announcement stays owed and `wakePending` stays true. Defensive rather than hot — no shipped host throws here — and the panel never dies either way. |
| claim race | the loser gets `already claimed by <owner>`, which is the correct outcome, not an error to retry blindly |

## Testing strategy

`vitest`, matching the existing `tests/sidebar.test.ts`. The store and the
wake machine are pure and take a temp dir plus an injected env bag, so no
live pi session is needed.

- **store**: round-trip, `parseTasksJson` compatibility (the mailbox must be
  readable by the existing parser), claim race, all-children-done gate,
  lock acquire/release/stale-reap, malformed-`owner` fail-closed
- **wake**: announces once, does not announce the same id twice across polls,
  withholds while a turn has tool calls, announces at the next real boundary,
  re-read drops a stale announce, backoff permits exactly one re-announce,
  a swallowed async rejection triggers no retry, `dispose()` forgets the sets
- **tools**: schemas, the claim precondition, the breakdown ownership
  precondition, self-edge and cross-batch edge mirroring, the update
  plan-only and no-reopen rules, the complete gate, error envelopes
- **notes**: the `ctrl+shift+t` note routes a mailbox id to `mailbox_list`
  and a board id to `TaskGet`
- **env**: the four timing knobs' shipped defaults, and that a headless host
  is off unless `PI_SIDEBAR_MAILBOX_PRINT_MODE` says otherwise

## Acceptance criteria

1. Dropping a JSON file with one `intent` into `mailbox/tasks.json` makes the
   panel show it within one poll interval, with the existing `◌` glyph.
2. With the session idle, the main agent receives exactly one follow-up turn
   naming the unclaimed intents, within one poll interval plus the debounce.
   **Not** on a headless `pi -p` host unless `PI_SIDEBAR_MAILBOX_PRINT_MODE`
   is set.
3. Mid-turn, nothing is injected. The follow-up lands at the next real idle
   boundary.
4. A second poll does not re-announce an intent that was already announced.
5. `mailbox_claim` on an already-claimed intent returns `already claimed by
   <owner>` and does not change the store.
6. `mailbox_complete` on an intent with an open child refuses. So does
   `mailbox_update` on that child once it is `completed` — the gate cannot
   be re-blocked by a silent reopen.
7. `npm run typecheck` and `npm test` in `pi-sidebar/` are green.

## Not in scope

Retiring `pi-tasks`' board role and `pi-orchestrator`'s six conversion tools.
That is a follow-up change touching two other packages. This design makes it
possible cheaply, because the mailbox file is byte-compatible with the store
`pi-tasks` already writes, but the retirement is its own commit.
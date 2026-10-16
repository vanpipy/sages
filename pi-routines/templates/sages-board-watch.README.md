# `sages-board-watch` — runtime contract & fallback paths

This file documents the **runtime contract** that `sages-board-watch`
and any similar pulse routine rely on. The template content itself lives
in `pi-orchestrator/templates/sages-routines/sages-board-watch.json` (it
is the orchestrator's bundle, not the runtime package's); this README
sits in the runtime package because the fallback paths below are
runtime guarantees, not prompt instructions.

The template file is **unchanged** by this fix — the runtime learns from
observed outcomes, not from prompt edits.

---

## Observed failure mode ("sucked")

When the board is empty for an extended period, the routine fires its
~3.4 KB prompt (≈ 1.2K tokens) over and over. Each fire burns the full
prompt + a small `[~]` response and returns nothing actionable. With the
template interval at `120s`, that is roughly 720 fires/day even when
nothing happens; with the persisted interval stuck at `30s` (a stale
value from when the template still said `30s`), it was 2,880 fires/day.

The "suck" compounds when the LLM gets stuck on a long retry storm (the
analysis report
`.pi/orchestrator/analysis/orchestration-progress-2026-10-16.md` records
one observed fire taking **431.8 seconds** during a `tool_use.input`
provider-error cascade). Every setInterval hit during that 431 s window
becomes a `"routine already queued"` skip record, polluting the run
history without making progress.

Evidence (file:line references):

- `~/.pi/agent/extensions/routines/state.json` →
  `tickState['sages-board-watch']` shows 168 ticks over a 78-minute
  session, 14 consecutive `"routine already queued"` skips clustered
  around the 431.8 s fire, and an interval of `30_000` ms (template
  says `120_000` ms — persisted state is stale; the prior fix
  `fix: increase 30s to 120s for the sages-board-watch` only changed
  the template file).
- `src/executor.ts` → `buildPrompt` produces a ~3.4 KB header for
  every fire, regardless of board state.
- `src/scheduler.ts` → `armTrigger`'s `case "pulse"` used
  `setInterval(trigger.intervalMs)`, which fires at the persisted
  cadence regardless of whether the previous fire was productive.

The runtime now defends itself with **adaptive backoff** and explicit
fallback paths so the routine degrades gracefully when something goes
wrong.

---

## Fallback paths (runtime-enforced)

### 1. Empty-board fallback → adaptive backoff

After `BACKOFF_THRESHOLD = 2` consecutive silent fires (LLM returned
exactly `[~]`, or any response whose snippet starts with `[~]`), the
runtime doubles the effective interval up to a cap of `32×`
(multiplicative) or `10 minutes` (absolute). A non-quiet success resets
the counter.

Implementation:

- `recordRun` (in `src/executor.ts`) bumps
  `tickState.consecutiveSilentTicks` on `status === "silent"` and on
  `status === "success"` whose snippet is `[~]`-prefixed. It resets
  the counter on any other `"success"`. Error and skipped runs leave
  the counter alone so transient failures don't reset a legitimate
  quiet streak.
- `computePulseIntervalMs` (in `src/scheduler.ts`) reads that counter
  and returns the doubled (capped) value.
- The pulse arm uses **chained `setTimeout`** (not `setInterval`) so
  the next delay is re-evaluated after every fire, letting backoff
  engage immediately after a quiet streak — no need to wait for the
  original interval to expire before slowing down.

This is the **fast no-op** path: a routine whose board stays empty for
10 minutes costs ~6 fires (1 at base, 1 at 2×, 1 at 4×, 1 at 8×, 1 at
16×, 1 at 32× capped to 10 min) instead of 20.

### 2. Tick-acquire fallback → "lock held" skip

When a previous fire for the same routine is still in flight
(`runtime.pendingRun.routineId === routine.id`), a new pulse tick is
dropped with `skipReason: "lock held: previous fire still in flight"`
instead of stalling the watchdog or queuing another fire that would be
deduped anyway. The chained pulse arm schedules the next attempt after
the in-flight fire completes.

### 3. Catch-up fallback → one fire per session_start

`catchUpMissedTicks` (in `src/scheduler.ts`) fires **at most once per
routine per session_start**, for the trigger with the oldest missed slot
— not N compensating fires for N missed slots. This prevents a long
sleep / pi-down gap from producing a catch-up stampede that would blow
through `maxRunsPerDay`.

The catch-up entry carries a `contextNote` explaining the gap so the
routine's LLM doesn't mistake the fire time for its scheduled slot.

### 4. No-tools fallback → observed via adaptive backoff

If the routine's prompt references tools (`TaskList`, `TaskCreate`,
`TaskUpdate`, `task_convert_intent`) that are not in the session's tool
surface, the LLM's response degenerates into either a tool-call error
(which lands as `status: "error"` and leaves the silent counter alone)
or a `"[~]"` best-effort fallback (which is what adaptive backoff keys
on).

The runtime cannot directly probe the LLM's tool surface, so the
**observed contract** is:

- A successful first fire that routes an intent = "tools work, fire
  on schedule".
- Consecutive silent fires = "nothing to do or tools missing" — either
  way, back off.

Pinning test:
`tests/board-watch-backoff.test.ts` → "computePulseIntervalMs — unit".

---

## Backoff constants

| Constant | Value | Meaning |
|---|---|---|
| `BACKOFF_THRESHOLD` | 2 | Consecutive silent fires tolerated before backoff engages |
| `BACKOFF_FACTOR` | 2 | Multiplier per additional silent tick past threshold |
| `BACKOFF_MAX_MULTIPLIER` | 32 | Multiplicative cap (before absolute cap) |
| `BACKOFF_MAX_INTERVAL_MS` | 600 000 (10 min) | Absolute cap on effective interval |

For the template's `120s` base, the trajectory at backoff is:
120 s → 240 s → 480 s → 600 s (cap). One fire at each level, then the
cap.

---

## Template contract (unchanged by this fix)

The template content (`pi-orchestrator/templates/sages-routines/sages-board-watch.json`)
is **not modified** by this fix. The runtime learns from observed
outcomes, not from prompt edits.

The template still carries:

- `interval: 120s` — the **base** cadence. The runtime may double it
  dynamically; it never shortens it.
- `quiet: true` — `[~]` responses are suppressed in chat by the
  suppressor (`src/suppressor.ts`).
- `maxRunsPerDay: 2000` — soft cap enforced before opening an LLM
  turn, so capped fires consume zero provider tokens.
- The "on EVERY pulse tick you MUST call `TaskList` first" preamble
  — the runtime cannot detect when the board becomes non-empty, so
  the LLM still has to re-check on every fire. Adaptive backoff
  simply widens the gap between checks.

---

## Acceptance

- `cd ~/.pi/packages/pi-routines && bun test` is green
  (20 pass, 0 fail).
- `npx tsc --noEmit` is clean.
- `npx biome check .` is clean (only pre-existing schema-bumps
  warnings).

Refs: #13
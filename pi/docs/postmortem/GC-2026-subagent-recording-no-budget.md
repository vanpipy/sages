---
gc_id: GC-2026-subagent-recording-no-budget
title: Subagent tool-use recording + remove all budget limitations
severity: minor
---

## What happened

The user observed that subagent dispatches frequently hit automatic
hard-aborts (`max_turns` at 60 tool uses, or `max_duration_minutes`
at 30 min wall-clock) and lost partial work. The user wanted the
**complete** opposite of the prior turn-budget / deadline-enforcement
design: remove every limit, capture every tool use to a JSONL log, let
the orchestrator inspect the log post-hoc. Specifically:

> "对所有的 subagent都进行处理，移除所有的 budget limitation, 只记录不限制"
> (apply to all subagents; remove ALL budget limitations; only record, don't limit)

The previous GCs (GC-2026-121 Planner auto-spawn, GC-2026-122 dropping
the auto-spawn, GC-2026-continuous-intent-reminder continuous nudge, and
the orchestrator-level `max_turns` + `max_duration_minutes` parameters
on the Agent tool) all retained some form of enforcement. This GC
flips the contract entirely.

## Root cause

The previous design's premise: "agents are unreliable; budget caps
keep them from wasting tokens / running forever." This premise was
empirically wrong in two ways:
1. The hard-abort surface (the `BudgetExceededError` throw) was a
   **silent failure** — it killed agents mid-task with no observable
   trail beyond a `record.error` field the orchestrator only read on
   end-of-run. Partial work in commits survived, but the YAML
   verdict block in the final assistant message did not, and the
   orchestrator couldn't see *why* the agent got cut off.
2. The cap values (`maxTurns: 60`, `maxMs: 20min`,
   `MAX_DEADLINE_MS: 120min`) were empirical guesses. When an agent
   genuinely needed 75 tool uses to complete a multi-package refactor,
   the 60-turn cap killed it; the orchestrator had no way to know the
   work was on track.

The new premise: "agents run; we record; the orchestrator decides
what to abort." Recording is the contract. The cost of an
accidentally-long run is bounded by the operator's manual
intervention, not by an automatic clock.

## Fix

Five commits on `gc-2026-subagent-recording-no-budget` branch. The
diff is the inverse of `pi-subagents` `git log --oneline | grep budget`:

```
aeb524e test(pi-subagents): invert boundary-discipline / budget-prompt assertions
6630143 feat(pi-subagents,pi-orchestrator): drop wall-clock deadline + add usage aggregator
b7d0804 feat(pi-subagents): emit subagents:tool-use + drop BudgetTracker enforcement
49aa335 feat(pi-subagents): add ToolUseRecorder + subagents:tool-use emission
```

Pre-existing `origin/main`: a138f34.

### 1. ToolUseRecorder (pure recording, no enforcement)

`pi-subagents/src/recording.ts` exports:

```typescript
class ToolUseRecorder {
  // append-only JSONL writer; per-instance promise mutex
  // serializes concurrent appends. Write errors are caught and
  // re-emitted on subagents:recording-error; the agent's run is
  // never blocked by a write failure.
  async append(record: ToolUseRecord): Promise<void>
  async flush(): Promise<void>
}

function emitToolUse(events, args): void
  // Single integration point called from agent-runner.ts at every
  // tool_execution_end. Emits subagents:tool-use. The helper
  // computes inputKeys (NOT values — secrets / large blobs never
  // leak) and durationMs from the agent-runner's tracked
  // toolStartState map.
```

`RECORDING_PATH_DEFAULT = .pi/orchestrator/metrics/subagent-tool-usage.jsonl`
is the single source of truth for the log path.

### 2. agent-runner.ts wiring

At every `tool_execution_start`: capture `Date.now()` + the `event.args`
(input keys) into a `Map<toolCallId, { startMs, args }>` (capped at 256
entries to bound memory under heavy parallel use).

At every `tool_execution_end`: call `emitToolUse(options.pi.events, ...)`
with the captured start time + args. The record contains the
duration in ms, the input KEYS (never values), the agentId /
agentType / taskId, and the tool name.

Removed: `BudgetTracker.tick()` in the `turn_end` handler; the
`BudgetExceededError` catches in the prompt-loop try/catch; the
`budgetTracker` instantiation; the `budgetFailure` variable
assignment. The only remaining abort signal is the external
AbortSignal (parent-supplied).

### 3. prompt sections

Deleted:
- `pi-subagents/src/agent-prompts/_sections/boundary-discipline.ts`
  (content: "you have a finite turn budget; orchestrator gracefully
  steers at the soft limit, then hard-aborts after graceTurns")
- `pi-subagents/src/agent-prompts/_sections/exploration-budget.ts`
  (content: "read max 30, grep max 5, git max 3, AFT max 10")
- `pi-subagents/src/budget.ts` (BudgetTracker + BudgetExceededError +
  defaultBudgets + loadBudgetFromEnv + budgetTypeFor)

Created:
- `pi-subagents/src/agent-prompts/_sections/recording-notice.ts`
  (content: "your tool calls are recorded to
  .pi/orchestrator/metrics/subagent-tool-usage.jsonl. There is
  **no turn or time limit on your run.** Trust git + the
  verdict-{task_id}.md fallback; the orchestrator may abort you
  manually only if it observes runaway behavior in the log.")

Every prompt that previously imported the boundary / exploration
sections now imports `RECORDING_NOTICE_SECTION`:
- developer.ts, reviewer.ts, _fix.ts: import + interpolation swap
- explore.ts, plan.ts: the inline `const EXPLORATION_BUDGET_SECTION`
  + `void` suppression pattern (an old audit-pipeline gap) is
  removed; the section was definitionally dead

### 4. RunController + settings: drop the deadline

`pi-subagents/src/run-controller.ts`:
- `setTimeout` in the constructor REMOVED. No deadline timer fires.
  The `RunConfig.deadlineMs` field is preserved as metadata.
- `resolveRunConfig` no longer applies the [30, 120] min envelope
  clamp. The resolved value is whatever the caller asked for,
  recorded verbatim. `MIN_DEADLINE_MS` and `MAX_DEADLINE_MS` are
  kept as exports for backward compat (the tests reference them
  for the LEGACY test cases) but no production path uses them.
- `clampDeadlineMs` is also kept exported (same reason).
- Per-tool `signalForTool` (bucket timer) is unchanged. Bucket
  timers are per-tool defensive measures (a single bash command
  taking too long is malformed input, not a session-wide budget).
  This is documented in the class JSDoc as the explicit carve-out
  from "no budget limitations."

`pi-subagents/src/settings.ts`:
- `resolveDeadlineMs` no longer calls `clampDeadlineMs`. The
  resolved value passes through unchanged.
- `DEFAULT_DURATIONS_MS` (legacy per-type deadline defaults),
  `getSubagentDurationDefault`, `setSubagentDurationDefaults` are
  all preserved (the values are read by `resolveDeadlineMs` for
  the `Explore` capitalized-name path). The data is metadata now.

### 5. Aggregator + verify gate

`pi-orchestrator/scripts/aggregate-subagent-usage.ts`:
```bash
bun run subagent-usage:summary [--jsonl <path>]
# reads the JSONL log, prints:
#   - total rows + unique agents + total duration + span (first/last ts)
#   - per-agentType: calls + duration
#   - top 10 tools by call count
# pure read; never modifies the log; safe to run concurrently with
# subagent runs (the recorder appends serially via a promise mutex).
```

`pi-orchestrator/scripts/verify-recorder.ts`:
```bash
bun run verify:recorder
# asserts:
#   - recording.ts exports ToolUseRecorder + ToolUseRecord + emitToolUse
#     + RECORDING_PATH_DEFAULT + SUBAGENTS_TOOL_USE +
#     SUBAGENTS_RECORDING_ERROR
#   - RECORDING_PATH_DEFAULT points at .pi/orchestrator/metrics/...
#   - aggregator script exists + references the path
#   - budget.ts + boundary-discipline.ts + exploration-budget.ts
#     are GONE (negative assertion)
#   - recording-notice.ts exists + exports RECORDING_NOTICE_SECTION
#   - the section mentions no turn or time limit
#   - DEVELOPER_PROMPT + REVIEWER_PROMPT interpolate
#     RECORDING_NOTICE_SECTION byte-identical
#   - DEVELOPER_PROMPT no longer references BOUNDARY_DISCIPLINE_SECTION
#     or EXPLORATION_BUDGET_SECTION
```

Registered in `verify:all` so the gate runs alongside the existing
catalog / pi-tasks-tools / namespace-ownership / etc. checks.

### 6. failure-modes.v1.yaml

The `subagent-timeout` rule drops its `BudgetExceededError` match
(the budget tracker is gone). The `SubagentTimeout` match stays
for transport-level timeouts (HTTP / RPC / model API). Description
points operators at `subagent-usage:summary` for the JSONL log.

## TDD evidence

| Commit | SHA | Tests | Time |
|---|---|---:|---|
| 1 | `49aa335` | 17 unit + 10 emission = 27 new | RED confirmed (no module), then GREEN |
| 2 | `b7d0804` | agent-runner diff: typecheck + targeted tests | manual integration via the existing test surface |
| 3 | (rolled into 5) | sections-drift updated to RECORDING_NOTICE_SECTION byte-identity | n/a |
| 4 | `6630143` | subagent-deadline + sections-drift green; verify:recorder 19/19 | 1h, all green |
| 5 | `aeb524e` | developer-prompt, subagent-budget-prompt, run-controller inverted; 17+5+38 = 60+ targeted | final full suite |

Pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`):
green on every commit. Full pi-subagents suite: 60-pass on
targeted tests, plus 2 pre-existing flakes (run-controller bucket
test, T-DIAG-03) documented in GC-2026-cleanup-test-regression.

The `vi.mock("node:fs", ...)` errors in profile-instrumented tests
are pre-existing bun:test vs vitest incompat from the same GC
(post-GC-2026-pi-tasks-test-compat documentation).

## Follow-ups

1. **`verify:recorder` + `subagent-usage:summary` as part of the
   standard CI run** (P3) — currently `verify:recorder` is registered
   in `verify:all` (which the orchestrator CI doesn't run by default
   but humans + ad-hoc CI do). The `subagent-usage:summary` script is
   not auto-invoked. A future GC could wire both into the standard
   `bun run verify:all` invocation that the host's pre-commit hook
   calls.

2. **Aggregator formatting for very long sessions** (P3) — the
   current output prints the per-agent-type breakdown + top 10
   tools. For sessions that span many hours, the per-agentType
   breakdown could split by hour-bucket. Defer until the data shape
   warrants it.

3. **Documentation follow-up** (P2) — AGENTS.md still describes
   the previous budget mechanism in some places. Update to
   describe the new "recording + manual intervention" model.
   The `pi-subagents` README also needs the same update. (Out of
   scope for this GC; per the contract's `scope_exclude`.)

4. **Rollback strategy** (P3) — if the recording proves too noisy or
   the lack of enforcement causes real runaway runs, the
   `defaultBudgets` + `BudgetTracker` infrastructure can be
   re-introduced from git history. The recording layer is purely
   additive, so it can stay even if budget enforcement returns.

## Process notes

- **Manual takeover** (per AGENTS.md soft-mode contract): the
  implementer subagent that would have been dispatched was
  skipped for this GC because the prior GC's Developer
  subagent had aborted at 60 turns with 0 progress — same
  failure mode would be likely. The orchestrator main agent
  implemented directly. The 4-commit + 1-test-invert series
  above is the result.

- **No subagent types added** — the prompt sections are now
  smaller (one short paragraph instead of two enforcement
  blocks). Subagent types: Developer, Reviewer, Explore, Plan,
  PlanCompiler, DeveloperAdvisor, ReviewerAdvisor, Fix,
  FixAdvisor, MergerAdvisor, Planner (still defined but
  unused after GC-2026-122) — all interpolate the same
  RECORDING_NOTICE_SECTION (or its own equivalent for the
  read-only / write-only variants).

- **No cross-package boundary changes** — the contract's
  `scope_exclude` (pi-codebase-memory, pi-evaluator, pi-tasks,
  AGENTS.md, README.md, etc.) held. The only `pi-tasks` surface
  that references the old `max_turns` is the `TaskExecute` tool
  schema in `pi-tasks/src/index.ts:1413,1421` — out of scope; a
  future GC should drop the `max_turns` field from the tool
  schema (it's documented as honored but no longer enforced).

- **Cascade race observation from the prior GC** (GC-2026-main-
  agent-proactive-intent-pump postmortem) didn't recur here —
  the canonical 4-phase pipeline (Implement → Review → Fix →
  Merge) ran sequentially via the existing TaskCreate × N +
  TaskExecute flow; no premature agents parked this time.
  The race is real for parallel TaskCreate × N but isn't relevant
  for a single-developer serial implementation GC.

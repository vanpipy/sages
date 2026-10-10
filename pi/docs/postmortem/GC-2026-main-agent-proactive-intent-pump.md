---
gc_id: GC-2026-main-agent-proactive-intent-pump
title: Proactive intent-pump via main-agent injection
severity: minor
---

## What happened

GC-2026-122 dropped the GC-2026-121 Planner auto-spawn and replaced it with a soft `before_agent_start` system-prompt reminder. The user observed that the main LLM consumed the reminder inconsistently — "大部分时候都没有主动消费 当我主动create "{task}"时" — and asked for a queued, observable mechanism that injects a "Consume intent #N" user message into the main session.

The GC landed with a clean Reviewer verdict (CLEAN, 11/11 criteria satisfied, 580/580 tests pass) but encountered two notable operational issues during the pipeline that are worth recording.

## Root cause

The main architectural insight: the user's pain was not "no intent consumption" — it was "intent consumption is unreliable because the LLM might not notice a soft system-prompt appendix at the bottom of an already-long prompt." The fix: pump a hard, observable user-role message into the main session, serialize consumption turns FIFO, and detect completion via store polling. The LLM's normal turn-end hook processes the consumption turn identically to a user turn.

The four locked decisions (queue, decompose-task to task stream, no-cascade, mockable transport) are recorded in the goal contract. The implementation:

- New module `pi-tasks/src/main-agent-injector.ts` (259 lines) with `IntentPump` class, `MainAgentTransport` interface, `composeConsumptionPrompt` pure function.
- `isFeedableTask` predicate in `task-feeder.ts` extended to accept `kind=intent` (in addition to the existing `agentType` branch).
- `wrappedSpawn` router inside `registerTaskFeeder` dispatches `kind=intent` to `IntentPump.enqueue` instead of `AgentManager.spawn`, with a synthetic `intent-pump:<id>` id for the `agentTaskMap`.
- `cascadeSpawn` explicitly skips `kind=intent` (no cascade by design).
- `composeIntentReminder` accepts an optional `isOwned(taskId)` predicate; the reminder excludes pump-owned tasks but still surfaces orphaned intents (defensive fallback).
- Production factory in `pi-tasks/src/index.ts` creates an `IntentPump` that wraps `pi.sendUserMessage` (feature-detected; falls back to the reminder if the host doesn't expose the method).

## Operational issues encountered

### 1. Developer subagent aborted at 60 turns with 0 progress (manual takeover)

**Symptom**: The first `Developer` subagent dispatched for this GC was set to `max_turns: 80` but aborted at 60 turns with `toolUses: 60` — all 60 spent on exploration (grep / read / `aft_search` / `git log`), zero commits, zero new files. The agent was thorough in understanding the codebase but never wrote a single test or implementation line.

**Root cause**: The Developer's prompt was comprehensive (4 locked decisions + 11 acceptance criteria + TDD discipline + scope excludes) but open-ended. Without an explicit "write the first failing test now" directive at the top, the agent defaulted to "understand the codebase first" exploration, exhausting its tool budget before reaching the implementation phase.

**Why AGENTS.md §"Orchestrator manual takeover" is the right response**: The contract explicitly states that subagent dispatch is RECOMMENDED but the orchestrator is expected to take over when a subagent loops without committing. The takeover preserved TDD discipline (RED first, confirm RED, GREEN, REFACTOR), committed in 4 atomic commits, and produced the same evidence a successful subagent dispatch would have produced.

**Fix**: This is not a code change — it's a prompt-template improvement for the next Developer dispatch. The Developer prompt in `pi-subagents/src/agent-prompts/developer.ts` could be tightened to:

1. **Step 0: write the first failing test before any exploration.** "Before running any command, write `test/<feature>.test.ts` with at least one failing test asserting the simplest version of criterion #1. Confirm RED (`bun test`). Then start the implementation."
2. **Exploration budget**: cap exploration at 5 tool calls before the first test must exist.
3. **Tight time-per-tool**: each tool call should produce a code file or a test commit; reads without follow-up writes should be flagged.

The 4 atomic commits in this GC (b87607a, 1f5fae8, a05a4bf, 3e9f851) demonstrate the TDD cadence the Developer agent should hit on its own: commit 1 is "add new module + RED-confirmed tests" (criterion #1-2 + 10 partial), commit 2 is "wire to production + fix stale assertions" (criteria #3, 4, 9, 11), commits 3-4 are test inversions + scope-adjacent test updates.

A future GC (e.g., `GC-2026-developer-prompt-tdd-budget`) could implement the prompt-template fix.

### 2. Cascade race: TaskCreate × N parallel + post-TaskUpdate edges

**Symptom**: The 4-phase pipeline (Implement / Review / Fix / Merger) was built with `TaskCreate` × 4 in parallel, then `TaskUpdate` × 4 to add `blocks` / `blockedBy` edges. The feeder's `maybeAutoSpawn` fires immediately on each `TaskCreate` (with `blockedBy=[]` at create time), so Reviewer/Fix/MergerAdvisor all spawned **concurrently** before the Implement had a chance to commit. The MergerAdvisor even completed first (correctly BLOCKED) because there was no source branch yet.

**Root cause**: The `TaskCreate` schema accepts `blockedBy` inline (verified in the tool's parameter definition), but the orchestrator pattern from `pi-orchestrator/skills/orchestrator/SKILL.md` describes adding edges via `TaskUpdate` *after* the parallel creates. The pattern works for the workflow_run-based path (where the workflow runner respects cascade) but NOT for the raw `TaskCreate × N + TaskExecute` path that replaced workflow_run in GC-2026-remove-workflow-run-prod: the feeder fires on `TaskCreate` immediately, so post-`TaskUpdate` edges arrive too late.

**Recovery**: Three premature agents were steered to park (one-line placeholder reports at `.pi/orchestrator/last-review-GC-2026-main-agent-proactive-intent-pump.md` and `.pi/orchestrator/task-fix-report.md`). The Implement was re-dispatched via the `Agent` tool with explicit `isolation: { goal_id, task_id, mode: "create" }` so it took the worktree path independent of the broken task system. After the Implement's commits landed, the Reviewer was re-dispatched via the same `Agent` path (not `TaskExecute`).

**Fix options for a follow-up GC**:

- **Option A**: Require `blockedBy` inline in `TaskCreate` args, not via post-`TaskUpdate`. Update the canonical pipeline pattern in `pi-orchestrator/skills/orchestrator/SKILL.md` to spell this out.
- **Option B**: Have `TaskCreate`'s internal feeder-hook sleep for a short "settle window" (e.g., 50ms) before the first `maybeAutoSpawn` call, so that `TaskUpdate` edges from sibling `TaskCreate` calls land first.
- **Option C**: Detect "no siblings have been added yet" in `maybeAutoSpawn` and defer dispatch if the task has no `blockedBy` edges AND there are other pending tasks created in the same turn. (More complex; tests harder to write.)

The simplest fix is Option A. It moves the race out of the runtime and into the orchestrator prompt — the orchestrator already knows the pipeline shape, so it can construct the TaskCreate × 4 with edges inline from the start.

## TDD evidence

| Commit | SHA | Tests | Time |
|---|---|---:|---|
| 1 — `feat(pi-tasks): add IntentPump + MainAgentTransport module` | `b87607a` | 17 unit + 7 integration = 24 new | RED confirmed (no module), then GREEN |
| 2 — `feat(pi-tasks): route kind=intent to IntentPump + downgrade reminder` | `1f5fae8` | re-ran full suite: 580/580 pass | wired production factory |
| 3 — `test(pi-tasks): invert intent-predicate assertions` | `a05a4bf` | 580/580 pass after inversion | flipped 4 stale `isFeedableTask` assertions |
| 4 — `test(pi-tasks): update task-feeding tests` | `3e9f851` | 580/580 pass | added `agentType=Developer` to 5 subagent-path tests |

Pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`): 503 pass / 0 fail on every commit. New files pass `biome check` clean. Pre-existing 2 typecheck errors in `src/reviewer-prompt.ts` and pre-existing unused-import warnings in touched test files are unchanged from `origin/main` (`a138f34`).

Reviewer verdict: `verdict: CLEAN, findings: [], scope_check: pass, anti_goal_check: pass`. Full evidence in `.pi/orchestrator/last-review-GC-2026-main-agent-proactive-intent-pump.md`.

## Follow-ups

1. **`GC-2026-developer-prompt-tdd-budget` (P2)**: tighten the Developer subagent prompt with a "first action: write a failing test" directive and an exploration budget (5 tool calls before the first test must exist). Filed in the operational issues section above.

2. **`GC-2026-cascade-race-fix` (P2)**: pick one of the three fix options in the cascade-race section and implement it. The simplest is Option A (require `blockedBy` inline in `TaskCreate`). Update `pi-orchestrator/skills/orchestrator/SKILL.md` to document the pattern.

3. **Doc follow-up (P2)**: update `AGENTS.md`, `README.md`, and `pi-orchestrator/skills/orchestrator/SKILL.md` to describe the new task-feeding flow. The `intent-reminder.ts` header comment already references `GC-2026-122` as the "fallback" path; the prose docs should match.

4. **Pre-existing typecheck drift (P3)**: 2 errors in `pi-tasks/src/reviewer-prompt.ts` (`Cannot find module './workflow-graph.js'` and `Parameter 'a' implicitly has an 'any' type`) — these are leftover from GC-2026-remove-workflow-run-prod (the `workflow-graph` module was deleted but `reviewer-prompt.ts` was not fully cleaned). A separate GC should clean these up.

5. **`pi-subagents/src/default-agents.ts` (no change)**: the Reviewer confirmed the Planner subagent definition is still registered for explicit dispatch (the main LLM can call it via the `Agent` tool). The post-GC-2026-121 description in `pi-subagents/src/agent-prompts/planner.ts` already says "NOT auto-spawned after GC-2026-122 — the main LLM dispatches it explicitly via the `Agent` tool" which is still accurate post-this-GC. No change needed.

## Process notes

- **Workflow_run is gone** (per GC-2026-remove-workflow-run-prod). This GC used the raw `TaskCreate × N + TaskExecute` path, which exposed the cascade race (operational issue #2 above). The fix is in scope for a follow-up GC.
- **MergerAdvisor was first-dispatched prematurely** (BLOCKED, written to `.pi/orchestrator/merge-recommendation.md`) and then re-run by the orchestrator main agent after the Reviewer's CLEAN verdict. The BLOCKED report was overwritten; the second pass is the canonical merge recommendation.
- **Subagent types used**: 1 `Developer` (aborted → manual takeover), 1 `Reviewer` (re-dispatched after Implement commits landed), 1 `Fix` (parked, no findings to address), 2 `MergerAdvisor` runs (first premature BLOCKED, second canonical). The MergerAdvisor run was done by the orchestrator main agent directly because the task system's auto-cascade is currently broken (see cascade race above).

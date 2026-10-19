# `pi-sidebar-sages` — sidebar reverse-channel wiring (Sages side)

> Sages-side companion to the fork at
> [`/home/leroy/Project/pi-sidebar-sages/`][fork]. This file documents
> how the Sages orchestrator, the task board, and the evaluator emit
> `sidebar:event` payloads on the pi event bus so the fork's listener
> (`extensions/sidebar/sidebar-event-tool.ts`) can mutate its
> `SidebarState` and trigger a re-render.
>
> [fork]: /home/leroy/Project/pi-sidebar-sages/

## Purpose

The sidebar fork is a passive visual surface — it does not decide what
to draw, it only listens. The Sages side is the emitter: every
emit site below is a small `try/catch`-wrapped `pi.events.emit(
"sidebar:event", payload)` call that fires at one of five moments in
the orchestrator's task lifecycle or the evaluator's reward-mode
self-check. The contract is locked:

```ts
{ action: "highlight" | "badge" | "toast" | "log" | "clear",
  target?: string,
  data?: unknown,
  ts: number }
```

The five Sages emit sites are: (1) intent → plan conversion
highlights the intent row, (2) subagent spawn highlights the
dispatched task row, (3) subagent completion appends a log entry,
(4) Reviewer verdict consumption appends a log entry, and (5)
`eval_score` appends a log entry. The fork's `registerSidebarEventTool`
routes each action to the matching slice of `SidebarState`
(`highlightedId` / `badges` / `eventLog`); the Sages side never
inspects the listener or its result.

## Entry points

The wiring is intentionally lightweight — no new package, no new
dependency. It is added on top of three existing tools:

- `pi-orchestrator/src/orchestrator-tool.ts:956` —
  `registerOrchestratorTools(pi)`. Registers `task_inspect`,
  `task_consume`, `task_convert_intent`, and the three iterative
  primitives. The wrapper around `task_consume` (`:982–1005`) and the
  wrapper around `task_convert_intent` (`:1028–1057`) emit on success.
  The helper `emitSidebarEvent(pi, channel, payload)` lives at `:920`.
- `pi-tasks/src/index.ts:1166` — `TaskExecute` tool handler. The
  per-task spawn block (`:1389–1460`) emits `action: "highlight"`
  after a successful `subagents:rpc:spawn` (`:1434`). The
  `subagents:completed` listener registered at `:347` emits
  `action: "log"` at `:361`.
- `pi-evaluator/src/tools/eval-score.ts:198` —
  `makeEvalScoreTool(state, emit?)`. The optional `emit` parameter
  (typed `SidebarEmitter` at `eval-score.ts:49`) is wired by the
  evaluator's extension entry point; the tool's `execute` body emits
  `action: "log"` after `await computeEvalScore(stateRef)` resolves
  (`:219` → `:231`).

## Key symbols

| Symbol | File:line | Role |
|---|---|---|
| `emitSidebarEvent` (function) | `pi-orchestrator/src/orchestrator-tool.ts:920` | Defensive wrapper around `pi.events.emit("sidebar:event", …)`. Swallows listener errors so the orchestrator's success path is never broken by a misbehaving sidebar subscriber or a missing `pi.events` in tests. |
| `task_consume` Reviewer emit | `pi-orchestrator/src/orchestrator-tool.ts:996` | Emits `action: "log"` with `target: "task-<id>"` and `data: { verdict, agentType }` when the consumed task carries a `verdict` (Reviewer only). Developer completions carry no verdict and are intentionally skipped — their log entry lands via pi-tasks's own `subagents:completed` listener (`:361`). |
| `task_convert_intent` emit | `pi-orchestrator/src/orchestrator-tool.ts:1044` | Emits `action: "highlight"` with `target: "intent-<id>"` and `data: { shape, phaseCount, planTaskIds }` immediately after the intent is marked converted and the plan tasks are created. |
| `TaskExecute` spawn emit | `pi-tasks/src/index.ts:1434` | Emits `action: "highlight"` with `target: "task-<id>"` and `data: { agentType, subject, activeForm }` the moment the subagent is spawned (and after `agentTaskMap.set(agentId, taskId)` at `:1424` succeeds). The data payload lets the sidebar render a human-readable title without re-querying the store. |
| `subagents:completed` emit | `pi-tasks/src/index.ts:361` | Emits `action: "log"` with `target: "task-<id>"` and `data: { status: "completed", durationMs?, tokens? }` after the task is flipped to `completed` in the store (`:355`). `durationMs` is best-effort — the listener does not track start time, so consumers should treat it as a hint. |
| `makeEvalScoreTool` signature | `pi-evaluator/src/tools/eval-score.ts:198` | The `eval_score` `ToolDefinition` factory. Optional `emit?: SidebarEmitter` parameter (`:200`, type at `:49`). When `emit` is provided, the tool's `execute` body emits `action: "log"` with `target: "evaluator"` and `data: { score, dimensions }` at `:231`. When `emit` is absent (unit tests, pre-integration wiring) the tool is silent on the sidebar channel. |
| `SidebarEmitter` (type) | `pi-evaluator/src/tools/eval-score.ts:49` | `(payload: { action, target?, data?, ts }) => void`. Matches the contract on the listener. The orchestrator thread that wires `registerEvalTools` passes a callback bound to `pi.events.emit("sidebar:event", …)`. Wrapped in `try/catch` by the caller (`:230–237`) so a failing bus never breaks the tool path. |
| `registerOrchestratorTools` | `pi-orchestrator/src/orchestrator-tool.ts:956` | The factory called from the extension default export. Wraps each tool's `execute` so the emit fires on success without re-implementing it. |

## Dependencies

- **No new dependencies.** The wiring uses `pi.events` — the same
  pub/sub bus the orchestrator, pi-tasks, and pi-evaluator already
  share. The fork's listener (`extensions/sidebar/sidebar-event-tool.ts`)
  registers on the same bus from its own package; no shared schema
  type, no shared module.
- **Cross-package contract**: only `{ action, target?, data?, ts }`
  (the payload literal) is shared, and it is duplicated in both
  repositories by design. The contract is small enough that the
  listener-side type lives in the fork (see
  `extensions/sidebar/sidebar-event-tool.ts`); the Sages-side
  `SidebarEmitter` type in `pi-evaluator/src/tools/eval-score.ts:49`
  mirrors it. The two evolve together via the integration tests
  (`orchestrator-sidebar-emit.test.ts`,
  `task-sidebar-emit.test.ts`, `evaluator-sidebar-emit.test.ts`).
- The `try/catch` swallowing contract — both sides agree that a
  failing bus or missing listener never propagates — is also a
  cross-package contract.

## Key flows

### Intent conversion → highlight

The LLM calls `task_convert_intent(task_id, plan)`. After the intent
is marked converted and the plan tasks are created (`orchestrator-tool.ts:469`
inside `taskConvertIntent`), the registered wrapper fires:

```text
LLM → task_convert_intent
  → taskConvertIntent (orchestrator-tool.ts:389)
    → store.create(plan tasks) … (orchestrator-tool.ts:469)
    → returns ConvertIntentOutput { intent_task_id, intent_shape, plan_task_ids, ... }
  → emitSidebarEvent(pi, "sidebar:event", {
      action: "highlight",
      target: `intent-${data.intent_task_id}`,
      data: { shape, phaseCount, planTaskIds },
      ts: Date.now(),
    }) (orchestrator-tool.ts:1044)
  → fork's registerSidebarEventTool listener
    → state.highlightedId = "intent-<id>"
    → requestRender()
```

### Task dispatch → highlight

The LLM calls `TaskExecute([task_id])`. `index.ts:1245` calls
`spawnSubagent` which goes over `subagents:rpc:spawn` to
`AgentManager.spawn`. On a successful spawn (`index.ts:1434`):

```text
LLM → TaskExecute([task_id])
  → TaskExecute handler (index.ts:1166)
    → spawnSubagent (index.ts:1245)
    → pi.events.emit("subagents:rpc:spawn", …)
    → AgentManager spawn (in pi-subagents)
    → agentTaskMap.set(agentId, taskId) (index.ts:1424)
    → emitSidebarEvent(pi, "sidebar:event", {
        action: "highlight",
        target: `task-${taskId}`,
        data: { agentType, subject, activeForm },
        ts: Date.now(),
      }) (index.ts:1434)
  → fork's registerSidebarEventTool listener
    → state.highlightedId = "task-<id>"
    → requestRender()
```

### Task completion → log

When the subagent finishes, `pi-subagents` emits `subagents:completed`.
The listener at `index.ts:347` updates the store and emits:

```text
AgentManager → pi.events.emit("subagents:completed", { id, result })
  → listener (index.ts:347)
    → store.update(task.id, { status: "completed", metadata: { ...task.metadata, result } }) (index.ts:355)
    → widget.setActiveTask(task.id, false) (index.ts:356)
    → emitSidebarEvent(pi, "sidebar:event", {
        action: "log",
        target: `task-${task.id}`,
        data: { status: "completed", durationMs?, tokens? },
        ts: Date.now(),
      }) (index.ts:361)
    → auto-cascade walk (index.ts:379)
  → fork's registerSidebarEventTool listener
    → state.eventLog.push({ ts, target, data }) (FIFO-evicted at SIDEBAR_EVENT_LOG_MAX = 50)
    → requestRender()
```

### Reviewer verdict → log

The LLM calls `task_consume(task_id)` on a completed Reviewer task.
`taskConsume` parses the 4-state verdict (`verdict.ts:40`) and the
registered wrapper fires:

```text
LLM → task_consume(task_id)
  → taskConsume (orchestrator-tool.ts:195)
    → parseVerdict(result) (verdict.ts:40)
    → returns ConsumeOutput { ..., verdict?, follow_up_suggestion? }
  → wrapper (orchestrator-tool.ts:982)
    → if (data.verdict) {
        emitSidebarEvent(pi, "sidebar:event", {
          action: "log",
          target: `task-${data.id}`,
          data: { verdict, agentType },
          ts: Date.now(),
        }) (orchestrator-tool.ts:996)
      }
  → fork's registerSidebarEventTool listener
    → state.eventLog.push({ ts, target: "task-<id>", data: { verdict, agentType } })
    → requestRender()
```

### `eval_score` → log

The LLM calls `eval_score` (reward-mode on). After
`computeEvalScore(stateRef)` resolves, the tool's `execute` body
projects per-dimension scores and emits:

```text
LLM → eval_score()
  → makeEvalScoreTool.execute (eval-score.ts:218)
    → const data = await computeEvalScore(stateRef) (eval-score.ts:219)
    → if (emit) {
        const dimensions: Record<Dimension, number> = { … }; (eval-score.ts:223–229)
        try {
          emit({
            action: "log",
            target: "evaluator",
            data: { score: data.total_score, dimensions },
            ts: Date.now(),
          }) (eval-score.ts:231)
        } catch { /* defensive */ }
      }
  → fork's registerSidebarEventTool listener
    → state.eventLog.push({ ts, target: "evaluator", data: { score, dimensions } })
    → requestRender()
```

## Defensive design

- **All emits are `try/catch`-wrapped.** A failing bus or a missing
  listener must never break the orchestrator's tool path. See
  `orchestrator-tool.ts:925–930` (the wrapper itself),
  `index.ts:375–377` (the `subagents:completed` emit),
  `index.ts:1444–1446` (the `TaskExecute` spawn emit), and
  `eval-score.ts:230–239` (the `eval_score` emit). The
  `task_consume` and `task_convert_intent` wrappers do not need a
  `try/catch` — they delegate to `emitSidebarEvent`, which wraps.
- **The sidebar is optional.** Every test that does not pre-stub
  `pi.events` for the `sidebar:event` channel still passes; the
  emit is a no-op. The `task-sidebar-emit.test.ts`,
  `evaluator-sidebar-emit.test.ts`, and
  `orchestrator-sidebar-emit.test.ts` suites each construct a mock
  `pi.events` that records emits so the assertions are exact.
- **`emit?` is optional on `makeEvalScoreTool`.** Unit tests that
  don't care about the sidebar channel pass no emitter and the tool
  is silent (the `if (emit)` guard at `eval-score.ts:220`). Only the
  orchestrator thread wires the real bus.
- **No cross-package type.** The payload shape `{ action, target?,
  data?, ts }` is duplicated in `pi-evaluator/src/tools/eval-score.ts:49`,
  in the orchestrator's `emitSidebarEvent` parameter type
  (`orchestrator-tool.ts:923`), and in the fork's listener. This is
  intentional: the contract is small and the listener is in a
  different repo, so a duplicated literal is cheaper than a shared
  schema package. The integration tests catch drift.

## Verification

- `cd pi-orchestrator && bun run typecheck && bun test ./test` —
  orchestrator typecheck + tests, including
  `pi-orchestrator/test/orchestrator-sidebar-emit.test.ts` which
  asserts the wrapper fires on `task_consume` (Reviewer) and
  `task_convert_intent` success.
- `cd pi-tasks && bun run typecheck && bun test` — task-board
  typecheck + tests, including
  `pi-tasks/test/task-sidebar-emit.test.ts` which asserts the two
  emit points (TaskExecute spawn at `index.ts:1434` and
  `subagents:completed` at `index.ts:361`).
- `cd pi-evaluator && bun run typecheck && bun test` — evaluator
  typecheck + tests, including
  `pi-evaluator/test/tools/evaluator-sidebar-emit.test.ts` which
  asserts `makeEvalScoreTool` emits `action: "log"` + `{ score,
  dimensions }` after `computeEvalScore` resolves.
- The root pre-commit hook (`orchestrator:typecheck` +
  `orchestrator:test`) is the only gate that runs automatically.

## Where to learn more

- [`pi-orchestrator.md`](./pi-orchestrator.md) — the consumer whose
  `task_convert_intent` and `task_consume` wrappers emit.
- [`pi-tasks.md`](./pi-tasks.md) — the board whose `TaskExecute` spawn
  block and `subagents:completed` listener emit.
- [`pi-evaluator.md`](./pi-evaluator.md) — the opt-in reward-mode
  tool whose `makeEvalScoreTool` accepts the optional `emit` callback.
- [`/home/leroy/Project/pi-sidebar-sages/SAGES-FORK.md`][fork-fork] —
  the fork-side companion to this doc: 3 goal statuses + commit refs +
  the "Merged to main" table.
- [`/home/leroy/Project/pi-sidebar-sages/README.md`][fork-readme] —
  the fork's `## Sages integration` section enumerates the 5 emit
  sites from the listener's perspective.
- `extensions/sidebar/sidebar-event-tool.ts` (in the fork) — the
  `registerSidebarEventTool` listener that receives every emit above
  and routes it into `SidebarState`.
- `pi-orchestrator/templates/sages-routines/sages-board-watch.json`
  — the 30s pulse routine the sidebar's Tasks panel replaces as the
  passive awareness surface.

[fork-fork]: /home/leroy/Project/pi-sidebar-sages/SAGES-FORK.md
[fork-readme]: /home/leroy/Project/pi-sidebar-sages/README.md
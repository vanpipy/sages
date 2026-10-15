# `pi-orchestrator` — Task Orchestrator (planning layer)

> Source: `pi-orchestrator/` (workspaces member; npm namespace
> `@sages/pi-orchestrator`).
> File count: 5 source files in `src/` (extension.ts, index.ts,
> orchestrator-tool.ts, verdict.ts, brainstorming/{index,state,types}.ts),
> plus `templates/`, `skills/`, `scripts/install.sh`.

## Purpose

The orchestrator is the LLM's session shell. It does three things:

1. **Curate the tool allowlist** on `session_start` (`extension.ts:179`)
   so the LLM sees only the tools it should use, in the right
   priority order.
2. **Prepend the orchestrator constitution** (`templates/SYSTEM.md`)
   on every `before_agent_start` (`extension.ts:194`).
3. **Fire the once-per-session soft-mode reminder** on the first side-
   effecting tool call (`extension.ts:209`).

On top of that shell, it registers three LLM-facing consumer tools
(`task_inspect`, `task_consume`, `task_convert_intent`) that the
orchestrator's LLM uses to read and shape the board, and ships a
`/brainstorm` slash command whose 5-phase state machine drives
design-doc generation.

The orchestrator is a **consumer** of the task flow, not its manager.
Per the file header at `orchestrator-tool.ts:1–39`, it adds tasks via
pi-tasks's `TaskCreate` (with `type` set to `"intent"` or `"plan"`),
reads via `TaskList` / `TaskGet`, dispatches via `TaskExecute`. Its
three tools add: routing hints on the read side (`task_inspect`),
verdict parsing on the read side (`task_consume`), and intent → plan
conversion on the write side (`task_convert_intent`).

## Entry points

Per `pi-orchestrator/package.json:18–26`:

```jsonc
"pi": {
  "extensions": [ "./src/extension.ts" ],
  "skills":     [ "./skills" ],
  "themes":     []
}
```

So the package's `pi` entry point is `src/extension.ts`, which exports
`registerOrchestratorExtension` (`extension.ts:236`) as default.

`src/index.ts` is the public re-export surface for non-extension callers:

- Re-exports brainstorming helpers (`pi-orchestrator/src/index.ts:13–33`).
- Exposes `BrainstormContextResult` / `BrainstormResponse` /
  `TransitionResult` / `OrchestratorPlanContext` types plus the
  `startBrainstorm` / `processClarifyingPhase` / `processProposingPhase`
  / `processDesigningPhase` / `finalizeDesign` /
  `generateApprovalMessage` / `parseTransitionResponse` /
  `createOrchestratorContext` / `discoverProjectContext` /
  `generateClarifyingQuestions` / `generateApproaches` /
  `generateDesignSections` / `writeDesignDoc` functions.
- Carries a header note that the removed `chain-key`, `bash-guard`,
  and `orchestrator-advisory` modules are out (post
  `chore/remove-orchestrator-advisory`).

## Key symbols

Top 10, ordered by importance:

1. **`installSessionHooks`** — `pi-orchestrator/src/extension.ts:177`.
   The three lifecycle hooks:
   - `session_start` (`extension.ts:179`): the array body starts at
     `:180` — `pi.setActiveTools([...PI_TASKS_TOOLS, ...SUBAGENT_TOOLS, ...AFT_TOOLS, ...BASELINE_TOOLS, ...PI_ROUTINES_TOOLS])`,
     plus an optional status notification.
   - `before_agent_start` (`extension.ts:194`): prepends
     `templates/SYSTEM.md` to the LLM's system prompt.
   - `tool_call` (`extension.ts:209`): fires `SOFT_MODE_REMINDER`
     (`extension.ts:149`) once per session on the first
     side-effecting call (`bash` / `edit` / `write`).

2. **`registerOrchestratorExtension`** (default export) —
   `pi-orchestrator/src/extension.ts:236`. Wires `installSessionHooks`
   + `registerOrchestratorTools` (`orchestrator-tool.ts:504`).

3. **Tool allowlist constants** — `pi-orchestrator/src/extension.ts`.
   - `PI_SUBAGENT_TOOLS` (`:41`): `["Agent", "get_subagent_result", "steer_subagent"]`.
   - `SUBAGENT_CONTROL_TOOLS` (`:56`): `["subagent_status", "subagent_steer", "subagent_abort", "subagent_resume"]`.
     These names are documented in `templates/agent-tool-description.md`
     and `templates/SYSTEM.md` but the registration site is in
     `pi-subagents` (not in this package) — see
     [`pi-subagents.md`](./pi-subagents.md#discrepancy-watch).
   - `SUBAGENT_TOOLS` (`:67`): the union of the two above.
   - `BASELINE_TOOLS` (`:76`): `["bash", "read", "edit", "write", "grep", "find", "ls"]`.
   - `PI_TASKS_TOOLS` (`:91`): the 7 `Task*` tools from `@sages/pi-tasks`.
   - `AFT_TOOLS` (`:105`): the 11 AFT tools from `@cortexkit/aft-pi`.
   - `PI_ROUTINES_TOOLS` (`:135`): the 6 routines tools from
     `@davecodes/pi-routines` (opt-in; missing extension degrades
     gracefully).

4. **`task_inspect`** — `pi-orchestrator/src/orchestrator-tool.ts:116`
   (function) / registered at `:505`.
   Read just the routing-relevant fields of a task:
   `id`, `subject`, `type`, `status`, `agentType`, `hasResult`.
   Lets the orchestrator's LLM route on the result
   (`type='intent'` → `task_convert_intent`, `plan + pending` →
   `TaskExecute`, `plan + completed` → `task_consume`).
   `InspectParams` is declared at `orchestrator-tool.ts:77`,
   `InspectOutput` at `:88`, `TaskInspectError` at `:98`.

5. **`task_consume`** — `pi-orchestrator/src/orchestrator-tool.ts:195`
   (function) / registered at `:518`.
   Read a completed plan task's result. Returns
   `{ id, subject, status, agentType, result, verdict?, read_at, follow_up_suggestion? }`.
   Pure read — does NOT mutate the store. Errors:
   `TaskConsumeError(kind: "not_found" | "not_completed" | "not_plan")`
   (`orchestrator-tool.ts:180`).

6. **`task_convert_intent`** — `pi-orchestrator/src/orchestrator-tool.ts:384`
   (function) / registered at `:533`.
   The unique intent → plan converter. Reads an intent task, marks it
   converted (audit: `metadata.converted / converted_at / intent_shape
   / rationale`, flips `status: "completed"`), and creates plan tasks
   from a STRUCTURED plan object (`intent_shape` + `rationale` +
   `phases[]`). Phase → agentType is mapped deterministically via
   `PHASE_AGENT_TYPE` (review → Reviewer, all others → Developer) — the
   LLM never types `agentType` directly. Runtime validation in
   `phase-validation.ts` enforces per-shape phase count + ordering rules.
   Refuses non-intent sources, already-converted intents, empty
   `phases`, and plans that violate the shape rules. Errors:
   `ConvertIntentError(kind: "intent_not_found" | "not_intent" |
   "already_converted" | "empty_phases" | "shape_violation")`
   (`orchestrator-tool.ts:363`). The plan tasks get
   `metadata.source_intent`, `metadata.phase`, and `metadata.agentType`
   auto-stamped.

7. **`parseVerdict` / `suggestFollowUp`** —
   `pi-orchestrator/src/verdict.ts:40 / 55`. Pure functions over the
   Reviewer's result text. `parseVerdict` accepts `verdict: STATE`,
   `Verdict = STATE`, `**verdict:** STATE`, or a standalone line
   matching the token (case-insensitive). `suggestFollowUp` returns a
   verdict-tailored follow-up hint:
   - `CLEAN` → "Phase complete…"
   - `NEEDS_WORK` → "Spawn a Developer follow-up task…"
   - `NEEDS_REDESIGN` → "The approach is wrong… spawn a new Implement task."
   - `NEEDS_CLARIFICATION` → "Pause and surface the Reviewer's questions…"
   The `Verdict` union (`:23`) is the canonical 4-state shape used
   across the codebase.

8. **Brainstorming slash command pipeline** —
   `pi-orchestrator/src/brainstorming/index.ts`. The exported surface
   from `pi-orchestrator/src/index.ts`. Top entries:
   - `startBrainstorm(cwd, request?)` (`:425`): discover project
     context, emit the initial "exploring" message.
   - `processClarifyingPhase` (`:446`): build the 4 clarifying
     questions (scope / priority / users / edge-cases).
   - `processProposingPhase` (`:473`): generate 3 approaches
     (Quick / Robust / Iterative) with pros, cons, complexity,
     time estimate.
   - `processDesigningPhase` (`:506`): build the architecture / data-flow /
     testing sections.
   - `finalizeDesign` (`:530`): write the design doc via
     `writeDesignDoc` (`:372`) into
     `orchestratorDesignsDir(cwd)` (the path resolved from
     `@sages/pi-tasks/task-paths`).
   - `parseTransitionResponse` (`:633`) + `generateApprovalMessage`
     (`:596`): the proceed / defer / exit hint after approval.
   - `createOrchestratorContext` (`:665`): in-memory handoff — the
     design doc + intent + project context are surfaced so the LLM
     can feed them into raw `TaskCreate × N + TaskExecute` (no
     orchestrator tool mediates the transition post-GC-2026-remove-goal-contract).

9. **`BrainstormStateMachine`** —
   `pi-orchestrator/src/brainstorming/state.ts:39`. Drives the phase
   transitions: `exploring → clarifying → proposing → designing → approved/cancelled`.
   Valid transitions table at `:39`. `process(event)` dispatches on
   the event union (`brainstorming/types.ts:264`). Helpers `isTerminalPhase` (`:346`)
   and `isActivePhase` (`:350`).

10. **Template assets** —
    - `templates/SYSTEM.md` — orchestrator constitution (loaded at
      `extension.ts:165`, applied at `:194`).
    - `templates/agent-tool-description.md` — the LLM-visible `Agent`
      tool description, installed to `~/.pi/agent/agent-tool-description.md`
      by `scripts/install.sh`. Re-synced on every install run.
    - `templates/subagents.json` — `toolDescriptionMode: "custom"`,
      hooks the orchestrator's tool description into pi-subagents.
    - `templates/aft.jsonc` — AFT config template.
    - `templates/sages-routines/sages-board-watch.json` — 30s pulse
      routine that calls `TaskList` and converts intent tasks.
    - `scripts/install.sh` — wires all of the above into
      `~/.pi/packages/...` + `~/.local/bin/codebase-memory-mcp`.

## Dependencies

From `pi-orchestrator/package.json`:

- **peerDependencies** (`:27–32`):
  `@earendil-works/pi-coding-agent *`,
  `@earendil-works/pi-ai *`,
  `@earendil-works/pi-tui *`,
  `typebox *`.
- **dependencies** (`:33–37`):
  `@sages/pi-subagents: file:../pi-subagents`,
  `@sages/pi-tasks: file:../pi-tasks`,
  `js-yaml ^5.2.0`.
  The orchestrator depends on both peer `pi-*` packages — they are
  the consumers of every shared symbol. `js-yaml` is declared but
  unused in the live code; left over from earlier code paths.
- **devDependencies** (`:38–44`):
  `@types/node ^20.19.43`, `bun-types ^1.3.14`, `jiti ^2.7.0`,
  `simple-git ^4.0.2`, `typescript ^6.0.3`.

## Key flows

### Session bootstrap

1. `registerOrchestratorExtension` (default export) wires three things:
   - `installSessionHooks(pi)` (`extension.ts:177`) installs the 3 hooks.
   - `registerOrchestratorTools(pi)` (`orchestrator-tool.ts:504`) registers
     the 3 LLM-facing tools on the host.
2. The `session_start` hook calls `setActiveTools([...])` with the
   curated allowlist. The LLM now sees only the tools that belong to
   the orchestrator's workflow — anything else (raw `bash`,
   repo-level `read`, etc.) is filtered to the curated `BASELINE_TOOLS`.
3. The first `before_agent_start` event reads `SYSTEM.md` and
   prepends it to the LLM system prompt.
4. The first `bash` / `edit` / `write` call triggers the soft-mode
   reminder, which fires only once per session
   (`reminderFired` flag at `extension.ts:208`).

### Task routing via `task_inspect`

LLM flow when it sees an unhandled task:

1. `task_inspect(task_id)` → `{ id, type, status, agentType, hasResult }`.
2. LLM branches on `type`:
   - `intent` → `task_convert_intent(task_id, plan)` (`:384`).
   - `plan` + `pending` → `TaskExecute([task_id])` (in pi-tasks).
   - `plan` + `in_progress` → `TaskOutput(task_id, block=true)`.
   - `plan` + `completed` → `task_consume(task_id)`.

### Intent → plan conversion

`task_convert_intent` (`:384`):

1. Reads the intent (`store.get(params.task_id)`).
2. Refuses on non-intent type or already-converted state
   (`ConvertIntentError`).
3. Flips the intent's status to `"completed"` with
   `metadata.converted = true, converted_at = now`.
4. Rejects empty `plan` arrays (`orchestrator-tool.ts:415`) before any
   task creation.
5. For each `plan` entry, calls `store.create(...)` (`:469`) with
   `type: "plan"`, `metadata.source_intent = intent.id`, and the
   entry's `agentType` / `blockedBy` / `blocks` edges wired in.

### Verdict parsing on the read side

`task_consume` for Reviewer tasks:

1. Loads the task via `store.get(task_id)`.
2. Refuses on `type === "intent"` (`not_plan` error) or
   `status !== "completed"` (`not_completed` error).
3. Reads `metadata.result`; if the task's `agentType === "Reviewer"`,
   calls `parseVerdict(result)` (`verdict.ts:40`) and
   `suggestFollowUp(verdict)` (`verdict.ts:55`) from `verdict.ts`.
4. Returns a structured envelope the LLM can act on.

### Brainstorming 5-phase flow

The `/brainstorm` slash command is registered via the SKILL file at
`pi-orchestrator/skills/brainstorming/SKILL.md`. Internally it drives
the `BrainstormStateMachine`:

1. `startBrainstorm` (`:425`) → `phase: "exploring"`, emits project
   context.
2. `processClarifyingPhase` (`:446`) → `phase: "clarifying"`, emits
   the 4 multiple-choice questions.
3. `processProposingPhase` (`:473`) → `phase: "proposing"`, emits 3
   approaches with pros/cons.
4. `processDesigningPhase` (`:506`) → `phase: "designing"`, emits
   architecture / data-flow / testing sections for approval.
5. `finalizeDesign` (`:530`) → `phase: "approved"`, writes
   `<ORCHESTRATOR_WORKDIR>/<projectKey(cwd)>/designs/<date>-<slug>.md`
   via `writeDesignDoc` (`:372`).

After approval the design doc is an in-memory handoff — the LLM
materializes it into plan tasks via raw `TaskCreate × N + TaskExecute`.

## Discrepancy watch

- `templates/SYSTEM.md:32-218` and `templates/SYSTEM.md:274` describe an
  `orchestrate(plan)` convenience tool. The current code does NOT
  register that tool — it has been replaced by the three-tool surface
  (`task_inspect` / `task_consume` / `task_convert_intent`)
  implemented in `orchestrator-tool.ts`. `AGENTS.md` was updated to
  drop the `orchestrate` reference, but `templates/SYSTEM.md` (loaded
  on every `before_agent_start` at `extension.ts:194`) still ships the
  old text. Treat any `orchestrate(plan)` mention in the template as
  historical text that points at `task_convert_intent` semantically.
- The `SUBAGENT_CONTROL_TOOLS` constant names 4 tools
  (`subagent_status` / `subagent_steer` / `subagent_abort` /
  `subagent_resume`) documented in `templates/SYSTEM.md`, but no
  source file in this repo registers those names — they are not in
  `pi-subagents/src/index.ts` either. The orchestrator's
  `setActiveTools` therefore passes them through `pi` filtering, which
  silently drops unknown names. Live behavior: the runtime sees only
  the 3 subagents tools (`Agent` / `get_subagent_result` /
  `steer_subagent`). Treat those
  four names as docs-only placeholders — they are referenced in the
  install scripts and templates, not in any registered handler.

## Verification

- `cd pi-orchestrator && bun run typecheck` — TypeScript check.
- `cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/` —
  unit + integration tests, including
  `extension-active-tools.test.ts` (asserts the 4 SUBAGENT_CONTROL
  names appear in the allowlist) and `smoke/gc-2026-073.test.ts`
  (smoke checks the same).
- `cd pi-orchestrator && bash scripts/install.sh` — installs to
  `~/.pi/packages/pi-orchestrator` and writes the orchestrator's
  templates into the user agent directory.

## Where to learn more

- [`pi-tasks.md`](./pi-tasks.md) — the board this orchestrator consumes.
- [`pi-subagents.md`](./pi-subagents.md) — the executor whose tools
  are in the orchestrator's allowlist.
- `pi-orchestrator/templates/SYSTEM.md` — the constitution that is
  prepended to every LLM system prompt.
- `pi-orchestrator/skills/orchestrator/SKILL.md` — the workflow
  reference.
- `pi-orchestrator/skills/brainstorming/SKILL.md` — the brainstorming
  slash command reference.
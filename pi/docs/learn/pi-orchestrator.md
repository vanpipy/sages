# `pi-orchestrator` — Task Orchestrator (planning layer)

> Source: `pi-orchestrator/` (workspaces member; npm namespace
> `@sages/pi-orchestrator`).
> File count: 8 source files in `src/` (extension.ts, index.ts,
> orchestrator-tool.ts, phase-validation.ts, verdict.ts,
> brainstorming/{index,state,types}.ts),
> plus `templates/`, `skills/`, `scripts/install.sh`.

## Purpose

The orchestrator is the LLM's session shell. It does three things:

1. **Curate the tool allowlist** on `session_start` (`extension.ts:202`)
   so the LLM sees only the tools it should use, in the right
   priority order.
2. **Prepend the orchestrator operating policy** (`templates/SYSTEM.md`)
   on every `before_agent_start` (`extension.ts:222`).
3. **Fire the once-per-session soft-mode reminder** on the first side-
   effecting tool call (`extension.ts:237`).

On top of that shell, it registers six LLM-facing consumer tools
(post `GC-2026-iterative-intent-plan`): two read-side
(`task_inspect`, `task_consume`) and four intent→plan conversion
tools (atomic `task_convert_intent` plus the iterative
todowrite-first primitives `task_plan_intent` + `task_add_phase` +
`task_close_intent`). The orchestrator's LLM uses these to read and
shape the board. Also shipped: a `/brainstorm` slash command whose
5-phase state machine drives design-doc generation.

The orchestrator is a **consumer** of the task flow, not its manager.
Per the file header at `orchestrator-tool.ts:1–39`, it adds tasks via
pi-tasks's `TaskCreate` (with `type` set to `"intent"` or `"plan"`),
reads via `TaskList` / `TaskGet`, dispatches via `TaskExecute`. Its
six tools add: routing hints on the read side (`task_inspect`),
verdict parsing on the read side (`task_consume`), atomic
intent → plan conversion on the write side (`task_convert_intent`),
and the iterative todowrite-first flow (`task_plan_intent` →
`task_add_phase` × N → `task_close_intent`).

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
`registerOrchestratorExtension` (`extension.ts:267`) as default.

`src/index.ts` is the public re-export surface for non-extension callers:

- Re-exports brainstorming helpers (`pi-orchestrator/src/index.ts:14–33`).
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

Top 11, ordered by importance:

1. **`installSessionHooks`** — `pi-orchestrator/src/extension.ts:200`.
   The three lifecycle hooks:
   - `session_start` (`extension.ts:202`): the array body starts at
     `:203` — `pi.setActiveTools([...PI_TASKS_TOOLS, ...SUBAGENT_TOOLS, ...AFT_TOOLS, ...BASELINE_TOOLS, ...PI_ROUTINES_TOOLS])`,
     plus an optional status notification.
   - `before_agent_start` (`extension.ts:222`): prepends
     `templates/SYSTEM.md` to the LLM's system prompt.
   - `tool_call` (`extension.ts:237`): fires `SOFT_MODE_REMINDER`
     (`extension.ts:167`) once per session on the first
     side-effecting call (`bash` / `edit` / `write`).

2. **`registerOrchestratorExtension`** (default export) —
   `pi-orchestrator/src/extension.ts:267`. Wires `installSessionHooks`
   + `registerOrchestratorTools` (`orchestrator-tool.ts:983`).

3. **Tool allowlist constants** — `pi-orchestrator/src/extension.ts`.
   - `PI_SUBAGENT_TOOLS` (`:49`): `["Agent", "get_subagent_result", "steer_subagent"]`.
   - `SUBAGENT_CONTROL_TOOLS` (`:73`): `["subagent_status", "subagent_steer", "subagent_abort", "subagent_resume"]`.
     These names are still passed to `pi.setActiveTools`, but no
     extension registers them — the `pi-subagents` implementation was
     dropped in `a36ae68`, and the prompt suite no longer advertises
     them either (see
     [`pi-subagents.md`](./pi-subagents.md#discrepancy-watch)).
   - `SUBAGENT_TOOLS` (`:84`): the union of the two above.
   - `BASELINE_TOOLS` (`:93`): `["bash", "read", "edit", "write", "grep", "find", "ls"]`.
   - `PI_TASKS_TOOLS` (`:108`): the 7 `Task*` tools from `@sages/pi-tasks`.
   - `AFT_TOOLS` (`:122`): the 11 AFT tools from `@cortexkit/aft-pi`.
   - `PI_ROUTINES_TOOLS` (`:153`): the 6 routines tools from
     `pi-routines` (SAGES sage peer / fork of
     `@davecodes/pi-routines@0.6.0`; opt-in; missing extension
     degrades gracefully).

4. **`task_inspect`** — registered at
   `pi-orchestrator/src/orchestrator-tool.ts:985`.
   Read just the routing-relevant fields of a task:
   `id`, `subject`, `type`, `status`, `agentType`, `hasResult`.
   Lets the orchestrator's LLM route on the result
   (`type='intent'` → `task_convert_intent`, `plan + pending` →
   `TaskExecute`, `plan + completed` → `task_consume`).
   `InspectParams` is declared at `orchestrator-tool.ts:79`,
   `InspectOutput` at `:90`, `TaskInspectError` at `:100`.

5. **`task_consume`** — registered at
   `pi-orchestrator/src/orchestrator-tool.ts:998`.
   Read a completed plan task's result. Returns
   `{ id, subject, status, agentType, result, verdict?, read_at, follow_up_suggestion? }`.
   Pure read — does NOT mutate the store. Errors:
   `TaskConsumeError(kind: "not_found" | "not_completed" | "not_plan")`
   (`orchestrator-tool.ts:182`).

6. **`task_convert_intent`** — registered at
   `pi-orchestrator/src/orchestrator-tool.ts:1035`.
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
   (`orchestrator-tool.ts:365`). The plan tasks get
   `metadata.source_intent`, `metadata.phase`, and `metadata.agentType`
   auto-stamped.

7. **`task_plan_intent` / `task_add_phase` / `task_close_intent`** —
   registered at `pi-orchestrator/src/orchestrator-tool.ts:1086 / 1099 /
   1115`. The iterative intent→plan trio, used instead of the atomic
   converter when the plan is built one phase at a time:
   - `task_plan_intent` (step 1) declares `intent_shape` + `rationale`
     on the intent and stamps `metadata.planning`; it creates no tasks
     and the intent stays `pending`.
   - `task_add_phase` (step 2) materializes one plan task per call and
     validates the running phase list against the declared shape via
     `validateCumulativePhases` (`phase-validation.ts:139`).
   - `task_close_intent` (step 3, terminal) flips the intent to
     `completed` and runs `validatePlanShape`
     (`phase-validation.ts:238`) over the accumulated phases.

8. **`parseVerdict` / `suggestFollowUp`** —
   `pi-orchestrator/src/verdict.ts:40 / 68`. Pure functions over the
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

9. **Brainstorming slash command pipeline** —
   `pi-orchestrator/src/brainstorming/index.ts`. Re-exported through
   `pi-orchestrator/src/index.ts:14-33`; defined in
   `pi-orchestrator/src/brainstorming/index.ts`. Top entries:
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
   - `parseTransitionResponse` (`:634`) + `generateApprovalMessage`
     (`:597`): the proceed / defer / exit hint after approval.
   - `createOrchestratorContext` (`:666`): in-memory handoff — the
     design doc + intent + project context are surfaced so the LLM
     can feed them into raw `TaskCreate × N + TaskExecute` (no
     orchestrator tool mediates the transition post-GC-2026-remove-goal-contract).

10. **`BrainstormStateMachine`** —
   `pi-orchestrator/src/brainstorming/state.ts:39`. Drives the phase
   transitions: `exploring → clarifying → proposing → designing → approved/cancelled`.
   Valid transitions table at `:25`. `process(event)` dispatches on
   the event union (`brainstorming/types.ts:264`).

11. **Template assets** —
    - `templates/SYSTEM.md` — the always-on orchestrator operating
      policy (path const at `extension.ts:192`, applied at `:224`).
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
   - `installSessionHooks(pi)` (`extension.ts:200`) installs the 3 hooks.
   - `registerOrchestratorTools(pi)` (`orchestrator-tool.ts:983`) registers
     the 6 LLM-facing tools on the host.
2. The `session_start` hook calls `setActiveTools([...])` with the
   curated allowlist. The LLM now sees only the tools that belong to
   the orchestrator's workflow — anything else (raw `bash`,
   repo-level `read`, etc.) is filtered to the curated `BASELINE_TOOLS`.
3. The first `before_agent_start` event reads `SYSTEM.md` and
   prepends it to the LLM system prompt.
4. The first `bash` / `edit` / `write` call triggers the soft-mode
   reminder, which fires only once per session
   (`reminderFired` flag at `extension.ts:236`).

### Task routing via `task_inspect`

LLM flow when it sees an unhandled task:

1. `task_inspect(task_id)` → `{ id, type, status, agentType, hasResult }`.
2. LLM branches on `type`:
   - `intent` + `pending` (no `metadata.planning`) → `task_plan_intent(task_id, plan)` (iterative step 1) or `task_convert_intent(task_id, plan)` (atomic one-shot, `:1035`).
   - `intent` + `pending` (has `metadata.planning`) → `task_add_phase(intent_id, phase)` (iterative step 2) or `task_close_intent(intent_id)` (iterative step 3, terminal).
   - `intent` + `completed` (has `metadata.converted`) → terminal; no further action.
   - `plan` + `pending` → `TaskExecute([task_id])` (in pi-tasks).
   - `plan` + `in_progress` → `TaskOutput(task_id, block=true)`.
   - `plan` + `completed` → `task_consume(task_id)`.

### Intent → plan conversion

`task_convert_intent` (`:1035`):

1. Reads the intent (`store.get(params.task_id)`).
2. Refuses on non-intent type or already-converted state
   (`ConvertIntentError`).
3. Flips the intent's status to `"completed"` with
   `metadata.converted = true, converted_at = now`.
4. Rejects empty `plan` arrays (`orchestrator-tool.ts:420`) before any
   task creation.
5. For each `plan` entry, calls `store.create(...)` (`:474`) with
   `type: "plan"`, `metadata.source_intent = intent.id`, and the
   entry's `agentType` / `blockedBy` / `blocks` edges wired in.

### Verdict parsing on the read side

`task_consume` for Reviewer tasks:

1. Loads the task via `store.get(task_id)`.
2. Refuses on `type === "intent"` (`not_plan` error) or
   `status !== "completed"` (`not_completed` error).
3. Reads `metadata.result`; if the task's `agentType === "Reviewer"`,
   calls `parseVerdict(result)` (`verdict.ts:40`) and
   `suggestFollowUp(verdict)` (`verdict.ts:68`) from `verdict.ts`.
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

- The root-level `system prompt` in `templates/SYSTEM.md` was updated in
  this commit to reflect the six-tool surface (post
  `GC-2026-iterative-intent-plan`). The Identity section's "one LLM-facing
  tool" claim was historically about an `orchestrate(plan)` convenience
  tool that was retired; the current surface is
  `task_inspect` / `task_consume` / `task_convert_intent` (atomic) /
  `task_plan_intent` (iterative step 1) / `task_add_phase` (iterative
  step 2) / `task_close_intent` (iterative step 3). The prompt-suite
  refactor has since restructured `templates/SYSTEM.md` into 16
  numbered sections; the tool surface is now stated once, in § 12.
- The `SUBAGENT_CONTROL_TOOLS` constant still names 4 tools
  (`subagent_status` / `subagent_steer` / `subagent_abort` /
  `subagent_resume`) and `setActiveTools` still passes them through
  pi's filtering, which silently drops unknown names. But no source file
  in this repo registers those names — they are not in
  `pi-subagents/src/index.ts` either, because the `pi-subagents`
  implementation was dropped in `a36ae68`. Live behavior: the runtime
  sees only the 3 subagents tools (`Agent` / `get_subagent_result` /
  `steer_subagent`). As of the prompt-suite refactor the four names are
  no longer advertised in `templates/SYSTEM.md` or
  `templates/agent-tool-description.md`; they survive only as
  allowlist entries.
- Isolation drift (resolved). The root `AGENTS.md` used to document an
  isolation object form `{ goal_id, task_id, mode }` for the Agent tool,
  while the runtime type in `pi-subagents/src/types.ts:28` is
  `IsolationMode = "worktree" | "off"`. The object form never existed
  in the runtime; production work that needs isolation uses
  `isolation: "worktree"`. `AGENTS.md` now says so. The `TaskExecute`
  spawn options (`pi-tasks/src/index.ts:1418-1423`) pass `description`,
  `isBackground`, `maxTurns` and `model` — no `isolation` — so for
  isolated dispatch, use the `Agent` tool directly.

## Verification

- `cd pi-orchestrator && bun run typecheck` — TypeScript check.
- `cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/` —
  unit + integration tests, including
  `extension-active-tools.test.ts` (asserts the 4 SUBAGENT_CONTROL
  names appear in the allowlist), `prompt-consistency.test.ts` (asserts
  the prompt suite names no tool the runtime does not register) and
  `smoke/gc-2026-073.test.ts` (smoke checks the allowlist).
- `cd pi-orchestrator && bash scripts/install.sh` — installs to
  `~/.pi/packages/pi-orchestrator` and writes the orchestrator's
  templates into the user agent directory.

## Where to learn more

- [`pi-tasks.md`](./pi-tasks.md) — the board this orchestrator consumes.
- [`pi-subagents.md`](./pi-subagents.md) — the executor whose tools
  are in the orchestrator's allowlist.
- `pi-orchestrator/templates/SYSTEM.md` — the always-on operating
  policy that is prepended to every LLM system prompt.
- `pi-orchestrator/skills/orchestrator/SKILL.md` — the on-demand
  playbook plus the tool reference manual.
- `pi-orchestrator/skills/brainstorming/SKILL.md` — the brainstorming
  slash command reference.

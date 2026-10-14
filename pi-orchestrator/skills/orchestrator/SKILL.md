---
name: orchestrator
description: "Soft-infrastructure layer for pi. Wires session_start (curates the tool allowlist), before_agent_start (prepends the orchestrator constitution), and tool_call (once-per-session soft-mode reminder). Owns three LLM-facing tools: `task_inspect` (read type+status+agentType so the LLM can route), `task_consume` (read+parse verdict for completed plan tasks), and `task_convert_intent` (the unique intent→plan converter with a STRUCTURED plan schema — intent_shape + rationale + phases[]). The LLM adds tasks via pi-tasks's `TaskCreate` (with `type` set to 'intent' or 'plan') and dispatches via `TaskExecute`. The orchestrator does not manage the task flow — it only reads and adds; convertIntent is its only state-changing write, and only within the intent→plan conversion path."
---

# Orchestrator — Soft Infrastructure

The orchestrator plays the **Task Orchestrator** role in the three-package
composition: a **consumer** of the Task Board (`pi-tasks/`), not its
manager. It adds tasks via pi-tasks's existing `TaskCreate` (with
`type` set to `'intent' | 'plan'`) and reads them via `task_inspect` /
`task_consume`. The Task Executor (`pi-subagents/`) is spawned by the
board via `TaskExecute`, never sees the board itself, and reports
results back through the event bus. The boundary is enforced by the
host tool allowlist, not by convention. See
[`AGENTS.md`](../../../AGENTS.md#the-three-packages-and-their-roles)
for the full role description.

These role names (Task Board / Task Orchestrator / Task Executor) are
descriptive shorthand; they appear in docs and conversation but not in
the packages' own code.

Post GC-2026-orchestrator-simplify + GC-2026-remove-workflow-run-prod +
GC-2026-decompose-task-removed + **chore/remove-goal-contract** +
**taskBoard-removed** the orchestrator owns exactly **three** LLM-facing
tools: `task_inspect` (route by type/status), `task_consume` (read+parse
verdict), and `task_convert_intent` (the unique intent→plan converter).
The orchestrator is a consumer — it does not manage the task flow.

## What the orchestrator does

| Concern | Mechanism |
|---|---|
| **Tool allowlist at session_start** | `pi.setActiveTools([...PI_TASKS, ...SUBAGENT, ...AFT, ...BASELINE])`. None of those tools are owned by the orchestrator (they come from pi-subagents, pi-tasks, @cortexkit/aft-pi, pi-coding-agent itself); the orchestrator only curates the allowlist. |
| **Constitution overlay at before_agent_start** | Prepends `templates/SYSTEM.md` to the LLM's system prompt. The system prompt is the orchestrator's only persistent instruction surface. |
| **Soft-mode reminder on first side-effecting call** | On the first `bash` / `edit` / `write` tool call per session, appends a reminder that recommends the pi-tasks workflow for active task lists of >2 items. Fires once per session; subsequent calls are silent. |
| **`task_inspect(task_id)` tool** | Read type+status+agentType. The LLM's first call on every task. Routes to `task_convert_intent` (intent), `TaskExecute` (plan pending), `TaskOutput(block=true)` (plan in_progress), or `task_consume` (plan completed). Lighter than `TaskGet`. |
| **`task_consume(task_id, include_transcript?)` tool** | Read a completed plan task in a structured way. Parses the Reviewer's 4-state verdict (`CLEAN` / `NEEDS_WORK` / `NEEDS_REDESIGN` / `NEEDS_CLARIFICATION`) from the result text and emits a verdict-tailored follow-up suggestion. Returns `{ id, subject, status, agentType, result, verdict?, read_at, follow_up_suggestion? }`. Pure read — does not mutate the store. Intent tasks throw `not_plan` — call `task_convert_intent` first. |
| **`task_convert_intent(task_id, plan)` tool** | The orchestrator's unique intent → plan conversion operator. Reads an intent task (`type='intent'`), marks it converted (audit: `metadata.converted / converted_at / intent_shape / rationale`), creates plan tasks with `type='plan'` and `metadata.source_intent` + `phase` + `agentType` linking each back to the intent. The plan is a STRUCTURED OBJECT (`intent_shape` + `rationale` + `phases[]`); runtime validation in [`src/phase-validation.ts`](../src/phase-validation.ts) enforces per-shape phase count + ordering rules. Phase → agentType is mapped deterministically via `PHASE_AGENT_TYPE` (review → Reviewer, all others → Developer) — the LLM never types `agentType` directly. Refuses empty `phases`, non-intent sources, already-converted intents, and plans that violate the shape rules. |

## Subagent `max_turns` tiers

`max_turns` is a **hard ceiling at `tier + 5`** — at turn `tier` the
agent is steered ("wrap up immediately"); at turn `tier + 5` the
runtime hard-aborts and `subagents:failed` fires with `status:
"aborted"`. The orchestrator sees this as `lastError: "aborted"` on the
reverted task (see the [last-error visibility] convention in the
constitution).

Pick the smallest tier that genuinely fits the work; round up when
in doubt — truncating mid-migration is more costly than over-budgeting.

| Tier | Value | Use for |
|------|-------|---------|
| **Light** | `480` | Single-file edits, focused reviews, narrow refactors, debugging sessions. TDD with one or two cycles. Default for Reviewer and short Implement subagents. |
| **Standard** | `960` | Multi-file changes within one package, full TDD cycle (RED → GREEN → REFACTOR), normal cross-module work. Default for most Implement tasks. |
| **Heavy** | `1280` | Cross-package migrations, refactors spanning multiple packages, multi-cycle TDD with retries, parallel tracks that cascade through several `TaskExecute` rounds. |

Rule of thumb: **Standard** by default. Move up to **Heavy** when the
task description lists > 5 files to change, or when a prior Standard
attempt aborted. Move down to **Light** only for narrowly-scoped reviews
or single-line edits.
| **Brainstorming slash command** | `/brainstorm [request]` is registered separately via `skills/brainstorming/SKILL.md`; the orchestrator's own registration machinery is limited to the session hooks + advisory handlers above. |
| **pi-routines board-watch (default-on)** | Sages bundles a `sages-board-watch` routine template (installed to `~/.pi/agent/extensions/routines/templates/`). `install.sh` activates it by default — the routine entry is written into `state.json` atomically during install, so no manual `/routine-install` step is needed. The routine fires every 30s, inspects the board for unhandled `intent` tasks, and routes them through `task_convert_intent` + `TaskExecute`. Closes the awareness gap for out-of-turn task creation (user `/tasks create` while LLM is idle, or other sessions writing to the same board). To opt out, run `/routine-stop sages-board-watch` in any pi session; re-running `install.sh` re-creates the entry. The orchestrator's `PI_ROUTINES_TOOLS` allowlist includes the six routine_* tools so the LLM can also manage routines inline. |

## What the orchestrator no longer does

- It does **not** own `goal_contract_create`, `workflow_run`, or any other removed tool.
  (Note: `decompose_task` was retired earlier; `orchestrate` is its
  spiritual successor — same DAG-creation semantics, but driven by
  a single tool call rather than an RPC event chain.)
- It does **not** write any per-goal state file at the project root.
  The previous `.pi/orchestrator/goal-*.yaml`,
  `.pi/orchestrator/audit-state-*.yaml`, and `.pi/orchestrator/decompose-*.yaml`
  files are retired (see chore/orchestrator-workdir-tmpdir + chore/remove-goal-contract).
- It does **not** enforce any anti-patterns. The previous `goal_drift_detected`
  rule (which required an active goal contract) is removed along with the
  orchestrator-namespace ownership + loadGoalScope machinery.

## The LLM's responsibility

Multi-stage work is the LLM's job. The canonical flow is
**inspect → route**:

```text
// 1. /tasks create "Add /login endpoint" — user-facing intent task appears
2.   TaskList → [{ id: 1, subject: "Add /login endpoint", type: "intent" }]
3.   task_inspect({ task_id: 1 })
     → { id: 1, type: "intent", status: "pending", ... }
4.   // LLM MUST commit to a plan before calling the tool — surface the
     // sketch in its own response so the user can see the methodology:
     //   a. Classify intent_shape (trivial | small | standard |
     //      investigate-then-fix | multi-phase | multi-track).
     //   b. Justify the shape in rationale (one sentence, 10–500 chars).
     //   c. Sequence ordered phases[] (each phase maps to agentType via
     //      PHASE_AGENT_TYPE — review → Reviewer, all others → Developer).
5.   task_convert_intent({
       task_id: 1,
       plan: {
         intent_shape: "standard",
         rationale: "Multi-file within one package with a full RED→GREEN→REFACTOR cycle; one Reviewer at the end.",
         phases: [
           { phase: "implement", subject: "Implement /login endpoint", description: "..." },
           { phase: "review",    subject: "Review /login implementation", description: "..." },
         ],
       },
     })
   → plan tasks created in order, intent #1 marked converted
6.   TaskExecute([first_id])  // dispatches the first plan task
```

The plan schema + runtime validation enforce the methodology: shape
classification is required, rationale is required, phase count +
ordering are validated per shape, and at most one `review` phase is
allowed. The LLM cannot bypass these constraints — a malformed plan is
rejected with `ConvertIntentError(kind: "shape_violation", message: ...)`
naming the violated rule. Fix and retry.

For the full shape rules and per-rule error messages, see
[`src/phase-validation.ts`](../src/phase-validation.ts). The schema
itself is the source of truth for what the LLM can submit; this section
is the quick reference.

The Reviewer emits one of CLEAN / NEEDS_WORK / NEEDS_REDESIGN /
NEEDS_CLARIFICATION as plain text in its own result. `task_consume`'s
verdict parser extracts it and `suggestFollowUp` emits a verdict-tailored
next-step hint (spawn Developer follow-up / spawn new Implement /
pause for user / move on).

The orchestrator's `task_inspect` is the LLM's first call on every
task — it sees the type without erroring, then routes explicitly.

## Designing the plan — quick reference

The methodology lives in the schema (`src/orchestrator-tool.ts` +
`src/phase-validation.ts`). This section is the index the LLM scans to
pick a shape and sequence phases.

### Shape catalog

The LLM MUST classify the intent into one of these shapes. The shape
drives phase count, first/last phase, and Reviewer placement.

| `intent_shape`        | First phase  | Last phase | Phase count | Reviewer? |
|-----------------------|--------------|------------|-------------|-----------|
| `trivial`             | `implement`  | `implement`| 1           | no        |
| `small`               | `implement`  | `review`   | 2           | yes (last)|
| `standard`            | `implement`  | `review`   | 2           | yes (last)|
| `investigate-then-fix`| `investigate`| `review`   | 3–6         | yes (last)|
| `multi-phase`         | `design`     | `review`   | 3–8         | yes (last)|
| `multi-track`         | `implement`  | (any)      | 2–10        | deferred (join via second intent) |

### Phase → agentType (`PHASE_AGENT_TYPE`)

The LLM never types `agentType` directly — it picks a phase and the
function maps deterministically. Wrong role assignments are structurally
impossible.

| Phase         | agentType   |
|---------------|-------------|
| `investigate` | `Developer` |
| `design`      | `Developer` |
| `implement`   | `Developer` |
| `test`        | `Developer` |
| `review`      | `Reviewer`  |

### Per-phase `description` (min 20 chars)

Each phase carries its own `description` (min 20 chars). This forces
real acceptance criteria instead of inheriting the intent's description
verbatim. A good description covers four things:

1. **What** — the outcome, not the steps.
2. **Where** — file paths or symbols. The subagent starts cold.
3. **Acceptance** — the test command or user-visible signal that says "done".
4. **Evidence** — what `metadata.result` should record (commit SHA, test summary, timings). The Reviewer reads this.

### Worked example — `standard` shape

```ts
task_convert_intent({
  task_id: 7,
  plan: {
    intent_shape: "standard",
    rationale: "Multi-file within one package with a full RED → GREEN → REFACTOR cycle; one Reviewer at the end.",
    phases: [
      {
        phase: "implement",
        subject: "Implement /login endpoint",
        description:
          "Add POST /login handler in src/auth/login.ts: returns 200 + session cookie on valid creds, 401 on bad creds, 400 on missing fields. RED first: failing test in src/auth/login.test.ts (200 / 401 / 400). GREEN: minimum impl. REFACTOR: extract credential check.",
        activeForm: "Implementing /login endpoint",
      },
      {
        phase: "review",
        subject: "Review /login implementation",
        description:
          "Read the Developer's metadata.result. Verify: bun test src/auth/ passes; passwords not logged; cookie is HttpOnly + Secure; commit lands on the worktree branch. Emit CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION.",
        activeForm: "Reviewing /login implementation",
      },
    ],
  },
})
```

### Variations

- **Trivial edit** — `intent_shape: "trivial"`, 1 implement phase, no review.
- **Investigate-then-fix** — `intent_shape: "investigate-then-fix"`, first phase `investigate`, ≥ 1 `implement` next, last `review`. Dispatch sequentially via `TaskExecute([investigate_id])` then `TaskExecute([fix_id])`.
- **Multi-track parallel** — `intent_shape: "multi-track"`, ≥ 2 implement phases, no review in this plan. Dispatch in parallel via `TaskExecute([a, b, c])`; once all complete, convert a SECOND intent whose `task_convert_intent` plan has a single `review` phase with `metadata.phase: "review"` referencing the completed task IDs.

### Anti-patterns the validation rejects

The runtime in `phase-validation.ts` rejects these with
`ConvertIntentError(kind: "shape_violation", message: ...)` naming the
violated rule. The LLM MUST NOT submit them.

- **Over-decomposition** — `trivial` with > 1 phase, or any shape with phases beyond `max`.
- **Under-decomposition** — `small` / `standard` with < 2 phases, or `investigate-then-fix` / `multi-phase` with < 3 phases.
- **Wrong first phase** — `investigate-then-fix` not starting with `investigate`; `multi-phase` not starting with `design`.
- **Missing Reviewer on production code** — `small` / `standard` / `investigate-then-fix` / `multi-phase` not ending with `review`.
- **Extra Reviewer** — `trivial` with a review phase, or any plan with > 1 review phase.
- **Multi-track that's not parallel** — `< 2` implement phases (reclassify as `small` / `standard`).
- **Investigate-then-fix with no fix** — `investigate-then-fix` with no `implement` phase (the whole point is to fix something).
- **Rationale too short / too long** — `< 10` chars or `> 500` chars (forces real justification, not "TODO" or a wall of text).

## Soft mode (unchanged)

> Nothing is mechanically blocked.
> Pick the path that matches the work shape.
> If the active task list has >2 items, the soft-mode reminder fires once
> at the first side-effecting call. It's a recommendation, not a rule.

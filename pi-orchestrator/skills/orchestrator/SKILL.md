---
name: orchestrator
description: "Soft-infrastructure layer for pi. Wires session_start (curates the tool allowlist), before_agent_start (prepends the global operating policy when the base prompt does not already carry it), and tool_call (once-per-session soft-mode reminder). Owns six LLM-facing tools: `task_inspect` (read type+status+agentType so the LLM can route), `task_consume` (read+parse verdict for completed plan tasks), `task_convert_intent` (the atomic intent→plan converter with a STRUCTURED plan schema — intent_shape + rationale + phases[]), and the iterative plan-first primitives `task_plan_intent` + `task_add_phase` + `task_close_intent`. The LLM adds tasks via pi-tasks's `TaskCreate` (with `type` set to 'intent' or 'plan') and dispatches via `TaskExecute`. The orchestrator does not manage the task flow — it only reads and adds; the four intent→plan conversion tools are its only state-changing writes, and only within the intent→plan conversion path. Also carries the reference manual: the tool tables, the shape catalog, the phase → agentType map, the decision recipes and the commit conventions."
---

# Orchestrator Playbook

## 1. Scope and How to Use

This playbook is the **method and the manual** for the Sages Task
Orchestrator. It has two halves:

- **§2–§5 — the method.** What the orchestrator is, the
  inspect → plan → dispatch → consume loop, how to turn an intent into a
  structured plan, and the quick reference for the plan shapes.
- **§6–§9 — the manual.** The tool reference, the decision recipes, the
  commit conventions, and the soft-mode routing rule.

### How this relates to the other prompt tiers

| Tier | Artifact | Carries |
|---|---|---|
| Always on | `templates/SYSTEM.md` | The operating policy: the boundary, the routing rules, the red lines. Prepended to every system prompt. |
| On demand | `skills/orchestrator/SKILL.md` (this file) | The playbook plus the reference manual. Loaded when the orchestrator needs the procedure or a tool lookup. |
| Tool-scoped | `templates/agent-tool-description.md` | The `Agent` tool description — how to call that one tool. |

Loading this skill **does not replace the global operating policy** in
`templates/SYSTEM.md`, and it does not repeat it either. `SYSTEM.md`
states the rules that hold at all times. This file states the procedure
you follow and the manual you consult. Where a fact has exactly one
owner, this file points at that owner instead of restating it.

### When to load it

- An intent task arrived on the board and needs a plan (§3, §4, §5).
- You are about to dispatch a subagent and need the tool names or the
  Implement → Review shape (§6).
- You are choosing between tools for a concrete job (§7).
- You are about to commit (§8).

For a single small edit with no task graph you do not need this file —
use `edit` / `write` / `bash` directly (§9).

## 2. What the Orchestrator Does

The orchestrator plays the **Task Orchestrator** role in the three-package
composition: a **consumer** of the Task Board (`pi-tasks/`), not its
manager. It adds tasks via pi-tasks's `TaskCreate` (with `type` set to
`'intent' | 'plan'`) and reads them via `task_inspect` / `task_consume`.
The Task Executor (`pi-subagents/`) is spawned by the board via
`TaskExecute`, never sees the board itself, and reports results back
through the event bus. The boundary is enforced by the host tool
allowlist, not by convention. See
[`AGENTS.md`](../../../AGENTS.md#the-three-packages-and-their-roles)
for the full role description.

These role names (Task Board / Task Orchestrator / Task Executor) are
descriptive shorthand; they appear in docs and conversation but not in the
packages' own code.

| Concern | Mechanism |
|---|---|
| **Tool allowlist at session_start** | The orchestrator curates the active tool set when the session starts. The tools themselves come from pi-subagents, pi-tasks, @cortexkit/aft-pi, pi-coding-agent itself, and `pi-routines`; the orchestrator owns only the six tools below. |
| **Constitution overlay at before_agent_start** | Prepends `templates/SYSTEM.md` to the LLM's system prompt — the orchestrator's only persistent instruction surface. |
| **Soft-mode reminder on first side-effecting call** | On the first `bash` / `edit` / `write` call per session, appends a reminder that recommends the pi-tasks workflow when the active task list has more than two items. Fires once per session; later calls are silent. |
| **`task_inspect` / `task_consume`** | The two read-side tools. `task_inspect` returns type + status + agentType so the LLM can route. `task_consume` reads a completed plan task's result in structured form and parses the Reviewer's 4-state verdict. |
| **The four intent → plan tools** | `task_convert_intent` (atomic one-shot) plus the iterative flow `task_plan_intent` → `task_add_phase` → `task_close_intent`. The orchestrator does not manage the task flow — it adds tasks and reads them. |
| **Brainstorming slash command** | `/brainstorm [request]` is registered separately via [`skills/brainstorming/SKILL.md`](../brainstorming/SKILL.md). |
| **pi-routines board-watch (fallback)** | Sages bundles a `sages-board-watch` routine template (installed to `~/.pi/agent/extensions/routines/templates/`). `install.sh` activates it by default — the routine entry is written into `state.json` atomically during install, so no manual `/routine-install` step is needed. The routine fires every 30s, inspects the board for unhandled `intent` tasks, and routes them through `task_convert_intent` + `TaskExecute`. It closes the awareness gap for out-of-turn task creation. To opt out, run `/routine-stop sages-board-watch` in any pi session; re-running `install.sh` re-creates the entry. |

## 3. The Inspect → Plan → Dispatch → Consume Loop

### The LLM's responsibility

Multi-stage work is the LLM's job. The orchestrator does not manage the
task flow — it **adds** tasks and **reads** them. Every multi-stage
effort therefore runs the same four phases: inspect what is on the
board, plan the phases, dispatch them, consume the results.

The canonical flow is **inspect → plan → iterate**. For clear
intents that fit a single shape with a known phase list, the atomic
`task_convert_intent` path is fine. For complex goals (3+ plan tasks,
mid-implementation discoveries, parallel tracks), use the **iterative**
plan-first flow.

### Phase 1 — Inspect

Every task that reaches you is read first. `task_inspect` returns the
routing-relevant fields (`type`, `status`, `agentType`) without erroring
on the wrong type, so you can route explicitly:

| Observed | Route to |
|---|---|
| `type='intent'`, `status='pending'` | `task_plan_intent` (iterative) or `task_convert_intent` (atomic) — see §4 |
| `type='plan'`, `status='pending'` | `TaskExecute` |
| `type='plan'`, `status='in_progress'` | `TaskOutput(block=true)` |
| `type='plan'`, `status='completed'` | `task_consume` |

`TaskList` is the discovery call: it lists everything on the board, so
run it when you do not know what is there (at the start of a session, or
after an intent arrived out of turn).

### Phase 2 — Plan

Sketch the phase list **first**: each phase is one plan task you intend
to dispatch. Then convert incrementally — do not commit the full phase
list up front for a complex goal.

```text
1. Read the intent (subject + description) via task_inspect.
2. Sketch the phase list; each phase is one plan task you will dispatch.
3. task_plan_intent(intent_id, intent_shape, rationale)  # declare shape
4. for each phase in the list:
     task_add_phase(intent_id, phase, subject, description, ...)
5. After all phases added, task_close_intent(intent_id)  # terminal audit
6. TaskExecute([first_plan_id])  # dispatch begins
```

**Why this matters.** The atomic `task_convert_intent` path commits the
full phase list in a single call. For complex goals the LLM defaults to
the minimum `standard` (2 phases) because iteration is mechanically
blocked — once committed, no more plan tasks can be added to that
intent. The iterative path inflates the phase count for goals that
genuinely span 3+ plan tasks and lets the LLM commit incrementally as the
implementation phase discovers more work.

Shape classification belongs to §4 (method) and §5 (quick reference).

### Phase 3 — Dispatch

Dispatch is `TaskExecute([first_plan_id])`. pi-tasks auto-cascades: when
a task completes, the tasks it blocks become ready and the cascade fires.
`TaskExecute([a, b, c])` dispatches several tasks at once — use that for
`multi-track` shapes whose phases are independent.

The shipped subagent types are `Developer` (implementation) and `Reviewer`
(review), and which type a phase runs as is not yours to choose: the
phase name decides it (§5). Give a production-code `Developer`
`isolation: "worktree"`; meta-file work may run in the current checkout.
`isolation` accepts `"off"` or `"worktree"` only — see `SYSTEM.md` §7.

### Phase 4 — Consume

`TaskOutput(task_id, block=true)` waits for a running task's report.
`task_consume` reads a completed `plan` task in structured form and, for
a Reviewer task, parses the 4-state verdict (`CLEAN` / `NEEDS_WORK` /
`NEEDS_REDESIGN` / `NEEDS_CLARIFICATION`) and emits a verdict-tailored
follow-up suggestion.

The verdict is an **input**, not proof. Read the diff, run the check and
confirm the outcome yourself before declaring the work done. A
`NEEDS_WORK` verdict is your cue to spawn the follow-up; `CLEAN` is your
cue to verify, not to stop verifying.

### The plan schema is enforced

The plan schema + runtime validation enforce the methodology: shape
classification is required, rationale is required, phase count +
ordering are validated per shape, and at most one `review` phase is
allowed. The LLM cannot bypass these constraints — a malformed plan is
rejected with `ConvertIntentError(kind: "shape_violation", message: ...)`
naming the violated rule. Fix and retry.

For the full shape rules and per-rule error messages, see
[`src/phase-validation.ts`](../../src/phase-validation.ts). The schema
itself is the source of truth for what the LLM can submit; §4 and §5 are
the quick reference.

## 4. Planning Methodology — From Intent to Structured Plan

The schema (`task_convert_intent`) enforces the *output* — a structured
plan object with `intent_shape`, `rationale`, `phases[]`. This section is
the *input*: how the LLM gets from "intent subject + description" to a
structured plan it can commit to. Apply these steps every time a new
intent task arrives on the board (whether you noticed it via `TaskList`
or the board-watch routine surfaced it, or `pi-sidebar-sages` is rendering the task board in the sidebar's Tasks panel).

### The 5-step loop

#### 1. Read the intent + scan context

Pull the intent's subject and description (`task_inspect` if not already
in hand). Look at the conversation history for: prior brainstorming
(`/brainstorm` results), related plan tasks already on the board, file
paths / symbols the user mentioned. The intent's description is the
primary signal; everything else is supporting.

#### 2. Classify — pick an `intent_shape`

Apply the heuristics in order; the first one that fits wins.

| If the intent matches... | Then classify as |
|---|---|
| One-line fix / doc tweak / config change / typo / rename | `trivial` |
| Single file, one clear test, one TDD cycle | `small` |
| Multi-file within one package, full RED → GREEN → REFACTOR. **Default when no other shape clearly applies.** | `standard` |
| Unknown root cause, flaky test, "this should work but doesn't" | `investigate-then-fix` |
| Design-first, new schema, new contract, staged rollout, downstream work depends on an upfront decision | `multi-phase` |
| Multiple parallel workstreams that join for review (cross-package migration, multi-component feature) | `multi-track` |

**Default**: when in doubt, `standard`. Most non-trivial work fits the
Implement → Review pattern. Down-classify to `small` when the change is
genuinely bounded to one file. Up-classify to `investigate-then-fix` is
mandatory when the root cause isn't known.

#### 3. Compose `rationale` (one sentence, 10–500 chars)

The rationale is the LLM's commitment: "I picked this shape BECAUSE...".
Examples by shape:

- `trivial`: "One-line typo fix; trivial shape — no review needed."
- `small`: "Single file with a clear failing test; one Reviewer at the end."
- `standard`: "Multi-file within one package, full RED → GREEN → REFACTOR; one Reviewer at the end."
- `investigate-then-fix`: "Flaky on CI, root cause unknown — investigate first, then fix."
- `multi-phase`: "Staged rollout; design the new schema first, then implement + test."
- `multi-track`: "Three packages migrating in parallel; Reviewer joins via a second intent."

The schema enforces 10–500 chars. Aim for 1 sentence. Never just "TODO"
or the intent's description verbatim.

#### 4. Decompose `phases`

For each shape, the canonical phase sequence (see the Shape catalog
below for the full per-shape rules):

| Shape | Phase sequence |
|---|---|
| `trivial` | `[implement]` |
| `small` | `[implement, review]` |
| `standard` | `[implement, review]` |
| `investigate-then-fix` | `[investigate, implement, review]` (+ optional `test`) |
| `multi-phase` | `[design, implement, test, review]` (+ optional middle phases) |
| `multi-track` | `[implement, implement, ...]` (≥ 2 parallel tracks; review deferred) |

Per-phase `description` MUST cover **What / Where / Acceptance / Evidence**:

1. **What** — outcome, not steps.
2. **Where** — file paths or symbols. Subagent starts cold.
3. **Acceptance** — test command or user-visible signal that says "done".
4. **Evidence** — what `metadata.result` should record. The Reviewer reads this.

#### 5. Surface the plan, then commit

Print the structured plan as a markdown block in the LLM's own response
(the user's channel) so the user can see what was committed:

```text
Plan for #1 "Add /login endpoint":
- intent_shape: standard
- rationale: "Multi-file within one package, full RED → GREEN → REFACTOR; one Reviewer at the end."
- phases:
  - [implement] Implement /login endpoint — ...
  - [review]    Review /login implementation — ...
```

Then call `task_convert_intent({ task_id, plan: { intent_shape, rationale, phases } })`.

### When to `/brainstorm` instead

The methodology above is for *clear* intents. If the intent matches any
of these, **stop and run `/brainstorm [request]` first**:

- Subject is vague or has multiple plausible interpretations ("improve the auth flow").
- Scope is ambiguous (which packages? which files? which tests?).
- The user hasn't decided on an approach and the choice between approaches has real cost (new schema vs. migration, single-repo vs. cross-repo, etc.).
- The intent touches an area where brainstorming has previously surfaced open questions.

The output of `/brainstorm` is a `DesignDoc` (intent spec, approach
comparison, design sections). Once approved, the orchestrator converts
the approved design into tasks — at that point this methodology applies
to each intent the design produced.

For everything else — clear requests, bounded changes, known root
causes — apply the 5-step loop directly.

## 5. Designing the Plan — Quick Reference

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

## 6. Tool Reference

Which tool to reach for first is ranked in the `Agent` tool description
(`templates/agent-tool-description.md`) — that is its single owner and
the ranking is not repeated here. What follows is the reference manual:
what each tool does, and how the orchestrator's own tools fit together.

### 6.1 File / network — default for simple cases

| Tool | Use for |
|---|---|
| `read` | one or more files. Prefer over `aft_zoom` when you know the exact path. |
| `write` | create / overwrite a file. Atomic. Backs up existing files (undo via `aft_safety`). |
| `edit` | surgical edits via `appendContent` / `edits` / `symbol` + `content`. For ≤10 lines. |
| `grep` | trivial file search. |

### 6.2 Bash — shell, long-running processes, PTY

`bash` — the host registers a single bash tool.

### 6.3 AFT — `@cortexkit/aft-pi` indexed code intelligence

| Tool | Use for |
|---|---|
| `aft_search` | auto-routes concepts, identifiers, regex, literals. Single best code-search primitive. |
| `aft_outline` | file / module structure (symbols, exports, members). First call when entering an unfamiliar file. |
| `aft_zoom` | symbol-level read. After `aft_outline`, read one specific symbol. |
| `aft_callgraph` | callers + callees of a symbol. Blast-radius analysis. |
| `aft_inspect` | diagnostics / health / TypeScript errors / dead code / unused exports. Run after a batch of edits and before tests/commit. |
| `aft_import` | which module exports a given symbol. |
| `aft_refactor` | structural edits (rename across files, signature change, move/rename). Trivial edits → `edit`. |
| `aft_move` / `aft_delete` | file ops. Use `aft_move` over manual `mv` when there are import sites. |
| `aft_conflicts` | all merge / rebase conflict regions in a single call. |
| `aft_safety` | backup / undo. Existing files backed up before overwrite. |

### 6.4 Pi-tasks workflow engine — `@sages/pi-tasks`

Workflow is driven by pi-tasks (DAG-shaped task list with
auto-cascade). Each task has a `blocks` / `blockedBy` edge set and
an `agentType` that the runtime spawns when unblocked.

| Tool | Use for |
|---|---|
| `TaskCreate` | create a task + edges (`blocks`, `blockedBy`) + `agentType`. |
| `TaskList` | list all tasks (filter by status). |
| `TaskGet` | read one task's detail. |
| `TaskUpdate` | mutate task status / add edges. |
| `TaskExecute` | dispatch tasks (auto-cascade fires blockedBy completion). |
| `TaskOutput` | wait for an executed task's report. |
| `TaskStop` | stop a running task. |

#### Subagent turn budget

The `max_turns` tier table and the turn ceiling are owned by the
`TaskExecute` tool description — the copy the model reads at dispatch
time. This file does not restate them. Pick the smallest tier that
genuinely fits the work and round up when in doubt: truncating
mid-migration costs more than over-budgeting.

#### pi-routines — `pi-routines` (opt-in)

Optional scheduled / event-driven routines extension. If installed
(by `install.sh`), these six tools let the LLM manage routines that
fire on `pulse` / `cron` / `oneoff` / `hook` / `api` / `github`
triggers. `pi-routines` is a SAGES sage peer (file-copied from
./pi-routines/ to `~/.pi/packages/pi-routines/` by install.sh; see
`pi-routines/SAGES-FORK.md` for fork lineage). Sages ships a
`sages-board-watch` template (installed to
both `~/.pi/agent/extensions/routines/templates/` and the pi-routines
peer's `templates/` dir) that drives a 30s pulse to route out-of-turn
task additions — covering the out-of-band awareness gap between user
/ `/tasks create` writes and the LLM's next turn. `install.sh`
activates the routine by default (writes its entry into `state.json`
atomically), so no manual `/routine-install` step is needed. To opt
out, run `/routine-stop sages-board-watch` in any pi session;
re-running `install.sh` re-creates the entry.

| Tool | Use for |
|---|---|
| `routine_create` | define a new routine (trigger + prompt + options). |
| `routine_list` | list active routines. |
| `routine_delete` | remove a routine. |
| `routine_run_now` | fire a routine immediately (skip its schedule). |
| `routine_set_state` | persist a JSON state blob across ticks. |
| `routine_get_state` | read the persisted state. |

### 6.5 Standard pattern — Implement → Review

```
TaskCreate(Implement, agentType="Developer", blocks=[Review])
TaskCreate(Review,    agentType="Reviewer",  blockedBy=[Implement])
TaskExecute([Implement])
```

Reviewer reads the Implement task's `metadata.result` (via `TaskOutput`)
and emits one of CLEAN / NEEDS_WORK / NEEDS_REDESIGN /
NEEDS_CLARIFICATION as plain text in its own result. The orchestrator
(the main LLM) reads the verdict via `TaskOutput` and decides whether
to declare the work done or to spawn a follow-up Fix task (with
`agentType="Developer"`, blockedBy the Review) by hand.

For multi-step work with parallel tracks or conditional dependencies,
write the DAG yourself as `TaskCreate` × N; for the standard
2-phase shape, `task_convert_intent` collapses it into one call. For
complex goals, prefer the iterative `task_plan_intent` + `task_add_phase`
+ `task_close_intent` flow so the LLM can inflate the phase count as
the implementation phase discovers more work.

### 6.6 Sages orchestrator tools — `pi-orchestrator`

The orchestrator owns six LLM-facing tools. The LLM inspects every
task via `task_inspect` first to see its `type` and `status`, then routes
explicitly to `task_consume` (for completed plans) or the
intent→plan conversion operator (atomic `task_convert_intent` or the
iterative `task_plan_intent` + `task_add_phase` × N + `task_close_intent`
flow). The orchestrator does NOT manage the task flow — it only adds
tasks (via pi-tasks's `TaskCreate` or the conversion tools) and reads
them (via `task_inspect` / `task_consume`).

**Read side (2):**

| Tool | Use for |
|---|---|
| `task_inspect(task_id)` | Inspection **before** deciding which other tool. Returns `{ id, subject, type: 'intent'\|'plan', status, agentType?, hasResult }`. Lighter than `TaskGet` (returns only the routing-relevant fields). |
| `task_consume(task_id, include_transcript?)` | Consumption side — read a completed `plan` task's result in a structured way. Returns `{ id, subject, status, agentType, result, verdict?, read_at, follow_up_suggestion? }`. For Reviewer tasks it parses the 4-state verdict (`CLEAN` / `NEEDS_WORK` / `NEEDS_REDESIGN` / `NEEDS_CLARIFICATION`) from the result text and emits a verdict-tailored follow-up suggestion; for Developer tasks it returns the result verbatim. Pure read — does NOT mutate the store. The task must be `completed` and `type='plan'`; if it's still `in_progress`, use `TaskOutput(task_id, block: true)` first. Intent tasks throw `not_plan` — call `task_convert_intent` (atomic) or `task_plan_intent` (iterative) first. |

**Write side — intent → plan conversion (4):**

| Tool | Use for |
|---|---|
| `task_convert_intent(task_id, plan)` | **Atomic** one-shot converter. Reads an intent task (`type='intent'`), marks it converted (audit: `metadata.converted / metadata.converted_at / metadata.intent_shape / metadata.rationale`), and creates plan tasks from a STRUCTURED plan object (`intent_shape` + `rationale` + `phases[]`) in a single store.write. Phase → agentType is mapped deterministically via `PHASE_AGENT_TYPE` (review → Reviewer, all others → Developer). The schema + `src/phase-validation.ts` enforce per-shape rules (phase count bounds, first/last phase match, ≤ 1 review phase, rationale 10–500 chars). Refuses empty `phases`, non-intent sources, already-converted intents, and plans that violate shape rules. Use for the trivial / small / standard / multi-phase / multi-track shapes when the LLM already knows the full phase list. |
| `task_plan_intent(task_id, plan)` | **Iterative** flow, step 1: declare `intent_shape` + `rationale` on the intent. Stamps `metadata.planning = { shape, rationale, phases_added, plan_task_ids, planned_at, planned_by }`. The intent stays `pending` (no plan tasks created). Re-classification requires a fresh intent. Use this BEFORE `task_add_phase` so the declared shape drives per-add cumulative validation. |
| `task_add_phase(intent_id, phase)` | **Iterative** flow, step 2: materialize ONE plan task per call against a planned intent. Validates the running cumulative phase list against the declared shape via `validateCumulativePhases` (catches cap-busting, wrong first phase, trivial-with-review, multiple reviews, multi-track not all-implement). Stamps `metadata.source_intent / phase / agentType / cumulative_phase_count` on the new plan task. Appends to the intent's `planning.plan_task_ids` and increments `planning.phases_added`. Call once per phase in the plan. The intent stays `pending` until `task_close_intent` runs. |
| `task_close_intent(intent_id)` | **Iterative** flow, step 3 (terminal): flip the intent to `completed` and stamp the final audit metadata (`converted / converted_at / converted_by / plan_task_ids`). Synthesizes a PlanShape from the accumulated phases + the original rationale and runs `validatePlanShape` to catch final-state issues (last-phase mismatch, min-count, ≥ 1 implement for investigate-then-fix, etc.). Once closed, the intent is terminal — no more adds, no re-close. |

The planning methodology the LLM uses to produce a structured plan from
an intent subject + description lives in §4 of this file (5-step loop:
Read → Classify → Compose rationale → Decompose phases → Surface &
commit); §5 is the quick reference for the shapes. Apply that loop every
time a new intent task arrives on the board. For ambiguous intents, run
`/brainstorm` first (see
[`skills/brainstorming/SKILL.md`](../brainstorming/SKILL.md)).

### 6.7 Subagents (shipped defaults)

Only two agent types ship as built-in defaults in `@sages/pi-subagents`:

| Type | Role | When |
|---|---|---|
| `Developer` | TDD software developer | RED → GREEN → REFACTOR with evidence (background, isolated worktree) |
| `Reviewer` | code reviewer | reads the Developer's `metadata.result`, emits the 4-state verdict (CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION) (background, read-only) |

Every other agent type (`Explore`, `PlanCompiler`, `Merger`, and so on)
is **user-defined**: a template at `~/.pi/agent/agents/*.md` or
`.pi/agents/*.md`. The script-based workflow runtime
(`pi-subagents/src/workflow/`) resolves those names from the registry and
spawns them (`pi-subagents/src/workflow/host.ts:197`); it does not define
new agent types. None of them are part of the orchestrator's standard
dispatch surface.

Running `Developer` / `Reviewer` in the background is a **prompt
convention**, not a runtime guarantee: the runtime resolves
`run_in_background` from the agent config, the call parameters and the
global default, and a caller that asks for the foreground is honoured
even for those two types.

## 7. Decision Recipes

| Need | Reach for |
|---|---|
| Read code | `aft_outline` → `aft_zoom`. Fallback `read` when you know the path. |
| Find something | `aft_search` — the single best code-search primitive. |
| Edit | Surgical → `edit`. Structural / cross-file → `aft_refactor`. New file → `write`. |
| Verify | `aft_inspect` (TS / lint) · `bun test` (unit) · `npm run check` (where applicable) |
| Standard Implement → Review pipeline (>2 items) | `TaskCreate × 2` + `TaskExecute`, or `task_convert_intent` (atomic) / `task_plan_intent` + `task_add_phase` + `task_close_intent` (iterative) |
| Custom multi-step workflow (>2 items) | `TaskCreate × N` + `TaskExecute` directly |
| Trivial change (≤2 items) | direct `edit` / `write` / `bash` |
| Subagent off-track | `get_subagent_result` (poll) → `steer_subagent` (inject a message) |
| See live task progress | `TaskList` (filters by status) |

## 8. Commit Conventions

Conventional Commits: `<type>(<scope>): <description>` (lowercase,
imperative, no trailing period). Allowed types: `feat`, `fix`, `docs`,
`refactor`, `test`, `perf`, `chore`, `style`. Body wraps at 72 chars.
Footer: `Refs: <goal-id>`.

- **Never `git add` paths under `.pi/`.** Subagents must not include any `.pi/` file in commits. Main agent verifies `git diff origin/main..HEAD --name-only` excludes `.pi/` before merge.
- Author is `git config user.{name,email}`. Never `--author`, never `GIT_AUTHOR_*` env overrides.

> Full rules (format spec, 8 types table, author derivation script, examples, forbidden-author list, why-it-matters) live in
> `pi-subagents/src/agent-prompts/_sections/commit-conventions.ts` —
> single source of truth, byte-identically interpolated into the `Developer`
> and `Reviewer` system prompts (`pi-subagents/src/default-agents.ts:33`,
> `:47`; pinned by `pi-subagents/test/commit-conventions-section.test.ts`).

## 9. Soft Mode

> Nothing is mechanically blocked.
> Pick the path that matches the work shape.
> If the active task list has >2 items, the soft-mode reminder fires once
> at the first side-effecting call. It's a recommendation, not a rule.

Soft mode is the only mode — there is no hard-mode toggle, no escape
hatch, and no path gate. The routing rule the reminder refers to (the
active task-list threshold that decides between direct handling and the
pi-tasks workflow) is stated in the always-on policy,
`templates/SYSTEM.md`; §3–§6 of this file are how you carry it out.

The reminder that fires once per session is goal-orientation: it nudges
back toward staying aligned with the goal. It does not flag a specific
write action as "production code", and it never blocks a call.

# Design: Orchestrator prompt refactor — a layered operating policy

> **Status**: design, not implemented. Awaiting approval before any prompt text is written.
> **Date**: 2026-10-26
> **Scope**: `pi-orchestrator/templates/SYSTEM.md`, `pi-orchestrator/templates/agent-tool-description.md`, `pi-orchestrator/skills/orchestrator/SKILL.md`
> **Reference**: `~/Project/lazible-jcode/config/` — `prompt-overlay.md`, `swarm-prompt.md`, `skills/swarm-engineering/SKILL.md`

All three reference artifacts live in the **reference** repo at
`~/Project/lazible-jcode/config/`, not in this repo. Citations to them
below are written with that prefix so they are not confused with Sages
files of the same name.

---

## 1. Overview

The Sages orchestrator ships three prompt artifacts: an always-on
constitution (`templates/SYSTEM.md`), the `Agent` tool description
(`templates/agent-tool-description.md`), and an on-demand playbook
(`skills/orchestrator/SKILL.md`). They were written incrementally, over
several goal cycles, and have drifted apart from each other and from the
code they describe.

The reference config in `~/Project/lazible-jcode/config/` solves the same
problem with a clear three-tier contract:

| Reference artifact | Tier | Content |
|---|---|---|
| `~/Project/lazible-jcode/config/prompt-overlay.md` | Always-on **policy** | §1–§15 numbered operating rules. No tool manual. |
| `~/Project/lazible-jcode/config/swarm-prompt.md` | On-demand **coordination policy** | §1–§17 rules for the Coordinator. |
| `skills/swarm-engineering/SKILL.md` | On-demand **method** | §1–§18 step-by-step engineering procedure. |

The reference's structural invariant is simple and worth copying verbatim:
**each tier states its own relationship to the others, and no tier
restates another tier's rules.** The reference overlay explicitly says
"Detailed Swarm triggering… belong to the dedicated Swarm policy and
Skill" (`~/Project/lazible-jcode/config/prompt-overlay.md:66`) instead of repeating them.

This design applies that contract to the Sages prompt suite.

---

## 2. Context — what is actually wrong today

Findings below were verified against `main` at `318e18b` (2026-10-26).
P0–P5 are implemented; P6 remains.
The prompt files and the `pi-tasks` / `pi-subagents` sources are unchanged
since `f4c3487`, so the line references below still hold. File references
are `file:line`.

### 2.1 The always-on prompt carries a reference manual

`SYSTEM.md` is 21 982 bytes / 334 lines. The `## Tool Reference` section
alone (`SYSTEM.md:141`–`SYSTEM.md:300`) is ~160 lines — the AFT tool
table, the pi-tasks tool table, the pi-routines table, the
`max_turns` tier table, the orchestrator tool tables, and the subagent
roster. The reference `~/Project/lazible-jcode/config/prompt-overlay.md`
contains **no** tool manual at all; that is what the tier split is for.

### 2.2 Facts are duplicated three times and have already drifted

The `max_turns` tier table exists in three places:

| Copy | Location | Heavy-row text |
|---|---|---|
| **Canonical** — in the `TaskExecute` tool description the LLM actually reads | `pi-tasks/src/index.ts:1357`–`1361` | "Cross-package migrations, multi-cycle TDD with retries, parallel cascading" |
| `SYSTEM.md` | `SYSTEM.md:230`–`232` | "…parallel tracks that cascade through several `TaskExecute` rounds. **Use whenever a Standard run has historically come up short.**" |
| `SKILL.md` | `skills/orchestrator/SKILL.md:57`–`59` | same as SYSTEM.md |

The canonical copy is the one the model reads at dispatch time. The two
prompt copies have already diverged from it **in prose**: the tier
*values* (`480` / `960` / `1280`) and the default tier ("pick Standard
by default") still agree with the canonical, but the Light row in both
prompt copies adds "Default for Reviewer and short Implement
subagents", a claim the canonical does not make, and the canonical
states the abort trigger as `lastError: "aborted"` while `SKILL.md`
drops that token. The same duplication applies to the todowrite-first
flow, the phase → agentType mapping, and the verdict semantics.

### 2.3 The prompts contradict the code

- **Tool count.** `SYSTEM.md:273` says `**Read side (3):**` but the table
  beneath it lists two tools (`task_inspect`, `task_consume`). The
  section header says "6 tools" while 3 + 4 = 7. The real count is 6 —
  `pi-orchestrator/src/orchestrator-tool.ts` registers `task_inspect`,
  `task_consume`, `task_convert_intent`, `task_plan_intent`,
  `task_add_phase`, `task_close_intent`. The root `AGENTS.md` is correct
  ("two read-side and four intent→plan conversion tools"); `SYSTEM.md` is
  the outlier.
- **The turn ceiling is stated as a constant, but it is configurable.**
  `SYSTEM.md:221`–`224` says the ceiling is "the runtime's `graceTurns`"
  and is "a **hard ceiling at `tier + 5`**". The mechanism is real:
  `pi-subagents/src/agent-runner.ts:1059` steers the session at
  `turnCount >= maxTurns` ("You have reached your turn limit. Wrap up
  immediately — provide your final answer now.") and `:1062` aborts at
  `turnCount >= maxTurns + graceTurns`. But `graceTurns` is a **user
  setting** — default 5 (`agent-runner.ts:353`), overridable via
  `~/.pi/agent/settings.json` (`pi-subagents/src/settings.ts:41`, `:519`).
  With `graceTurns: 10` the ceiling is `tier + 10`, so "`tier + 5`" is a
  default-flavoured constant presented as invariant. The same
  simplification is baked into the canonical `TaskExecute` description
  (`pi-tasks/src/index.ts:1354`) — a pre-existing, separate issue.
- **Task reversion is accurate.** The claim that an aborted task "reverts
  to `pending` with `lastError: \"aborted\"`" *is* implemented
  (`pi-tasks/src/index.ts:401`, `:427`) and needs no change.
- **The tool-surface summary is wrong.** `SYSTEM.md:49`–`53` claims "5
  categories — file/network (~6), bash (5), AFT (11), pi-tasks (7), Sages
  orchestrator (6) + subagent control (4) ≈ **32 tools**". The prompt's
  own breakdown does not even sum to its stated total (6+5+11+7+6+4 = 39,
  not 32). The real `setActiveTools` allowlist
  (`pi-orchestrator/src/extension.ts`, `session_start`) is **44** names —
  the orchestrator's own 6 (`ORCHESTRATOR_TOOL_NAMES`) + `PI_TASKS_TOOLS` 7
  + `SUBAGENT_TOOLS` 7 (`PI_SUBAGENT_TOOLS` 3 + `SUBAGENT_CONTROL_TOOLS` 4)
  + `AFT_TOOLS` 11 + `BASELINE_TOOLS` 7 + `PI_ROUTINES_TOOLS` 6 — of which
  **40 are live**. pi silently drops names that are not in the tool
  registry, and the four `SUBAGENT_CONTROL_TOOLS` are registered nowhere
  (§2.7, T2). `PI_ROUTINES_TOOLS` is additionally conditional on
  pi-routines being installed.
- **Six advertised tools do not exist.** `SYSTEM.md:157` lists "Bash (5)
  — `bash` / `bash_status` / `bash_watch` / `bash_write` / `bash_kill`";
  `SYSTEM.md:153` lists `ast_grep_search` / `ast_grep_replace`. The host
  registers a single `bash` tool, and the allowlist's `BASELINE_TOOLS`
  is exactly `bash, read, edit, write, grep, find, ls`
  (`pi-orchestrator/src/extension.ts:82`–`90`). The `bash_*` and
  `ast_grep_*` names survive only in a stale catalogue in
  `pi-evaluator/src/metrics/tool-adoption.ts:78`–`92`.
- **The background rule is a convention, not an enforced policy.**
  `SYSTEM.md:111`–`114` and `agent-tool-description.md:64`–`75` present
  `Developer` / `Reviewer` → `run_in_background: true` as a hard rule.
  The runtime resolves it as
  `agentConfig?.runInBackground ?? params.run_in_background ?? opts?.defaultRunInBackground ?? false`
  (`pi-subagents/src/invocation-config.ts:141`), and **no shipped
  `AgentConfig` sets `runInBackground`** — neither `Developer` nor
  `Reviewer` declares it (`pi-subagents/src/default-agents.ts:24`–`52`).
  The default is the global `backgroundByDefault = true`
  (`pi-subagents/src/index.ts:1169`), so an unspecified call is
  background, but a caller passing `run_in_background: false` is honoured
  even for `Developer` / `Reviewer`. The rule lives in the prompt, not
  the runtime.
- **The dispatch table lists types that do not ship.**
  `SYSTEM.md:113` puts `Explore` / `PlanCompiler` in the foreground row.
  Neither is a built-in default — `pi-subagents/src/default-agents.ts`
  ships `Developer` and `Reviewer` only — and `AGENTS.md` classifies both
  as user-defined templates. The table states policy for types that
  usually are not present.
- **The tool description hard-codes an agent type that may not exist.**
  `agent-tool-description.md:33` instructs the model to "decide before
  calling `PlanCompiler`" and `:46` describes its contract, with no "if you
  have defined one" qualifier. The dispatch table at `:70`–`:71` then gives
  `Explore` and `PlanCompiler` a `run_in_background` value as if they were
  present. `SYSTEM.md:47` qualifies the same names correctly ("user-defined
  templates, not built-in defaults"), so the two files disagree about
  whether these types are guaranteed. A model that follows the tool
  description and dispatches `PlanCompiler` on a stock install gets an
  unregistered-type error.
- **The AFT tool-priority ranking has two would-be owners.**
  `agent-tool-description.md:100`–`112` and `SYSTEM.md:141`–`300` both
  carry the "reach for the indexed tools first" ranking. They agree today,
  but the refactor would give the ranking a second home in the new
  `SYSTEM.md` §12 — the exact duplication pattern §4.6 exists to prevent.
- **The context-file list names four files that are not in the repo.**
  `SYSTEM.md:60` says to "read in priority order `README.md`, `AGENTS.md`,
  then `CLAUDE.md` / `.pi/SYSTEM.md` / `.specify/memory/constitution.md` /
  `SPEC.md`". Only `README.md` and `AGENTS.md` exist; the other four are
  absent from a stock Sages checkout, and the phrasing ("read in priority
  order") does not mark them optional. A model that follows it literally
  spends four failing reads every session. The refactor's §4.2 row 4 must
  restore the "if present" semantics.

### 2.4 The `Agent` tool description mixes upstream text with policy

`templates/agent-tool-description.md` is a fork of
`@tintinweb/pi-subagents/examples/agent-tool-description.md` with sage
policy interleaved: the `### Orchestration dashboard — use todowrite`
section (`:77`) and the managed-worktree paragraph (`:95`) are orchestrator
policy wearing a tool description's clothes. The file's own header
(`:1`–`:22`) documents the fork but not which parts are sage policy.

Note the deliberate omission that must be preserved: pi-subagents offers a
`{{isolationGuideline}}` template variable
(`pi-subagents/src/index.ts:1464`), but its generated text recommends
`isolation: "worktree"` — which the Sages red lines forbid
(`AGENTS.md` § Red lines 2). The hardcoded managed-worktree paragraph is
therefore intentional and must not be replaced by the variable.

### 2.5 The orchestrator has no verification discipline of its own

The reference overlay devotes §5 (Evidence and Truthfulness), §6
(Independent Verification), §9 (Testing and Validation), §12 (Handling
Uncertainty), §13 (Integration and Completion), §14 (Communication and
Reporting) and §15 (Policy Precedence) to how the agent verifies its own
work. Sages has the *Reviewer's* 4-state verdict, but nothing that says
a verdict is an **input**, not proof — or that the orchestrator must
confirm the diff itself before declaring work done. The takeover contract
(`AGENTS.md` § "Orchestrator manual takeover") lives only in the repo
doc, never in the always-on prompt.

### 2.6 Two subagent tool families — only one of them is real

`agent-tool-description.md` mentions two unrelated tool families, which
reads like an inconsistency but is not:

| Family | Names | Owner | Live? |
|---|---|---|---|
| Upstream result/steer | `get_subagent_result`, `steer_subagent` | `SUBAGENT_TOOL_NAMES` in `pi-subagents/src/agent-runner.ts:40`–`45`; in the orchestrator's `PI_SUBAGENT_TOOLS` (`extension.ts:47`–`51`) | **Yes** — 241 successful calls in the transcript corpus |
| Sages control (GC-2026-073) | `subagent_status`, `subagent_steer`, `subagent_abort`, `subagent_resume` | `SUBAGENT_CONTROL_TOOLS` in `pi-orchestrator/src/extension.ts:62`–`67` | **No** — the implementation was deleted in `a36ae68` (§2.7, T2) |

`agent-tool-description.md:75` and `:89` use the first family; `:110`–
`119` document the second. The upstream family is real and must not be
"normalised" away. The Sages control family is **not** — the file
documents four tools that no runtime registers, so the refactor must drop
that block (D7).

### 2.7 The tool surface had drifted in four independent directions

Validating the design against the running system surfaced four
*tool-name* drifts — a name registered in one place and consumed in
another, where the two sides have fallen out of sync. They are recorded
here because the prompt layer's job is to describe the tool surface
accurately, and it can only do that once the surface itself is settled.

| # | Defect | Impact | Status |
|---|---|---|---|
| **T1** | The orchestrator's own six consumer tools were registered but absent from the `setActiveTools` allowlist, so the model could not call them. | The orchestrator's primary interface was dead for 15 days. | **Fixed** — `a197af2` (2026-10-26). |
| **T2** | The four subagent-control names are registered nowhere; the implementation was deleted from `pi-subagents` in `a36ae68` (2026-10-11). | The prompt advertises four tools that do not exist. | Open — **D7**. |
| **T3** | `pi-evaluator` classifies orchestrator tool calls against five retired goal-contract-era names. | The evaluator's eval state never advances and its metrics mis-bucket orchestrator calls. | Open — **D8**. |
| **T4** | The `isolation` parameter's managed-worktree object form and the `"current-workspace"` value were removed from the runtime in `a36ae68`; the red lines still require them. | The red lines forbid the only working mode (`"worktree"`) and mandate two values the schema rejects. | **Fixed** in the prompt layer — see §2.8. |

#### T1 — the orchestrator's own tools were invisible (fixed)

`pi.setActiveTools(...)` **replaces** the active tool set; it is not
additive. A tool that is registered in the tool registry but missing
from the array passed to `setActiveTools` is invisible to the model, and
every call to it returns `Tool <name> not found`.

The timeline is exact:

| Date | Commit | What happened |
|---|---|---|
| 2026-10-11 | `dbf53aa` | "remove goal contract tool + storage cascade" retired `goal_contract_create` and, in the same edit, deleted the `...ORCHESTRATOR_TOOLS` spread from the allowlist. The allowlist lost its only self-reference. |
| 2026-10-11 | `a36ae68` | (T2) `pi-subagents/src/subagent-control-tools.ts` (deleted in this commit) and its test removed in the upstream sync. |
| 2026-10-12 | `c68aeff`, `2aaafdd` | `task_consume` + `task_convert_intent`, then `task_inspect`, added to the tool registry. |
| 2026-10-15 | `473e861` | `task_plan_intent`, `task_add_phase`, `task_close_intent` added to the registry. |
| 2026-10-17 | — | The first real attempt to call one of the six: `Tool task_inspect not found`. |

Runtime evidence, measured over all **399** pi session transcripts
(2026-07-16 → 2026-10-22), counting only real `toolCall` / `toolResult`
pairs:

| Tool | Calls | Succeeded | Failed | Last success | First failure |
|---|---:|---:|---:|---|---|
| `task_inspect` | 3 | 0 | 3 | — | 2026-10-17 |
| `task_consume` | 1 | 0 | 1 | — | 2026-10-17 |
| `task_convert_intent` | 0 | 0 | 0 | — | — |
| `task_plan_intent` | 0 | 0 | 0 | — | — |
| `task_add_phase` | 0 | 0 | 0 | — | — |
| `task_close_intent` | 0 | 0 | 0 | — | — |
| `TaskList` (control) | 557 | 557 | 0 | 2026-10-20 | — |
| `TaskCreate` (control) | 153 | 153 | 0 | 2026-10-22 | — |
| `get_subagent_result` (control) | 263 | 241 | 19 | 2026-10-17 | — |

The four orchestrator failures are all the same string, `Tool <name> not
found`, and the six orchestrator tools have **zero** successful calls
across the entire corpus.

The failing session is not a broken session. In
`2026-10-17T02-44-48-869Z_01a147bf-…` the orchestrator extension was
live — the system message carries the `SYSTEM.md` constitution as its
`preamble` — and the same session ran `TaskList` × 13, `TaskCreate` × 7,
`TaskUpdate` × 15, `TaskExecute` × 5, `TaskGet` × 5, `TaskOutput` × 1
and `get_subagent_result` × 3 successfully, while `task_inspect` and
`task_consume` both failed with `Tool <name> not found`. The prompt was
loaded and the peer tools were live; only the orchestrator's own tools
were missing. That isolates the cause to the allowlist.

**The fix** (`a197af2`) exports `ORCHESTRATOR_TOOL_NAMES` from
`src/orchestrator-tool.ts` as the single source of truth for the six
names and spreads it into the allowlist.
`test/extension-active-tools.test.ts` now asserts that the registered
names and the allowlist are the same set, so the two cannot drift apart
again — the guard that was missing when `dbf53aa` broke it.

#### T2 — the subagent-control tools do not exist

`pi-subagents/src/` registers no `subagent_*` tool. The implementation
(`pi-subagents/src/subagent-control-tools.ts`, 414 lines, deleted in
`a36ae68`) and its test were deleted by `a36ae68` (2026-10-11, "chore
sync upstream"). The orchestrator's `SUBAGENT_CONTROL_TOOLS` constant
still lists the four names, and `pi.setActiveTools` silently drops names
that are not in the registry, so the four are inert.

The corpus shows the seam exactly: `subagent_status` last succeeded on
**2026-10-08** and first failed on **2026-10-13** (3 failures, on
2026-10-13 × 2 and 2026-10-15, all `Tool subagent_status not found`) —
the 2026-10-11 deletion sits exactly in that gap. `subagent_steer` (last
success 2026-10-01), `subagent_abort` (2026-10-01) and `subagent_resume`
(2026-08-27) were simply never called again.

This is the one place where the original version of this document was
wrong: it claimed "both are real". The upstream family is real; the
Sages control family is not. The refactor must not document four tools
that do not exist.

#### T3 — pi-evaluator classifies against retired names

Five files in `pi-evaluator` match tool calls against the retired
goal-contract-era names:

| File | Set | Names |
|---|---|---|
| `pi-evaluator/src/extension.ts:37` | `ORCHESTRATOR_TOOL_NAMES` | `goal_contract_create`, `dag_synthesize`, `task_dispatch`, `orchestrator_audit` |
| `pi-evaluator/src/metrics/tool-adoption.ts:68` | `ORCHESTRATOR_TOOLS` | the four above + `sages_reminder`, `todowrite_compile`, `todowrite_progress` |
| `pi-evaluator/src/metrics/tool-correctness.ts:43` | `_ORCHESTRATOR_TOOLS` | the four above |
| `pi-evaluator/src/metrics/tool-correctness-internals.ts:10` | `ORCHESTRATOR_TOOLS` | the four above |
| `pi-evaluator/src/metrics/step-efficiency.ts:22` | `ORCHESTRATOR_TOOLS` | the four above |

None of the current six orchestrator tool names appears in any of them,
so `pi-evaluator/src/extension.ts:129`
(`if (!ORCHESTRATOR_TOOL_NAMES.has(toolName)) return;`) discards every
orchestrator tool call and the eval state never advances.

This is **not** in `pi-orchestrator`, and it is not a mechanical fix: the
retired tools carried a `goal_id` / `dag_id` field while the current six
carry `task_id`, so deciding what the evaluator should track is a product
decision. It is recorded as **D8** rather than patched here.

### 2.8 The red lines mandate an isolation API that does not exist

Found while implementing P2, and larger in blast radius than T2: the
red lines do not merely advertise a missing tool, they **forbid the one
mode that works** and mandate two values the schema rejects.

**What the runtime accepts.** The `Agent` tool's `isolation` parameter is
a two-value union (`pi-subagents/src/invocation-config.ts:28`–`35`):

```ts
isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], { ... }),
),
```

There is **no** object form and **no** `"current-workspace"` value.

**What was removed.** `a36ae68` (2026-10-11, "chore sync upstream")
dropped the Sages-specific `worktree-contract/lease/ownership` subtree —
the managed-worktree domain added in `b5330e5` / `0d92b3a` /
`8476c32` ("feat(pi-subagents): add managed-worktree domain for
orchestrator DAGs", GC-2026-008). Repository-wide search confirms the
removal is complete: no `releaseManagedWorktree`, `leaseToken`,
`managedWorktree` or `worktree_id` symbol exists in any `.ts` file, and
`pi-tasks` never reads a metadata `isolation` field, so the
`TaskExecute` → `Agent` path cannot translate one either.

**What the prose said.** The root `AGENTS.md` red lines and the pre-refactor
`SYSTEM.md` / `agent-tool-description.md` all said:

> Never use `isolation: "worktree"`. Use the explicit managed-worktree
> object or `"current-workspace"`.

Every clause of that sentence is wrong against the runtime: `"worktree"`
is the only isolation the schema offers, and neither the object form nor
`"current-workspace"` is a valid value. The repo's own
`pi/docs/learn/pi-orchestrator.md` had already flagged the drift
("Documentation drift: project `AGENTS.md` documents an isolation object
form … the object form never existed in the runtime") — the flag was
correct, and nothing acted on it.

**Resolution.** The prompt layer states the real contract (P2 §7, red
lines 2–3). The repository's `AGENTS.md` red lines are corrected in P5,
which also fixes the other four places in `AGENTS.md` that repeated the
removed API (the dispatch principles, the subagent-type table, the
soft-mode recommendation and the manual-takeover commit instruction) and
re-points the "complete invocation contract" sentence at the three
prompt tiers instead of one file.

**The verified contract**, for the record:

| Fact | Evidence |
|---|---|
| The only accepted values are `"off"` and `"worktree"`. | `pi-subagents/src/invocation-config.ts:28`–`35` |
| `"worktree"` creates a **detached** worktree at `HEAD`, so the agent cannot see uncommitted or staged changes in the main checkout. | `pi-subagents/src/worktree.ts:106`–`113` (`git worktree add --detach <path> HEAD`) |
| On completion the agent's changes are committed to a branch named in the result; the worktree is removed and the branch persists. | `pi-subagents/src/worktree.ts:125`–`174` |
| `"worktree"` requires a git repository with at least one commit and fails loudly otherwise — no silent fallback to the main tree. | `pi-subagents/src/agent-manager.ts:712`–`719` |
| The parameter is dropped from the schema entirely when the project sets `worktreeIsolation: false`; the default is enabled. | `pi-subagents/src/invocation-config.ts:37`–`55`, `pi-subagents/src/worktree.ts:45` |

### 2.9 The pre-commit hook the repo documents does not exist

Found while executing P6, which is the phase that was supposed to run the
hook. `bc7c002` (2026-10-20, "chore: remove the pre-commit about
pr-orchestrator only") deleted `.husky/pre-commit` and nothing replaced
it.

**What the repo still claims.** Root `AGENTS.md` § "Verify gates" says:

> The pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`) is
> the only gate that runs automatically; it must pass before every
> commit.

and red line 8 forbids `--no-verify` because "repository hooks must
run". Both scripts it names are still in the root `package.json`.

**Why nothing runs.** Husky's generated shim `.husky/_/pre-commit`
dispatches through `.husky/_/h`, whose third line is
`[ ! -f "$s" ] && exit 0` — with no `.husky/pre-commit` present, the
shim exits successfully without doing anything. The shim exists
(husky creates it for every hook name); the user hook it points at does
not. No other mechanism is configured: there is no `lefthook.yml`, no
`.pre-commit-config.yaml`, and `core.hooksPath` is `.husky/_`.

**Impact.** Every commit since 2026-10-20 has run ungated, including
the P1–P5 commits of this work. The suites were run by hand at each
phase and are green, but the *automatic* guarantee the repo documents
was silently absent.

**Resolution.** `.husky/pre-commit` is restored with the content from
`bc7c002^` (the `git rev-parse --show-toplevel` form that works in a
managed worktree) plus a comment recording why it was reinstated. The
hook now runs `bun run orchestrator:typecheck` and
`bun run orchestrator:test`, both of which pass on the current tree.

---

## 3. Goals and non-goals

### Goals

1. **One tier, one job.** The always-on prompt states policy; the
   on-demand skill states method and manual; the tool description states
   how to use one tool.
2. **One owner per fact.** Every duplicated fact gets exactly one owner
   in the codebase, and the prompts point at it instead of restating it.
3. **Drift becomes a test failure, not a code-review accident.**
4. **Numbered, cross-referenced sections**, matching the reference's
   editorial style.
5. **Close the discipline gap** — evidence, verification, takeover,
   reporting, precedence.

### Non-goals

- No change to the runtime: no new tools, no changed tool semantics, no
  changed `phase-validation.ts` rules, no changed dispatch behaviour.
  *One exception, already made and already committed:* the T1 allowlist
  fix in `a197af2` (§2.7), which was a precondition for describing the
  tool surface truthfully. It changes no tool's behaviour — it makes six
  already-registered tools reachable.
- No change to `pi-tasks`, `pi-subagents`, or `pi-sidebar`.
- No rewrite of `skills/brainstorming/SKILL.md` (different concern: design
  clarification, and the reference's `skills/` dir likewise holds a
  single skill).
- No change to the root `AGENTS.md` beyond reconciling the tool-count
  sentence and adding a pointer to the new prompt tier map.

---

## 4. Design

### 4.1 The layer contract

Adopt the reference's rule: **the always-on tier carries policy and
pointers; the manual lives one tier down.**

```
┌─ ALWAYS ON ──────────────────────────────────────────────────────┐
│ templates/SYSTEM.md                                             │
│   "Sages Orchestrator Operating Policy"  §1–§16               │
│   Rules the orchestrator obeys. No tool tables. No shape        │
│   catalogs. Points down to the skill for detail.                │
└───────────────────────────┬───────────────────────────────────────┘
                            │ pointer (§1 tier map)
                            ▼
┌─ ON DEMAND (pi skill "orchestrator") ───────────────────────────┐
│ skills/orchestrator/SKILL.md                                    │
│   "Orchestrator Playbook"  §1–§9                               │
│   The procedure (inspect → plan → dispatch → consume → report)  │
│   plus the reference manual: tool tables, shape catalog,        │
│   phase→agentType map, decision recipes.                         │
└─────────────────────────────────────────────────────────────────┘

┌─ TOOL-SCOPED (pi-subagents renders this) ───────────────────────┐
│ templates/agent-tool-description.md                             │
│   The `Agent` tool description. How to call the tool.          │
│   No orchestrator policy — one-line pointers instead.           │
└─────────────────────────────────────────────────────────────────┘
```

**Why this is safe.** The on-demand tier is genuinely reachable at
runtime. `pi-orchestrator/package.json` declares
`"pi": { "skills": ["./skills"] }`, and pi's package manager resolves
package skill roots via `collectSkillEntries`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:194`),
which **recurses into subdirectories** looking for `SKILL.md`. So
`~/.pi/packages/pi-orchestrator/skills/orchestrator/SKILL.md` is
discovered as the pi skill `orchestrator`. Moving the manual down one
tier does not make it unreachable.

### 4.2 New `SYSTEM.md` section map

Numbered §1–§16, matching the reference's numbered-section style. Column
three names the source of each section's content.

| § | Title | Content and source |
|---|---|---|
| 1 | Scope and Precedence | The three tiers and their relationship; the conflict order (red lines → constitution → soft-mode recommendation → user request). *New; borrowed from reference §15.* |
| 2 | Coordinator Responsibility | The orchestrator owns the end-to-end outcome. A verdict or a worker's report is an **input**, not proof. *Reference §1, §6.* |
| 3 | The Sages Boundary | Task Board / Task Orchestrator / Task Executor; single writer, single consumer; the orchestrator never manages the flow. *From `SYSTEM.md:3`–`27`.* |
| 4 | Understand Before Acting | Read the intent and its context; project context files (`README.md` / `AGENTS.md`, then `CLAUDE.md` / `.pi/SYSTEM.md` / `SPEC.md` **if present**); tool backend warmup. *From `SYSTEM.md:56`–`60`; reference §2.* |
| 5 | Choose the Simplest Effective Strategy | The >2-item threshold; direct handling vs. dispatch; **reassess parallelism during execution** when new evidence changes the shape. *From `SYSTEM.md:62`–`68`; reference §3 + "Reassess Parallelism During Execution".* |
| 6 | Plan and Define Acceptance Criteria | The todowrite-first flow condensed to the rule + the 6-step block; per-phase **What / Where / Acceptance / Evidence**. *From `SYSTEM.md:70`–`96`; reference §4.* |
| 7 | Dispatch, Isolation, and Ownership | Meta-file vs. production routing; the **verified** `isolation` contract (`"off"` \| `"worktree"` — never an object form, never `"current-workspace"`; §2.8); parallel vs. serial; the `.pi/orchestrator/` namespace rule. *From `SYSTEM.md:98`–`139`; reference §9.* |
| 8 | Evidence and Truthfulness | Verified fact vs. inference vs. hypothesis; a subagent's report describes intent, not necessarily outcome. *Reference §5.* |
| 9 | Independent Verification | The Reviewer certifies; the orchestrator confirms. Inspect the diff, run the checks. *Reference §6.* |
| 10 | Diagnose Before Repairing and Takeover | The 8-step diagnose loop; the takeover contract (tool-not-found 400, checkpoint stall, `BLOCKED`). *Reference §8; `AGENTS.md` § "Orchestrator manual takeover".* |
| 11 | Testing and Validation | The two gates; Passed / Failed / Not run / Blocked / Inconclusive. *Reference §9; `AGENTS.md` § "Verify gates".* |
| 12 | Tool Use and Priority | Cheapest tool that solves the problem; the AFT-over-bash ranking as a **pointer** to the `Agent` tool description (its owner — §4.6); the allowlist summary (44 names, 40 live). *Reference §11; condensed from `SYSTEM.md:141`–`300`.* |
| 13 | Handling Uncertainty and Blockers | State what is known, what is missing, what is the next smallest useful step. *Reference §12.* |
| 14 | Integration and Completion | Integrate, verify the whole, do not claim completion from partial attempts. *Reference §13.* |
| 15 | Communication and Reporting | The final-report shape: what changed / why / verified / failed or not run / follow-up. *Reference §14.* |
| 16 | Red Lines | The 9 hard prohibitions from `AGENTS.md` § Red lines. *Promoted into the always-on prompt.* |

Target size: **~13 KB** (from 22 KB). The always-on prompt shrinks ~40%
while gaining the seven missing disciplines.

**Measured (P2–P4, 2026-10-26): 18,535 bytes / 365 lines** — the target was
not met, and the design records the measured number rather than the
target. The gap is §7: the corrected isolation contract (§2.8) needs
~350 bytes more than the deleted managed-worktree paragraph, and §12
must state the allowlist composition (44 names / 40 live) that the
original target had planned to compress to one line. Every section in
the map above is present and none is padded, so the excess is content
the map mandates. The trade is deliberate: a 15% smaller always-on prompt
that states a non-existent `isolation` API (T4) is worth less than a
correct one. If the size matters more than any single section, §7's
worktree-lifecycle detail and §12's per-package breakdown are the two
places to cut — not the isolation values themselves.

Measured sizes of all three artifacts, before → after:

| Artifact | Before | After | Delta |
|---|---:|---:|---:|
| `templates/SYSTEM.md` | 21,982 B / 334 L | 18,535 B / 365 L | −15.7% bytes |
| `skills/orchestrator/SKILL.md` | 20,994 B / 331 L | 33,850 B / 581 L | +61.3% bytes (absorbs the manual) |
| `templates/agent-tool-description.md` | 10,718 B / 134 L | 8,946 B / 113 L | −16.5% bytes |

The always-on prompt shrank by 16%, not the 40% the target assumed. The
prompt *suite* grew: the manual moved into the on-demand skill, so the
per-session cost dropped while the total token cost of a full workflow
stayed roughly flat. That is the intended trade — the skill is loaded
only when the orchestrator actually needs the procedure or a lookup.

### 4.3 New `SKILL.md` section map

The skill becomes the **playbook**: the procedure plus the manual.

| § | Title | Change |
|---|---|---|
| 1 | Scope and How to Use | New. States the relationship to `SYSTEM.md` (reference §"does not replace the global operating policy"). |
| 2 | What the Orchestrator Does | From `pi-orchestrator/skills/orchestrator/SKILL.md:30`–`41`, condensed. |
| 3 | The Inspect → Plan → Dispatch → Consume Loop | From `pi-orchestrator/skills/orchestrator/SKILL.md:66`–`123`; the numbered 10-step trace becomes a 4-phase loop. **Keep "The LLM's responsibility" as §3's lead subsection** — its content is the framing for the loop, and dropping the heading loses the framing. |
| 4 | Planning Methodology — From Intent to Structured Plan | From `pi-orchestrator/skills/orchestrator/SKILL.md:125`–`230`; keeps the 5-step loop and the `/brainstorm` branch. The `#### 1.`–`#### 5.` headings and the `### When to \`/brainstorm\` instead` sub-heading stay **verbatim** (see §4.8). |
| 5 | Designing the Plan — Quick Reference | From `pi-orchestrator/skills/orchestrator/SKILL.md:232`–`324`; the shape catalog, `PHASE_AGENT_TYPE`, worked example, anti-patterns. The `### Anti-patterns the validation rejects` sub-heading and the `PHASE_AGENT_TYPE` table rows stay **verbatim** (see §4.8). |
| 6 | Tool Reference | **Moves in** from `SYSTEM.md:141`–`300`: file/network, bash, AFT, pi-tasks, pi-routines, orchestrator tools, subagent roster. The **subagent-control block is deleted, not moved** (D7 / T2). |
| 7 | Decision Recipes | **Moves in** from `SYSTEM.md:317`–`329`. |
| 8 | Commit Conventions | **Moves in** from `SYSTEM.md:120`–`129`; keeps the existing pointer to `pi-subagents/src/agent-prompts/_sections/commit-conventions.ts`. |
| 9 | Soft Mode | From `pi-orchestrator/skills/orchestrator/SKILL.md:326`. |
| — | Subagent `max_turns` tiers | **Deleted** — replaced by a one-line pointer to the `TaskExecute` tool description (SKILL §6 covers the dispatch mechanics). |

### 4.4 `agent-tool-description.md`

Keep: the `SAGES_TEMPLATE_V1` sentinel, the `{{typeList}}` /
`{{compactTypeList}}` / `{{agentDir}}` / `{{scheduleGuideline}}`
variables, the upstream-compatible preamble, "When not to use",
"Usage notes", "Foreground vs background", "Writing the prompt",
"Tool priority for code exploration".

Remove (it documents tools that do not exist — §2.6, §2.7 T2):

| Removed block | Reason |
|---|---|
| "Subagent control" (`:110`–`:119`) | Documents `subagent_status` / `subagent_steer` / `subagent_abort` / `subagent_resume`. The implementation was deleted from `pi-subagents` in `a36ae68` (2026-10-11); no runtime registers them. Keeping the block advertises four tools the model can never call. Conditional on **D7**. |

Two kept blocks need a **qualification**, not a move:

| Kept block | Change | Reason |
|---|---|---|
| "Planning handoff" (`:31`–`:49`) | Qualify `PlanCompiler` as user-defined — "if you have defined a `PlanCompiler` agent". | The block hard-codes a type that does not ship (§2.3); `SYSTEM.md:47` already qualifies it, the tool description does not. |
| "Tool priority for code exploration" (`:121`–`:134`) | Stays the **sole owner** of the AFT ranking; `SYSTEM.md` §12 points at it instead of restating it. | A ranking in two files is exactly the drift this refactor removes (§4.6). |

Move out (to `SYSTEM.md`, with a one-line pointer left behind):

| Moved block | New home | Reason |
|---|---|---|
| `### Orchestration dashboard — use todowrite` (`:77`–`96`) | `SYSTEM.md` §6 | Orchestrator policy, not `Agent` tool usage. |
| The managed-worktree paragraph inside the usage bullet (`:95`) | `SYSTEM.md` §7 | Same. Must **not** become `{{isolationGuideline}}` — see §2.4. |

Target size: ~8 KB (from 10.7 KB).

### 4.5 Content migration map (complete)

The line ranges in the left column refer to the **pre-refactor** files
(commit `fb8eb7c`); they are the map's provenance, not live pointers.

| Current location | New location |
|---|---|
| `SYSTEM.md:3`–`27` three packages | SYSTEM.md §3 |
| `SYSTEM.md:29`–`54` Identity | SYSTEM.md §1, §3; tool counts → §12 pointer + SKILL §6 |
| `SYSTEM.md:56`–`60` Setup | SYSTEM.md §4 |
| `SYSTEM.md:62`–`68` Soft Mode | SYSTEM.md §5 |
| `SYSTEM.md:70`–`96` Todowrite-first flow | SYSTEM.md §6 (condensed) + SKILL §3, §4 |
| `SYSTEM.md:98`–`105` Meta vs. production | SYSTEM.md §7 |
| `SYSTEM.md:107`–`114` Parallel Dispatch | SYSTEM.md §5, §7 |
| `SYSTEM.md:116`–`118` TDD | SYSTEM.md §6, §11 |
| `SYSTEM.md:120`–`129` Commit Conventions | SKILL §8 |
| `SYSTEM.md:131`–`139` `.pi/orchestrator/` ownership | SYSTEM.md §7 |
| `SYSTEM.md:141`–`300` Tool Reference | SKILL §6 (manual) + SYSTEM.md §12 (allowlist count + a pointer to the ranking's owner) |
| `SYSTEM.md:219`–`237` `max_turns` tiers | **Deleted** → pointer to `pi-tasks/src/index.ts:1357` |
| `SYSTEM.md:302`–`315` Subagents roster | SKILL §6 |
| `SYSTEM.md:317`–`329` Decision recipes | SKILL §7 |
| `SYSTEM.md:331`–`335` Workflow References | SYSTEM.md §1 + SKILL §1 |
| `agent-tool-description.md` (sentinel + template variables) | **Unchanged** (AC 3) |
| `agent-tool-description.md` (upstream preamble + `{{typeList}}`) | **Unchanged** (upstream text) |
| `agent-tool-description.md` (Planning handoff) | **Stays**, with the `PlanCompiler` qualification (§4.4) |
| `agent-tool-description.md` ("When not to use" + "Usage notes") | **Unchanged** (upstream text) |
| `agent-tool-description.md` (Foreground vs background) | **Stays** (tool-scoped); the "sages override" framing gets the convention-vs-enforced note (§2.3) |
| `agent-tool-description.md` ("Writing the prompt") | **Stays** (upstream method text) |
| `agent-tool-description.md` (Subagent control) | **Removed** — documents four unregistered tools (§2.6, §2.7 T2); conditional on D7 |
| `agent-tool-description.md` (Tool priority) | **Stays** — sole owner of the AFT ranking; `SYSTEM.md` §12 points here |
| `agent-tool-description.md` (todowrite dashboard) | SYSTEM.md §6 |
| `agent-tool-description.md` (managed worktree) | SYSTEM.md §7 — and the isolation contract itself is corrected there (§2.8) |
| `SKILL.md` (all) | SKILL §§1–9 (renumbered, manual merged in) |

### 4.6 Single owner per fact

| Fact | Owner | How the prompts refer to it |
|---|---|---|
| Orchestrator tool names + count (6) | `pi-orchestrator/src/orchestrator-tool.ts` (registration site) | "the six orchestrator tools" + a test pins the count |
| `intent_shape` names and per-shape rules | `pi-orchestrator/src/phase-validation.ts` | SKILL §5 table (human-readable) + a test pins the name set |
| `phase` → `agentType` map | `PHASE_AGENT_TYPE` in `pi-orchestrator/src/orchestrator-tool.ts:69` | SKILL §5 table + a test pins the mapping |
| `max_turns` tiers (Light / Standard / Heavy) | `pi-tasks/src/index.ts:1357`–`1361` (`TaskExecute` description — the copy the model reads) | One-line pointer; **not restated anywhere** in the prompt suite |
| Foreground/background default | `pi-subagents/src/index.ts:1169` (`backgroundByDefault = true`) + `pi-subagents/src/invocation-config.ts:141` (resolution chain) | agent-tool-description table; the per-type rule is a **prompt convention**, not runtime-enforced — the prompt should say so rather than assert a guarantee |
| Active tool allowlist | `pi-orchestrator/src/extension.ts` (`setActiveTools` composition at `session_start`) + `ORCHESTRATOR_TOOL_NAMES` in `src/orchestrator-tool.ts` | "44 allowlisted names, 40 live" — the count is stated once and pinned by `extension-active-tools.test.ts` |
| Shipped subagent types | `pi-subagents/src/default-agents.ts` | "Developer / Reviewer" |
| Shipped vs. user-defined agent types | `pi-subagents/src/default-agents.ts` (built-ins) + `AGENTS.md` § "The shipped subagent types" (the user-defined rule) | "Developer / Reviewer ship; other names are user-defined templates" — never stated as guaranteed |
| AFT tool-priority ranking | `pi-orchestrator/templates/agent-tool-description.md:100`–`112` | The `Agent` tool description owns the ranking; `SYSTEM.md` §12 points at it and does not restate it |
| Commit conventions | `pi-subagents/src/agent-prompts/_sections/commit-conventions.ts` | Pointer (existing precedent, already correct) |
| Turn-ceiling runtime behaviour | `pi-subagents/src/agent-runner.ts:1059`–`1062` (steer at `maxTurns`, abort at `maxTurns + graceTurns`) + `pi-subagents/src/settings.ts` (`graceTurns`, default 5) | The `TaskExecute` description is the prompt-facing owner; the prompts point at it and do **not** restate a ceiling number |

### 4.7 Drift-prevention test (new)

`pi-orchestrator/test/prompt-consistency.test.ts` — the mechanism the
reference does not need (it is a verbatim snapshot of a live config) but
Sages does (its prompts are source files). **Created in P1** (see §8).

**How the target contract is expressed.** The design's P1 phase is
"write the test against the *target* contract; it fails on the current
prompts — that is the point". A failing test cannot be committed,
because the pre-commit gate (`orchestrator:test`) must stay green. So
the file splits the assertions in two:

- **Live** — assertions that already hold against the current prompts.
  They lock in the facts that are correct today so the refactor cannot
  break them silently: the orchestrator tool names, the `intent_shape`
  set, the `PHASE_AGENT_TYPE` table, the tier values and default tier
  against the canonical `TaskExecute` description, and the
  `agent-tool-description.md` template contract.
- **Skipped** — the target contract, one `it.skip` per assertion, each
  carrying a `// TODO(P<n>)` marker that names the phase that turns it
  on. Removing the `.skip` **is** the acceptance signal for that
  phase. A final assertion audits the ledger: the number of `it.skip`
  calls and the number of `TODO(P<n>)` markers must be equal, so the
  skip list cannot become a graveyard of forgotten work.

All nine skipped assertions were verified to fail against the current
prompts, each for its intended reason — none of them is vacuous.

1. **Tool count** — parse the tool names registered in
   `src/orchestrator-tool.ts`; assert the set equals the set named in
   `SYSTEM.md` and `SKILL.md`, and that the stated count matches.
2. **Shape names** — parse `src/phase-validation.ts`; assert every
   `intent_shape` appears in SKILL §5.
3. **Phase → agentType** — parse `PHASE_AGENT_TYPE`; assert SKILL §5's
   table matches it row for row.
4. **No hardcoded turn ceiling.** assert no prompt file contains
   `tier + 5`, `max_turns + 5`, or the literal `480` / `960` / `1280`,
   and that a pointer to the `TaskExecute` description exists in their
   place. The ceiling is `max_turns + graceTurns` with `graceTurns`
   user-configurable (`pi-subagents/src/settings.ts`) — no prompt should
   freeze the default into an invariant.
5. **Numbering** — assert the `## N.` headings in `SYSTEM.md`,
   `SKILL.md` and `agent-tool-description.md` form a contiguous
   `1..N` sequence with no gaps or duplicates.
6. **Tier separation** — assert `SYSTEM.md` contains no per-tool table
   rows (the `### 1. File / network` style blocks) — i.e. the manual
   really did move out.
7. **Tool allowlist count** — assert the number stated in `SYSTEM.md`
   matches the composed allowlist in `src/extension.ts` (44 names), and
   that the live subset (40) is stated correctly too. The composition is
   imported from the source, not re-derived in the test.
8. **No phantom tool names** — collect every backticked identifier that
   looks like a tool name from the three prompt files and assert each one
   is either in the allowlist, in the orchestrator-owned set, or in
   `SUBAGENT_TOOL_NAMES`. This is the check that catches `bash_status`,
   `bash_watch`, `bash_write`, `bash_kill`, `ast_grep_search`, and
   `ast_grep_replace` — six names that no runtime registers — and, after
   D7, the four `subagent_*` control names.

### 4.8 Existing test impact

`pi-orchestrator/test/skills-orchestrator-decomposition.test.ts` has 10
`it()` blocks; **3 hard-break** under the new numbering, **2 are
conditional**, and 5 survive untouched. The break is caused by the
§4.3 heading renames (Title Case) and by `## The LLM's responsibility`
being folded into §3, not by any loss of content.

| Test assertion | Fate | Action |
|---|---|---|
| `:38` `includes the 'Designing the plan — quick reference' heading` | **Breaks** — the regex is anchored (`/^##\s+Designing the plan — quick reference$/m`) and §4.3 renames it to "Designing the Plan — Quick Reference" | Re-point at the new heading. |
| `:101` `section sits AFTER 'The LLM's responsibility' and BEFORE 'Soft mode'` | **Breaks twice** — `## The LLM's responsibility` no longer exists (its content is §3's lead subsection), and `## Soft mode` becomes `## Soft Mode` | Restate the *semantic* ordering invariant against the new headings: the responsibility framing (§3) precedes the plan reference (§5), which precedes Soft Mode (§9). |
| `:113` `includes the 'Planning methodology — from intent to structured plan' section with all 5 steps` | **Breaks** — anchored regex, §4.3 renames it to "Planning Methodology — From Intent to Structured Plan" | Re-point at the new heading. The `#### 1.`–`#### 5.` step regexes inside it are *not* anchored and survive as-is — but the `### When to \`/brainstorm\` instead` regex is **anchored**, so that `###` sub-heading must stay verbatim. |
| `:92` `flags the validation-rejected anti-patterns explicitly` | **Conditional** — passes only if `### Anti-patterns the validation rejects` survives byte-for-byte | Keep that `###` sub-heading text verbatim inside §5. |
| `:57` `contains the PHASE_AGENT_TYPE table mapping every phase` | **Conditional** — the row regex `` /`?review`?\s*\|\s*`?Reviewer`?/ `` needs the table row format preserved | Move the table verbatim; do not reformat the cells. |
| `:33`, `:43`, `:68`, `:79`, `:87` | **Survive** | No change needed. |

The test's own docstring states it pins "only the structural shape of the
reference … they do NOT pin exact prose" — but the heading assertions
*are* exact-prose pins. The update should therefore keep the **content**
assertions (six shape names, `PHASE_AGENT_TYPE` mapping, worked example,
anti-pattern list, source-of-truth pointer, 5-step loop, `/brainstorm`
branch) and re-express only the three heading/ordering pins against the
new structure. Relaxing the ordering assertion to "the plan reference
still precedes Soft Mode" would lose a real invariant — the plan
reference must not sit above the framing that explains when to use it.

`pi-orchestrator/test/smoke/gc-2026-073.test.ts:171` reads
`templates/SYSTEM.md`, asserts the template exists, and asserts the
prepended prompt still matches `/orchestrator|Soft mode|workflow/i`. It
is **not** fully content-agnostic — the new `SYSTEM.md` must retain at
least one of those three tokens. The proposed title ("Sages Orchestrator
Operating Policy") and §5 ("Soft Mode") satisfy it, but the constraint
has to be respected deliberately rather than assumed away.

`pi-orchestrator/test/extension-active-tools.test.ts` was **updated in the
T1 fix** (`a197af2`), not by the prompt refactor: the allowlist grew from
38 names to 44, and the file previously asserted that the orchestrator's
own tools were *absent* — it encoded the bug. It now asserts that the
registered names and the allowlist are the same set, and that the total is
44 with no duplicates. No further change is expected from the refactor,
but the new `prompt-consistency.test.ts` must not duplicate these
assertions.

`pi-orchestrator/test/smoke/gc-2026-073.test.ts:133`–`:136` asserts the
allowlist **contains** the four `subagent_*` control names. That
assertion encodes T2 and must be inverted or removed when D7 resolves as
"retire the capability" (the names stay in the allowlist, so the test can
keep passing, but it must stop being read as proof that the tools exist).

**The `pi-subagents` suite is already red — P4 must not lean on it.**
`bunx vitest run` in `pi-subagents/` reports **94 failing tests across
15 files** (`agent-manager`, `agent-manager-gc`, `agent-mention-provider`,
`agent-mention-wiring`, `agent-runner`, `agent-types`,
`background-resume-wiring`, `manager-registry-guard`,
`mention-start-notification`, `mention`, `prompts`,
`tool-description-mode`, `workflow-examples`, `workflow-render`,
`workflow-runtime`). This is **pre-existing and unrelated** to the
prompt refactor: none of those files is touched by any phase of this
work, and the failures are stale expectations left over from the fork —
the tests still expect upstream's `examples/agent-tool-description.md`
(the directory does not exist in this repo) and upstream's
`general-purpose` / `Explore` agent types (the shipped types are
`Developer` / `Reviewer`, `pi-subagents/src/default-agents.ts:24`, `:39`).

The one that matters for this refactor is `tool-description-mode.test.ts`
— it is the suite that would otherwise verify the template rendering P4
touches, and it fails with `ENOENT` on the missing examples file. So
P4's gate is `pi-orchestrator`-local: the new
`prompt-consistency.test.ts` template-contract assertion, the
`gc-2026-073` smoke test, and a manual `install.sh --system-only` render
into a sandbox `AGENT_DIR`. Repairing the `pi-subagents` suite is a
separate workstream in a separate package and is **not** in scope here.

---

## 5. Acceptance criteria

1. `SYSTEM.md` is numbered §1–§16 contiguously, contains no per-tool
   reference tables, and contains no `480` / `960` / `1280` and no
   hardcoded `tier + 5` ceiling claim.
2. `SKILL.md` is numbered §1–§9 contiguously and contains the tool
   reference, the shape catalog, the `PHASE_AGENT_TYPE` table, the
   worked example, the anti-patterns, and the decision recipes.
3. `agent-tool-description.md` retains the `SAGES_TEMPLATE_V1` sentinel
   and all four template variables it uses (`{{typeList}}` /
   `{{compactTypeList}}` / `{{agentDir}}` / `{{scheduleGuideline}}`),
   and still does **not** use `{{isolationGuideline}}` (§2.4); the
   todowrite-dashboard and managed-worktree blocks are gone from it and
   present in `SYSTEM.md`; the `PlanCompiler` reference is qualified as
   user-defined.
4. Every fact in §4.6 appears in exactly one prompt file, and the
   remaining references are pointers.
5. `bun test ./test` passes in `pi-orchestrator/` with the new
   `prompt-consistency.test.ts` and the updated
   `skills-orchestrator-decomposition.test.ts`.
6. `bun run typecheck` passes in `pi-orchestrator/`.
7. The pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`)
   passes.
8. `install.sh --system-only` installs the new `SYSTEM.md` unchanged
   (byte-identical to the template).
9. Root `AGENTS.md` § "Key paths" points at the new tier map and its
   tool-count sentence matches the runtime.
10. No prompt file names a tool the runtime does not register — the six
    phantom names from §2.3 and the four subagent-control names from
    §2.6 are gone — and every stated tool count matches
    `pi-orchestrator/src/extension.ts` (44 allowlisted, 40 live).
11. The four `subagent_*` control names appear nowhere in the three
    prompt files, and `agent-tool-description.md` no longer carries a
    "Subagent control" block (D7 resolved as "retire").

---

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `SYSTEM.md` is prepended on **every** agent start (`pi-orchestrator/src/extension.ts:205`–`218`). A malformed or truncated file breaks every session. | Keep the header sentinel; add a test that the file is non-empty and its §1–§16 sequence parses; run `install.sh --system-only` against a sandbox `AGENT_DIR` before merging. |
| R2 | Users who already installed `SYSTEM.md` will not pick up the new constitution — `install.sh:576` refuses to overwrite without `--force`. | Ship a note in the commit body and the release notes: re-run `install.sh --force` (or `--system-only --force`) to refresh the constitution. Consider relaxing the rule for a sentinel-marked file, as `agent-tool-description.md` already does (`install.sh:648`–`651`). |
| R3 | Moving policy out of the `Agent` tool description could lose it for flows that only surface that description. | Leave one-line pointers in place at both move sites. |
| R4 | The always-on prompt shrinks, but if the orchestrator never loads the `orchestrator` skill, the manual is unreachable. | Verified: the package declares `"pi": { "skills": ["./skills"] }` and pi's `collectSkillEntries` recurses into subdirectories. Add an install-time assertion that `~/.pi/packages/pi-orchestrator/skills/orchestrator/SKILL.md` exists after install. |
| R5 | Prompt changes are behavioural, not structural — a passing test suite does not prove the LLM behaves better. | The deliverable is a reviewable diff; the consistency test protects facts, not behaviour. Verify by spot-running a session with the new `SYSTEM.md` installed. |
| R6 | The reference overlay covers general agent behaviour that pi's own host prompt may already state, creating redundancy. | Accepted deliberately — the Sages orchestrator is the top-level agent in its runtime and the reference shows the discipline is high-value at ~13 KB. Revisit only if §8's "Sages-specific only" option is chosen. |

---

## 7. Open decisions

These change the shape of the work and need an answer before
implementation.

**D1 — Policy scope.**
- **(A) Policy-complete (recommended).** `SYSTEM.md` carries the general
  operating disciplines (evidence, verification, testing, reporting,
  precedence) alongside the Sages-specific ones, exactly as
  `~/Project/lazible-jcode/config/prompt-overlay.md` does. SYSTEM.md ≈ 13 KB.
- **(B) Sages-specific only.** `SYSTEM.md` keeps only the boundary,
  tools, dispatch, shapes and red lines; general discipline is assumed to
  come from the host prompt. SYSTEM.md ≈ 6 KB, but the takeover contract
  and the "verdict is an input, not proof" rule would then have no
  always-on home.

**D2 — Manual placement.**
- **(A) Merge into `SKILL.md` (recommended).** One on-demand artifact;
  the model loads it with one call.
- **(B) Separate third skill** (e.g. `skills/sages-tool-reference/SKILL.md`),
  mirroring the reference's three-artifact split more literally. Costs an
  extra discovery step; benefits from a smaller primary skill.

**D3 — `agent-tool-description.md` scope.**
- **(A) Move the two policy blocks out (recommended).** Keeps the tool
  description tool-scoped, matching the reference's discipline. While
  there, also qualify the `PlanCompiler` reference (§4.4) so the file
  stops implying a non-shipping agent type is present.
- **(B) Leave it alone.** Smaller diff, but the file keeps two kinds of
  content and the tier contract stays blurred.

**D4 — Red lines in the always-on prompt.**
- **(A) Promote all 9 into `SYSTEM.md` §16 (recommended).** They are hard
  prohibitions; they belong where the model always sees them.
- **(B) Leave them in the root `AGENTS.md` only.** Avoids duplicating the
  list, but `AGENTS.md` is not guaranteed to be in the pi system prompt.

**D5 — The turn-ceiling claim.**
- **(A) Delete the number from the prompts and point at the `TaskExecute`
  tool description (recommended).** The ceiling is
  `max_turns + graceTurns` (`pi-subagents/src/agent-runner.ts:1062`) with
  `graceTurns` user-configurable (default 5). No prompt should freeze the
  default into an invariant.
- **(B) State it accurately in the prompts** — "`max_turns + graceTurns`,
  `graceTurns` defaults to 5" — and leave the `TaskExecute` description
  as-is. Keeps the information always-on, but keeps a
  setting-dependent value in two places.

**Follow-up, out of scope:** the canonical `TaskExecute` description
(`pi-tasks/src/index.ts:1354`) also hardcodes "`max_turns + 5`". The same
inaccuracy exists there. Worth a separate issue against `pi-tasks`; this
change does not touch `pi-tasks`.

**D6 — Who owns the AFT tool-priority ranking?** (§4.4, §4.6)
- **(A) The `Agent` tool description owns it (recommended).** The ranking
  is tool-scoped — it describes the tools the `Agent` tool exposes — and
  the tool description is where the model reads tool behaviour. `SYSTEM.md`
  §12 carries the general principle ("cheapest tool that solves the
  problem") plus a one-line pointer. No duplication.
- **(B) `SYSTEM.md` §12 owns it.** The ranking is then always-on, which
  helps when the model is not reading the tool description, but it puts a
  per-tool list back into the always-on prompt and duplicates
  `agent-tool-description.md:100`–`112` unless that copy is deleted —
  which is a larger, upstream-diverging change to a file whose header
  says to keep it in sync with the upstream example.

**D7 — The four subagent-control tools.** (§2.6, §2.7 T2)
- **(A) Retire the capability (recommended).** The implementation was
  deleted upstream in `a36ae68` (2026-10-11) and nothing has replaced
  it. Drop the "Subagent control" block from
  `agent-tool-description.md`, drop the four names from the prompt layer,
  and leave `SUBAGENT_CONTROL_TOOLS` in `extension.ts` as an inert
  allowlist entry. Cheapest, honest, and reversible.
- **(B) Restore the control tools.** Re-implement
  `pi-subagents/src/subagent-control-tools.ts` (the 414-line file is in
  git history at `a36ae68^`) and re-register the four names. This is a
  feature restoration in `pi-subagents`, not a prompt change — it needs
  its own design and its own review, and the prompts would then keep the
  "Subagent control" block.

Until this is decided, the prompt layer must assume (A): the four tools
are not available.

**D8 — `pi-evaluator`'s tool-name sets.** (§2.7 T3)
- **(A) Re-point the five sets at the current six orchestrator tools
  (recommended).** `pi-evaluator/src/extension.ts:37` and the four metric
  modules would match `task_inspect` / `task_consume` /
  `task_convert_intent` / `task_plan_intent` / `task_add_phase` /
  `task_close_intent`. The workflow-id extraction needs a decision: the
  retired tools carried `goal_id` / `dag_id`, the current six carry
  `task_id`, so the evaluator's "active workflow" concept has to be
  re-grounded on the task id.
- **(B) Leave the evaluator as-is.** The evaluator keeps classifying
  against names that no longer exist, so its orchestrator metrics stay
  empty. Cheap, and it is a separate package with a separate review.
- **(C) Retire the orchestrator-specific metrics.** Delete the
  orchestrator classification entirely and let the metrics treat the
  orchestrator's tools as ordinary tool calls.

This decision is **out of scope for the prompt refactor** — it touches
`pi-evaluator`, not `pi-orchestrator` — but it is recorded here because
the same drift class produced T1, T2 and T3, and a prompt layer that
describes a tool surface the evaluator cannot see is describing a
fiction.

**Not a decision — the `PlanCompiler` qualification.** `Explore` and
`PlanCompiler` are user-defined types (`AGENTS.md` § "The shipped subagent
types"), not phantoms like the six `bash_*` / `ast_grep_*` names. The
defect is that `agent-tool-description.md` presents them as guaranteed
while `SYSTEM.md:47` correctly does not. The refactor aligns the tool
description to the already-correct wording; no user-facing capability is
removed.

---

## 8. Implementation plan

Each phase is independently reviewable and leaves the repo green.

| Phase | Work | Verification |
|---|---|---|
| **P0** | *(done — `a197af2`)* Fix the T1 allowlist regression so the orchestrator's own six tools are reachable, and add the registration ↔ allowlist lockstep test. | `bun test ./test` (310 tests) + `bun run typecheck` green in `pi-orchestrator/`. |
| **P1** | *(done)* Add `pi-orchestrator/test/prompt-consistency.test.ts` **before** the refactor, written against the *target* contract. The target assertions ship as `it.skip` blocks with `TODO(P<n>)` markers so the suite stays green; removing a `.skip` is that phase's acceptance signal. | `bun test ./test/prompt-consistency.test.ts` — 8 pass, 10 skip, 0 fail. All 10 skipped assertions were separately verified to fail against the current prompts, so none is vacuous. |
| **P2** | *(done)* Rewrite `SYSTEM.md` to §1–§16 per §4.2 + §4.5, plus the §2.8 isolation correction. | Greens four target assertions: "keeps per-tool reference tables out of SYSTEM.md", "states the allowlist size and its live subset in SYSTEM.md", "numbers SYSTEM.md's sections contiguously from 1", "does not advertise the six unregistered `bash_*` / `ast_grep_*` tools". |
| **P3** | *(done)* Restructure `SKILL.md` to §1–§9 per §4.3; move the manual in; delete the tier table. | Greens four: "states no hardcoded turn ceiling in any prompt file", "does not restate the `max_turns` tier values in any prompt file", "numbers SKILL.md's sections contiguously from 1", "SKILL.md carries the tool reference". `skills-orchestrator-decomposition.test.ts` re-points the three breaking heading/ordering pins (`:38`, `:101`, `:113`) at the new structure; the six content-pinning blocks and the three sub-assertions inside `:113` are untouched (§4.8). |
| **P4** | *(done — `3f488ae`)* Trim `agent-tool-description.md` per §4.4. | Greens two: "does not advertise the four unregistered subagent control tools", "names no unregistered tool in any prompt file". `install.sh` sentinel logic still classifies the file as ours. The gate is `pi-orchestrator`-local — the `pi-subagents` template-rendering suite is already red (§4.8), so it cannot be used as the acceptance signal. |

| **P5** | *(done)* Reconcile root `AGENTS.md` (tool count sentence, tier map pointer, isolation red lines) and `pi/docs/learn/pi-orchestrator.md`. | `bun test ./test` (329 tests) + `bun run typecheck` green in `pi-orchestrator/`. |
| **P6** | *(done)* Full verification: pre-commit hook, `install.sh --system-only` into a sandbox `AGENT_DIR`, byte-compare the installed `SYSTEM.md`. | The hook was found to be missing (§2.9) and restored; it now runs `orchestrator:typecheck` + `orchestrator:test` green. `install.sh --system-only` into a sandbox `PI_DIR` installs `agent/SYSTEM.md` byte-identical to the template (md5 `9f4c279885d88881b11e9d81ed2648a5`). The `agent-tool-description.md` install and uninstall paths both still classify the file as ours via the `SAGES_TEMPLATE_V1` sentinel, and the installed copy is byte-identical to the template. |

**Why a cross-file assertion is attributed to the LAST phase
that touches it.** Six of the ten target assertions read *all three*
prompt files, so their `TODO(P<n>)` marker cannot name the phase that
first introduces the violation — it must name the phase after which
every file is clean. The map is mechanical, and was measured against
the pre-refactor files:

| Violation class | `SYSTEM.md` | `SKILL.md` | `agent-tool-description.md` | Goes green at |
|---|---|---|---|---|
| `tier + 5` ceiling | present | present | absent | **P3** |
| `480` / `960` / `1280` tier values | present | present | absent | **P3** |
| `### N.` per-tool blocks | present | absent | absent | **P2** |
| `bash_*` / `ast_grep_*` names | present | absent | absent | **P2** |
| `subagent_*` control names | present | absent | present | **P4** |

An earlier draft of this table attributed the ceiling and tier-value
assertions to P2 and the phantom-name assertion to P3. That was wrong:
P2 rewrites `SYSTEM.md` alone, so the copies in `SKILL.md` and in the
tool description would still fail the assertion. The table above is the
corrected attribution, and `pi-orchestrator/test/prompt-consistency.test.ts`
carries the matching markers.

**The phantom-name check has two strengths.** The ten names that
actually drifted are pinned by name, so a regression on those exact
strings is caught even if the tool registry grows. Alongside it, a
prefix rule asserts that *every* backticked token in the prompt suite
which looks like a tool name — `aft_`, `ast_grep_`, `bash_`, `routine_`,
`subagent_`, `task_`, or `Task` followed by a capital — is a tool the
runtime registers. The prefix rule is what catches the *next* phantom
name, which a fixed list never would.

**Sequencing note.** P1 before P2–P4 is deliberate: the test encodes the
contract, so the rewrite is checked against the target rather than
against the previous prose.

**Gating.** P2–P4 must not begin until **D1–D6** are answered, because
each of them changes the shape of the target files. **D7** additionally
decides whether `agent-tool-description.md` keeps its "Subagent control"
block, so P4 cannot be specified without it. **D8** is out of scope for
this change and must not be bundled into it.

**Out of scope for this change** (recorded for later): the root
`AGENTS.md` still duplicates the tool surface and the dispatch rules
against `SYSTEM.md`. P5 reconciled the two factual errors this work
found in it (the "three consumer tools" sentence and the isolation red
lines — §2.8) plus four more passages that repeated the removed
isolation API; a full de-duplication of `AGENTS.md` against
`SYSTEM.md` remains a follow-up, because `AGENTS.md` is a human-facing
repo contract with a different reader.

P5 also refreshed `pi/docs/learn/pi-orchestrator.md`, which had drifted
from the source it documents: ~25 line references pointed at pre-refactor
positions (`extension.ts:177` → `:200`, `orchestrator-tool.ts:504` →
`:983`, and so on), the tool list omitted the iterative trio
(`task_plan_intent` / `task_add_phase` / `task_close_intent`), and the
discrepancy-watch entry still claimed the four `subagent_*` names were
"documented in `templates/SYSTEM.md`" after P2 and P4 removed them from
both prompt files. Two claims were simply false: `isTerminalPhase` and
`isActivePhase` do not exist in `brainstorming/state.ts` (they survive
only in a stale `.pi/worktree/` copy), and the `TaskExecute` citation
`pi-tasks/src/index.ts:326-330` now points at the prerequisite-results
block, not at spawn options — the real spawn is `:1418`–`:1423` and
passes no `isolation` at all.

---

## 9. Appendix — evidence index

Citations of the form `SYSTEM.md:230`–`232` refer to the **pre-refactor**
files (commit `fb8eb7c`), because they are evidence of the drift the
refactor removes. Post-refactor line numbers are not stable.

| Claim | Evidence |
|---|---|
| 6 orchestrator tools registered | `pi-orchestrator/src/orchestrator-tool.ts` — `task_inspect`, `task_consume`, `task_convert_intent`, `task_plan_intent`, `task_add_phase`, `task_close_intent` |
| `SYSTEM.md` read-side count is wrong (says 3, lists 2) | `SYSTEM.md:273`–`278` |
| Root `AGENTS.md` read-side count is correct (2) | `AGENTS.md` § "The orchestrator tool surface" |
| `max_turns` tiers are canonical in pi-tasks' tool description | `pi-tasks/src/index.ts:1354`–`1366` |
| Tier table duplicated in two prompt files | `SYSTEM.md:230`–`232`; `pi-orchestrator/skills/orchestrator/SKILL.md:57`–`59` |
| The turn ceiling is `max_turns + graceTurns`, not a literal `+5` | `pi-subagents/src/agent-runner.ts:1059`–`1062`; `graceTurns` default 5 at `:353`, configurable via `pi-subagents/src/settings.ts:41`, `:519` |
| An aborted task reverts to `pending` with `lastError` (claim is accurate) | `pi-tasks/src/index.ts:401`, `:427` |
| `SYSTEM.md` is prepended on every agent start | `pi-orchestrator/src/extension.ts:205`–`218` |
| `install.sh` will not overwrite an existing `SYSTEM.md` without `--force` | `pi-orchestrator/scripts/install.sh:576`–`591` |
| `agent-tool-description.md` uses a `SAGES_TEMPLATE_V1` sentinel for install/uninstall classification | `pi-orchestrator/scripts/install.sh:598` (constant), `:648`–`651` (`is_agent_tool_description_installed`), `:661`, `:666` |
| pi-subagents offers `{{isolationGuideline}}` whose text recommends `isolation: "worktree"` | `pi-subagents/src/index.ts:1464`–`1466`. The Sages template omits the variable, so the runtime's own recommendation never reaches the model. Note: the pre-refactor red lines forbade `"worktree"` for the wrong reason — it is a *valid* value (§2.8). |
| The `orchestrator` skill is discoverable at runtime | `pi-orchestrator/package.json` `"pi": { "skills": ["./skills"] }`; `node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:194` (`collectSkillEntries` recurses) |
| The active tool allowlist is 44 names (40 live), not "≈ 32" | `pi-orchestrator/src/extension.ts` — `ORCHESTRATOR_TOOL_NAMES` 6 (`src/orchestrator-tool.ts:951`), `PI_TASKS_TOOLS` 7, `PI_SUBAGENT_TOOLS` 3, `SUBAGENT_CONTROL_TOOLS` 4 (unregistered → dropped by pi), `AFT_TOOLS` 11, `BASELINE_TOOLS` 7, `PI_ROUTINES_TOOLS` 6 (conditional on install) |
| `bash_status` / `bash_watch` / `bash_write` / `bash_kill` / `ast_grep_search` / `ast_grep_replace` are not registered tools | `pi-orchestrator/src/extension.ts:93`–`101` (`BASELINE_TOOLS`); the names survive only in the stale catalogue `pi-evaluator/src/metrics/tool-adoption.ts:78`–`92` |
| The `Developer` / `Reviewer` background rule is not runtime-enforced | `pi-subagents/src/invocation-config.ts:141` (resolution chain); no `runInBackground` in `pi-subagents/src/default-agents.ts:24`–`52`; global default `backgroundByDefault = true` at `pi-subagents/src/index.ts:1169` |
| Only one of the two subagent tool families is live | `SUBAGENT_TOOL_NAMES` at `pi-subagents/src/agent-runner.ts:40`–`45` (live — 241 successful calls); `SUBAGENT_CONTROL_TOOLS` at `pi-orchestrator/src/extension.ts:73`–`78` (unregistered — implementation deleted in `a36ae68`) |
| `Explore` / `PlanCompiler` are not shipped defaults | `pi-subagents/src/default-agents.ts` ships `Developer` and `Reviewer` only; `AGENTS.md` § "The shipped subagent types" |
| The tool description names `PlanCompiler` without qualifying it as user-defined | `pi-orchestrator/templates/agent-tool-description.md:33`, `:46`, `:70`–`:71` (unqualified) vs. `pi-orchestrator/templates/SYSTEM.md:47` (qualified) |
| The AFT tool-priority ranking is stated in two files | `pi-orchestrator/templates/agent-tool-description.md:100`–`112`; `pi-orchestrator/templates/SYSTEM.md:141`–`300` |
| The smoke test requires a content token from `SYSTEM.md` | `pi-orchestrator/test/smoke/gc-2026-073.test.ts:171`–`182` — asserts `/orchestrator\|Soft mode\|workflow/i` |
| The reference overlay deliberately carries no tool manual | `~/Project/lazible-jcode/config/prompt-overlay.md` (15 sections, no tool tables) |
| The reference skill states its relationship to the policies | `~/Project/lazible-jcode/config/skills/swarm-engineering/SKILL.md:14` |
| T1 — the orchestrator's six consumer tools were registered but unreachable | `dbf53aa` (2026-10-11) deleted the `...ORCHESTRATOR_TOOLS` spread from the allowlist; `c68aeff` / `2aaafdd` (2026-10-12) and `473e861` (2026-10-15) added the six to the registry without re-adding them to the allowlist; pi's `setActiveTools` replaces the active set rather than extending it. Fix: `a197af2`. |
| T1 — runtime proof | 399 pi transcripts under `~/.pi/agent/sessions/`. `task_inspect`: 3 calls, 0 successes, 3 × `Tool task_inspect not found` (2026-10-17). `task_consume`: 1 call, 0 successes (2026-10-17). The four other orchestrator tools were never called. Controls in the same corpus: `TaskList` 557/557, `TaskCreate` 153/153. |
| T1 — the failing session was otherwise healthy | Session `2026-10-17T02-44-48-869Z_01a147bf-…`: the system message's `preamble` carries the `SYSTEM.md` constitution; `TaskList` × 13, `TaskCreate` × 7, `TaskUpdate` × 15, `TaskExecute` × 5, `TaskGet` × 5, `TaskOutput` × 1 and `get_subagent_result` × 3 all succeeded. |
| T2 — the four subagent-control tools have no registration | `pi-subagents/src/subagent-control-tools.ts` (414 lines, deleted in `a36ae68`) and its test; `pi-subagents/src/` registers no `subagent_*` tool. `subagent_status`: last success 2026-10-08, first `Tool subagent_status not found` 2026-10-13, 3 failures total. |
| T3 — pi-evaluator classifies against retired tool names | `pi-evaluator/src/extension.ts:37`, `src/metrics/tool-adoption.ts:68`, `src/metrics/tool-correctness.ts:43`, `src/metrics/tool-correctness-internals.ts:10`, `src/metrics/step-efficiency.ts:22` — all five sets list `goal_contract_create` / `dag_synthesize` / `task_dispatch` / `orchestrator_audit`; none lists any of the current six. |
| T4 — the `isolation` parameter accepts only `"off"` and `"worktree"` | `pi-subagents/src/invocation-config.ts:28`–`35` (`Type.Union([Type.Literal("off"), Type.Literal("worktree")])`). No object form, no `"current-workspace"`. |
| T4 — the managed-worktree domain was removed in the upstream sync | `a36ae68` (2026-10-11) dropped `worktree-contract/lease/ownership`; added earlier in `b5330e5` / `0d92b3a` / `8476c32`. Repository-wide search finds no `releaseManagedWorktree`, `leaseToken`, `managedWorktree` or `worktree_id` symbol, and `pi-tasks` never reads a metadata `isolation` field. |
| T4 — the worktree lifecycle the prompt now states | `pi-subagents/src/worktree.ts:106`–`113` (`git worktree add --detach <path> HEAD`), `:125`–`174` (commit to a branch, remove the worktree, keep the branch), `pi-subagents/src/agent-manager.ts:712`–`719` (strict failure when the repo has no commit). |
| The prompt suite names four of the five template variables, and the omission is deliberate | `pi-orchestrator/templates/agent-tool-description.md:14`–`:17` (`{{typeList}}`, `{{compactTypeList}}`, `{{agentDir}}`, `{{scheduleGuideline}}`); the runtime offers five (`pi-subagents/src/index.ts:1536`–`1541`) and the fifth, `{{isolationGuideline}}`, is deliberately absent because the Sages template states the isolation contract itself (`templates/SYSTEM.md` §7) rather than inheriting a generated one. |
| Four of the five context files the prompt asks the model to read are not in the repo | `pi-orchestrator/templates/SYSTEM.md:60`; `README.md` and `AGENTS.md` exist, `CLAUDE.md` / `.pi/SYSTEM.md` / `.specify/memory/constitution.md` / `SPEC.md` do not. |
| The tier values and the default tier still agree with the canonical copy; only the prose drifted | canonical `pi-tasks/src/index.ts:1357`–`1361`; copies at `pi-orchestrator/templates/SYSTEM.md:230`–`232` and `pi-orchestrator/skills/orchestrator/SKILL.md:57`–`59`. Verified by `pi-orchestrator/test/prompt-consistency.test.ts` (live assertion). |
| P1 — the prompt-consistency test exists and its target assertions are all currently failing | `pi-orchestrator/test/prompt-consistency.test.ts` — 8 live assertions pass, 9 `it.skip` target assertions, all 9 verified to fail against the current prompts. (A tenth, the prefix-rule phantom-name check, was added in `fb8eb7c`; all 10 target assertions were verified to fail for the intended reason.) |
| The `pi-subagents` suite is red before this work starts, and the cause is the fork | `bunx vitest run` in `pi-subagents/` — 94 failures / 15 files; `pi-subagents/examples/` does not exist (ENOENT in `test/tool-description-mode.test.ts`); the tests expect upstream's `general-purpose` / `Explore` types while `pi-subagents/src/default-agents.ts:24`, `:39` ship `Developer` / `Reviewer`. Zero of those files are touched by this refactor. |

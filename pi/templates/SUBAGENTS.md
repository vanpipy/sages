# Subagent Pipeline — Reference for the Orchestrator

> **Soft mode (GC-2026-031)** — the main agent has full tool access by
> default (`edit` / `write` / `aft_edit` / `apply_patch` plus
> unrestricted `bash`). Nothing is blocked. Subagent dispatch via
> the 4-stage DAG workflow is **RECOMMENDED** for workflows with
> >2 items in the active todowrite; direct handling is acceptable
> for ≤2-item workflows. Drift is auto-steered (system reminder
> via `pi.appendEntry`) and never blocked. No previous-enforcement
> toggle; soft mode is the only mode.

The orchestrator (main agent) dispatches work to subagents via the `Agent`
tool. This file is the **deployment reference** for which subagents
exist, what tools each one has, and how to invoke them. The
**workflow** (when to use which stage, how to compose a DAG) lives in
`pi/skills/orchestrator/SKILL.md`. The **run_in_background policy** lives
in code — see `pi/src/tools/orchestrator/task-dispatcher.ts:defaultRunInBackground()`
(single source of truth).

**Installation**: this file is installed to `~/.pi/agent/SUBAGENTS.md`
by `pi/scripts/install.sh` and is referenced from the Agent tool
description as "see `~/.pi/agent/SUBAGENTS.md` for the full rationale
and code examples". Subagents themselves do NOT read it (they get their
identity from `~/.pi/agent/agents/<name>.md`).

The main agent owns understanding and all planning decisions. It may use
read-only tools (including Explore) to inspect the repository, then writes a
self-contained Planning Brief. `Plan` is only a bounded compilation helper
after the brief; it is not the architecture stage and must not invent missing
decisions.

The orchestrator **RECOMMENDS** subagent dispatch based on the task shape
and the task-count threshold (>2 items in the active todowrite):

- **Meta-file edits / design-doc writes** → RECOMMENDED: `developer`
  with `isolation: "current-workspace"` + `tdd: "none"` (no worktree;
  agent operates in dispatcher's cwd). **Root meta only** (GC-2026-029):
  `.pi/orchestrator/*`, `.pi/agents/*`, `.claude/`, `.codex/`, root
  `README.md`, `AGENTS.md`, `package.json`, `tsconfig*.json`,
  `.gitignore`, `.aft.jsonc`. Direct `edit` / `write` in the main session
  is also acceptable for ≤2-item workflows.
- **Production-code TDD work** → RECOMMENDED for >2-item workflows:
  `developer` with `isolation: { dag_id, task_id, mode: "create" }`
  (managed worktree). Recommended for the entire `pi/**` tree, every
  sibling `pi-*/**` subpackage, and any user source (`src/**`,
  `test/**`, `lib/**`, …). For ≤2-item workflows direct editing is also
  acceptable.
- **Serial follow-up in same workspace** → `developer` with `isolation:
  { dag_id, task_id, mode: "reuse" }` (reuses the prior worktree)
- **Audit / verify** → `auditor` (read-only, evidence-based)
- **Quick search** → `Explore`; **Planning Brief compilation** → `Plan`
  (bounded, read-only).
- **Multi-stage workflows** → `task_dispatch` (orchestrator tool) — emits
  developer / auditor dispatches automatically

The pipeline is main-agent understanding and decision → Planning Brief →
Plan compilation and main-agent review → dispatch → audit.
- Use `developer` with `isolation: "current-workspace"` + `tdd: "none"`
  for meta-file edits and design-doc writes (no worktree; agent runs in
  dispatcher's cwd). Recommended pattern; direct `edit` / `write` in the
  main session is also acceptable for ≤2-item workflows.
- Use `developer` with `isolation: { dag_id, task_id, mode: "create" }`
  (managed worktree) for production-code TDD work on >2-item workflows.
- Use `developer` with `isolation: { dag_id, task_id, mode: "reuse" }`
  to re-enter an existing worktree for serial follow-up tasks in the
  same DAG.
- Use `auditor` (read-only) for verification — never modify production
  code from an auditor dispatch.

The `developer` agent accepts three explicit isolation modes:
- `isolation: { dag_id, task_id, mode: "create" }` — fresh managed
  worktree at `.pi/worktree/<dag>/<task>` from `origin/main`; recommended
  default for production code on >2-item workflows. Lease is held for
  the duration of the task; the developer commits inside the worktree
  and the orchestrator merges the result branch into main after audit.
- `isolation: { dag_id, task_id, mode: "reuse" }` — re-enter an existing
  worktree slot for serial follow-ups (concurrent reuse is rejected).
- `isolation: "current-workspace"` — opt out of a worktree entirely;
  the agent runs in the parent's cwd. Recommended for meta-file edits
  and design-doc writes; no audit gate.

The legacy `isolation: "worktree"` string literal is rejected by the
current Agent dispatcher; the `developer` runtime also rejects
`isolation: undefined` (every dispatch must name one of the three
modes above).

## Agent Roster

| Stage | `subagent_type`     | Source                              | Tools                | Purpose                                                                |
|-------|----------------------|--------------------------------------|----------------------|------------------------------------------------------------------------|
| 1     | `Explore`            | pi-subagents built-in                | read, bash, grep, find, ls | Fast codebase search. Cheap, fast, **read-only** — inherits the parent registry's cheapest available model when dispatched without `model=`.        |
| 2     | `Plan`               | pi-subagents built-in                | read | Planning Brief compiler; Haiku/minimal, foreground, 12-turn cap, no extensions/skills or inherited conversation. **Read-only** — never edits. |
| 3     | `developer`         | **shipped** (pi-subagents built-in) | read, bash, grep, find, ls, edit, write | Strict TDD implementer. Sonnet + high thinking. Host-managed worktree. |
| 4     | `auditor`   | **shipped** (this repo)              | read, bash, grep, find, ls, aft_* | Evidence-based certifier. **Read-only** — re-runs commands, never modifies production code. |

**Four default agents.** Two built-ins (`Explore`, `Plan`) ship from
`@tintinweb/pi-subagents`. Two Sages agents (`developer`, `auditor`)
are installed by sages (`developer` is a Phase A alias of itself — it
inherits its identity from `~/.pi/agent/agents/` and is the canonical
strict-TDD implementer; `auditor` is the canonical evidence certifier)
into `~/.pi/agent/agents/`. Don't re-ship `Explore` / `Plan` —
overriding with a project-specific copy brings no behaviour change.
Override them only when project-specific rules are needed (drop a
`.md` of the same name into `agents/`).

## Dispatch Examples

One per stage. The orchestrator uses the `Agent` tool with
`subagent_type` set to the desired agent.

### Stage 1 — Research (`Explore`)

```ts
Agent({
  subagent_type: "Explore",
  prompt: "Find all places in pi/src/ that import registerOrchestratorTools. " +
          "Report file paths, line numbers, and a one-line context for each.",
  description: "Find orchestrator call sites",
})
```

**Returns**: file/line list + 1-line context. Never edits.

### Stage 2 — Planning Brief compilation

```ts
Agent({
  subagent_type: "Plan",
  prompt: `Goal: ...\nChosen approach / decisions: ...\nScope / exclusions: ...\nCritical files / symbols: ...\nAcceptance / verification: ...\nDependencies / sequencing: ...\nKnown risks / open questions: ...`,
  description: "Compile implementation brief",
})
```

Plan compiles the supplied brief; it does not perform architecture design.


### Stage 3 — Implement (`developer`)

`developer` runs in the **background by default** (TDD cycles are 1–10 min, can be steered mid-run — see `task-dispatcher.ts:defaultRunInBackground()` for the canonical rule).

```ts
Agent({
  subagent_type: "developer",
  prompt: "RED: write a failing test for X. GREEN: implement. REFACTOR: tighten. " +
          "Verification: `cd pi && bun test test/foo.test.ts` passes.",
  description: "Implement feature X",
  isolation: {
    dag_id: "GC-2026-008",
    task_id: "I1",
    mode: "create",
  },                            // ★ host provisions before child startup
  run_in_background: true,        // ★ see task-dispatcher.ts:defaultRunInBackground
})
```

The pi-subagents host creates
`<repo>/.pi/worktree/<dag>/<worktree>` from `origin/main` on
`sages/<dag>/<worktree>`, leases the slot, and returns worktree handoff
metadata. The main agent coordinates only: it does not run Git provisioning.
Use the same optional `worktree_id` with `mode: "reuse"` for serial work;
concurrent reuse is rejected. There is no auto-merge. After validation and
any requested integration, release explicitly through
`AgentManager.releaseManagedWorktree(...)`; set `deleteBranch: true` only
when branch deletion is intended. Subagents follow the role-owned namespace
rules below.

**Returns**: file paths changed + test output + verification evidence.

### Stage 4 — Verify (`auditor`)

`auditor` runs in the **background by default** (verifies the whole diff, can be steered to add new SCs — same canonical rule via `task-dispatcher.ts:defaultRunInBackground()`).

```ts
Agent({
  subagent_type: "auditor",
  prompt: "Audit the implementer's report at .pi/orchestrator/task-T3-report.md. " +
          "Re-run every verification_cmd from the task prompt. " +
          "Inspect git diff in <worktree-path>. " +
          "Write your report to .pi/orchestrator/audit-T3.md.",
  description: "Audit T3",
  run_in_background: true,
})
```

**Returns**: `CERTIFIED | NEEDS WORK | BLOCKED` + evidence-based report.

## Dispatch examples

### Example 1: edit a meta-file (current-workspace mode)

```ts
// L3 main agent (orchestrator) — no worktree, agent operates in dispatcher's cwd
Agent({
  subagent_type: "developer",
  isolation: "current-workspace",
  tdd: "none",
  prompt: "Edit AGENTS.md to add X. Read first, edit, report diff.",
  description: "Edit AGENTS.md to add X",
  run_in_background: true,
})
// Main reviews diff → main commits
```

### Example 1b: edit a meta-file when worktree isolation is needed (parallel batch)

```ts
// Use the explicit object form when the meta-file edit needs its own
// worktree — e.g. running in parallel with other batch tasks that may
// touch the same files, or when you want the audit/merge gate.
Agent({
  subagent_type: "developer",
  isolation: { dag_id: "GC-2026-008", task_id: "M1", mode: "create" },
  tdd: "none",
  prompt: "Edit AGENTS.md to add X. Read first, edit, report diff.",
  description: "Edit AGENTS.md to add X",
  run_in_background: true,
})
```

### Example 2: production-code TDD

```ts
Agent({
  subagent_type: "developer",
  isolation: {
    dag_id: "GC-2026-008",
    task_id: "X1",
    mode: "create",
  },
  prompt: "Implement the new caching layer in src/cache/. RED first, then GREEN, then REFACTOR. Run `bun test test/cache/` after each step.",
  description: "Implement caching layer",
  run_in_background: true,
})
// Developer commits inside the worktree; orchestrator merges after audit
```

### Example 3: audit a change

```ts
Agent({
  subagent_type: "auditor",
  prompt: "Verify commit 0675713 is consistent with its commit message: run `bun test`, confirm 4 files modified, confirm no other files touched. Return CERTIFIED / NEEDS WORK / BLOCKED with evidence.",
  description: "Audit commit 0675713",
  run_in_background: true,
})
```

### Example 4: git operations under soft mode

```ts
// L3 main agent (orchestrator) - under soft mode the bash-guard no
// longer blocks, so plain `git add` + `git commit` from the main
// session is allowed. Recommended patterns:
//   - For ≤2-item workflows, run git directly in the main session:
//       git add pi/src/tools/foo.ts
//       git commit -m "fix(foo): ..."
//   - For >2-item workflows, dispatch developer for an audit trail:
//       Agent({
//         subagent_type: "developer",
//         isolation: "current-workspace",
//         tdd: "none",
//         prompt: "Commit the staged changes with a Conventional Commits message.",
//         description: "Commit pending changes",
//         run_in_background: true,
//       })
//
// `isolated: true` is no longer required for git ops — it remains
// available for subagents that explicitly need extension-free bash,
// but the typical case doesn't need it under soft mode.
```

### Example 5: parallel dispatch (3 independent tasks)

```ts
// L3 main agent — 3 independent investigations, all in parallel
Agent({
  subagent_type: "auditor",
  prompt: "Verify commit A passes tests. Run bun test pi/test/.",
  description: "Verify commit A",
  run_in_background: true,
})
Agent({
  subagent_type: "auditor",
  prompt: "Verify commit B passes tests. Run bun test pi-subagents/test/.",
  description: "Verify commit B",
  run_in_background: true,
})
Agent({
  subagent_type: "developer",
  isolated: true,
  tdd: "none",
  prompt: "Commit pending changes with proper message.",
  description: "Commit pending changes",
  run_in_background: true,
})
// Main agent continues, collects results via notification or get_subagent_result()
```

Anti-pattern:

```ts
// ✗ serial — each call blocks until subagent finishes
const r1 = await Agent({ subagent_type: "auditor", prompt: "Verify A" })
const r2 = await Agent({ subagent_type: "auditor", prompt: "Verify B" })
// total wall time = T(A) + T(B)
```

```ts
// ✓ parallel — total wall time = max(T(A), T(B))
Agent({ ..., prompt: "Verify A", run_in_background: true })
Agent({ ..., prompt: "Verify B", run_in_background: true })
```
**Don't parallelize when tasks share mutable state**:

```ts
// ✖ DON'T — three parallel git commits race on .git/index
Agent({ ..., prompt: "git add X && git commit -m 'A'", run_in_background: true })
Agent({ ..., prompt: "git add Y && git commit -m 'B'", run_in_background: true })
Agent({ ..., prompt: "git add Z && git commit -m 'C'", run_in_background: true })
// second and third commits fail (HEAD moved) or produce non-linear history
```ts
// ✓ DO — serialize when commits chain
Agent({ ..., prompt: "git commit A" })  // foreground; wait for SHA
Agent({ ..., prompt: "git commit B using parent <SHA-A>" })  // chain
Agent({ ..., prompt: "git commit C using parent <SHA-B>" })  // chain

Other serial-required patterns:
- Multiple edits to the **same file** (working tree race)
- Lockfile updates (`package-lock.json`, `Cargo.lock`)
- `npm install` (concurrent invocations corrupt `node_modules/`)

### When to use foreground vs background

| Pattern | When |
|---|---|
| **Parallel background** | Multiple **independent** sub-tasks (different files, different refs, no shared state) |
| **Serial foreground** | Tasks share state (commits, lockfiles, same file) OR next depends on previous |
| **Single foreground** | Result feeds next decision; task is short; no parallel work |
| **Background + get_subagent_result** | Long-running, need explicit polling |

### Composing a DAG

The orchestrator stitches stages into a DAG via `goal_contract_create` →
`dag_synthesize` → `task_dispatch`. The DAG is the structured form of
"Compose the pipeline":

```yaml
# .pi/orchestrator/dag-GC-2025-001.yaml (simplified)
tasks:
  - id: R1     # Stage 1
    subagent_type: Explore
    batch: 1
    prompt: "Find all callers of install_subagents_doc across the codebase"
  - id: D1     # Stage 2
    subagent_type: Plan
    batch: 2
    depends_on: [R1]
    prompt: "Design the doc template + install hook"
  - id: I1     # Stage 3
    subagent_type: developer
    batch: 3
    depends_on: [D1]
    isolation:
      dag_id: GC-2025-001
      task_id: I1
      mode: create
    prompt: "Implement per the plan: RED→GREEN→REFACTOR for install_subagents_doc"
  - id: V1     # Stage 4
    subagent_type: auditor
    batch: 4
    depends_on: [I1]
    prompt: "Certify I1: re-run install.test.sh, inspect worktree diff"
```

Each stage gates the next via `depends_on`. The DAG's `batch: N`
field encodes dependency order — for parallel work, multiple tasks
share a batch number.

## MANDATORY TERMINAL YAML BLOCK SURFACE

Every dispatch of `developer`, `auditor`, `Explore`, `Plan`,
`git-expert`, or `merger` MUST terminate its final assistant message
with the canonical yaml block below. This is not optional — omission
is the most common castration finding that has dropped workflow
audit scores by ~50 points in GC-2026-044 and GC-2026-045, and forces
the orchestrator_audit verdict into `REVISE` even when the substance
of the work is passing.

### Why

`orchestrator_audit` parses each task's final assistant message
mechanically (`extractStructuredOutput`) to certify the verdict. A
prose-only summary cannot be parsed; the audit applies a castration
finding that lowers the score and prevents promotion to `PASS`. The
yaml block is the lingua franca that survives a developer sub-agent
running 17+ minutes, an auditor one running 30+ minutes, or any
long-running dispatch with multiple RED→GREEN→REFACTOR cycles.

### The canonical block

Every final assistant message MUST end with this exact fenced yaml
block (named fields, with the listed status enum). The block must
appear AFTER any prose summary, AFTER any code-fenced samples, and
immediately before the message ends.

```yaml
status: completed | blocked | partial | needs-info
deliverables:
  files_changed: [<list of paths this task created or modified>]
  commits: [<list of commit SHA + subject, in chronological order>]
  tests_added: [<list of test paths + case counts where applicable>]
test_results:
  pass: <integer>
  fail: <integer>
  fail_details: [<list of failing test names + 1-line reason>]
open_questions:
  - <list of decisions needed from L3 / user; empty list if none>
handoff_for_next_task:
  - <list of notes for the downstream task, or empty list if none>
```

### Field semantics

| Field | Required | Semantics |
|---|---|---|
| `status` | yes | One of: `completed` (task fully done), `blocked` (cannot proceed, escalate to L3), `partial` (some goals met, others deferred), `needs-info` (waiting on user/L3 input). The orchestrator_audit map-reduces `completed` → CERTIFIED, anything else → NOT-CERTIFIED. |
| `deliverables.files_changed` | yes | Relative-to-repo-root paths. Empty list is valid (`[]`) only if `status: completed` and the task was a no-op (e.g. pure read/inspect). |
| `deliverables.commits` | yes | `<sha>` or `<sha> <subject>`. Empty list only if the task does not commit. |
| `deliverables.tests_added` | no | Convention; recommended when adding tests. |
| `test_results.pass` | yes (when applicable) | Integer. `0` is valid when the task added no tests. |
| `test_results.fail` | yes (when applicable) | Integer. Must equal zero for `status: completed`. |
| `test_results.fail_details` | required when `fail > 0` | One-line per failing test. |
| `open_questions` | yes (may be empty list) | If non-empty, the L3 must read this list. |
| `handoff_for_next_task` | no | Conventions guide. Empty list when the task has no successor. |

### Bad vs good examples

**Bad** (prose-only — will be flagged as castration):

> I ran the tests and they pass. The implementation is at
> `src/foo.ts`. Heads-up: the failure was caused by missing imports.
> Should be merged shortly.

**Good** (yaml block, audit-tool-parseable):

> Summary: ... [prose explanation, observation details, etc]
>
> ```yaml
> status: completed
> deliverables:
>   files_changed: [src/foo.ts, src/bar.ts]
>   commits: ["abc1234 feat(foo): add baz"]
>   tests_added: [test/foo.test.ts (3 cases)]
> test_results:
>   pass: 3
>   fail: 0
>   fail_details: []
> open_questions: []
> handoff_for_next_task:
>   - "T2: verify with auditor — see commit abc1234"
> ```

### L3 dispatcher responsibilities

The L3 main agent's dispatch prompt template MUST include the
canonical yaml block verbatim (above). When an L3 prompt omits the
template, the L3 should reproduce the schema from this section
rather than dispatching without the surface instruction. Sub-agents
that hit the default turn envelope and produce a long turn are most
likely to omit the trailing yaml — including it explicitly in the
prompt reduces the occurrence rate.

### What this section is NOT

- This is not a castration contract for the OPERATOR (`L3 main
  agent`); operators remain free to write prose-only responses.
- This is not a castration contract for short-form dispatch tools
  (`Read`, `Grep`, `Glob`, etc.); only dispatch agents listed in the
  status enum above emit the block.
- This is not a castration contract for LLM-managed ad-hoc sub-agents
  (Plan / Brainstorm sessions); those are non-dispatch tooling.

## Git Expert — when to dispatch and how

The orchestrator does not own Git archaeology. Symptom matching → dispatch
`git-expert` so the orchestrator's chat history doesn't accumulate ad-hoc
Git reasoning. `git-expert` ships as a built-in of `pi-subagents`
(GC-2026-030); the Agent tool description renders it via the standard
`{{typeList}}` mechanism — no manual prompt template maintenance needed.

### Brief format (mandatory fields)

```
Agent({
  subagent_type: "git-expert",
  prompt: [
    "task_id: GC-2026-030",                 // names the sandbox
    "scenario: merge-conflict-preview",     // one of the 7 below
    "repo_root: /home/leroy/Project/sages",
    "symptom: <one-paragraph concrete observation>",
  ].join("\n"),
  description: "Diagnose worktree add failure on DAG-2026-030/P2",
  run_in_background: true,
})
```

If any of `task_id` / `scenario` / `repo_root` is missing, `git-expert`
returns `BLOCKED: missing <field>` immediately — the orchestrator then
either fills the gap or escalates.

### Recognized scenarios

| Scenario | When to use |
|---|---|
| `worktree-broken` | `git worktree add` failed (bare-repo collision, branch checked-out elsewhere, missing `.git` pointer, etc.) |
| `lost-commit` | A commit appears missing after rebase / reset / delete-branch; need fsck + reflog recovery plan |
| `merge-conflict-preview` | Before dispatching `merger`, want an independent classification of conflict shape |
| `bisect` | "Which commit introduced bug X?" — git-expert prepares a runnable `git bisect run` script |
| `branch-hygiene` | List stale branches / orphaned worktrees / unreferenced tags for prune review |
| `git-recipe-for-<role>` | Produce a step-by-step runnable Git procedure for `developer` / `merger` / another subagent |
| `general-diagnosis` | Free-form investigation under the R1/R2/R3 invariant |

### Runtime knobs

| Knob | Value | Why |
|---|---|---|
| `subagent_type` | `"git-expert"` | Built-in to pi-subagents as of GC-2026-030 |
| `builtinToolNames` | `READ_ONLY_TOOLS` (`read`, `bash`, `grep`, `find`, `ls`) | git-expert has no `edit`/`write` tools; all writes happen via `bash` inside the sandbox |
| `extensions` | `aft`, `pi-mcp-adapter`, `pi-magic-context` | Indexed semantic tools to confirm findings against non-git file content |
| `excludeExtensions` | `pi-subagents` | No recursive `Agent` dispatch from git-expert |
| `run_in_background` | `true` (default) | Archaeology can run 1–10 min; do not block the orchestrator |
| `maxTurns` | `120` | Wider than `merger`'s 80; caller may still override |
| `inheritContext` | `false` | Deterministic tool: brief is self-contained, no fork of parent's history |
| `model` | _unset_ | Inherits global default per caller request — pinning a model would silently bypass that policy |
| `isolation` | _unset_ | git-expert operates in the orchestrator's cwd; the brief carries the repo root |
| `skills` | `false` | No project conventions — the prompt carries all rules (R1/R2/R3) |

DAG dispatch: set `task_template: "subagent-git-expert"` on a task node
(in the whitelist as of GC-2026-030). Ad-hoc dispatch: `subagent_type: "git-expert"`.

### Scratch path invariant (R3)

Every `git-expert` write happens inside the orchestrator's repo root, under:

```
<repo>/.pi/git-scratch-<task_id>-<suffix>/
```

The `<task_id>` is the dispatch task id (e.g. `P1`); `<suffix>` is a short
random string git-expert generates to avoid concurrent collisions. `.pi/`
is gitignored so the scratch never pollutes the repo, but the orchestrator
MUST surface the residual path in its response so the user can decide
whether to `rm -rf` it. `git-expert` may `git init` throwaway repos,
`git clone --no-checkout`, and run `commit`/`reset`/`rebase`/`merge`
inside the scratch — but never against the original repository's working
tree, index, or refs (R1) and never touching `/home/leroy/Project/sages/.git`
or any active managed worktree (R2).

### Trigger conditions for the orchestrator

| Symptom in chat | Default action (without git-expert) | With git-expert |
|---|---|---|
| `git worktree add` failed (any reason) | Retry, fallback, or hand off to user | Diagnose first, then act on the report |
| Predicting merge conflict shape before `merger` dispatch | Blindly dispatch merger; discover at audit | `merge-conflict-preview` — independent classification |
| "Commit X appears missing" / ref broken | No procedure | `lost-commit` — fsck + reflog + recovery plan inside sandbox |
| "When did bug Y appear?" / bisect request | Main agent does ad-hoc `git log` | `bisect` — runnable `git bisect run` script returned |
| Periodic branch / tag / worktree hygiene | Skip | `branch-hygiene` — prune candidate list (orchestrator executes deletes) |
| Another subagent (`developer`, `merger`) needs a step-by-step Git procedure | Inline prompt mostly hand-waving | `git-recipe-for-<role>` — format-pinned recipe with pre-conditions / steps / failure modes / verify / forbidden |

For the workflow-level trigger discussion (how this fits into the
Stage-3 dispatch loop), see `pi/skills/orchestrator/SKILL.md` §
"When to dispatch git-expert".

## Git ops from main repo

The bare repository's `.git/` internals (`HEAD`, `refs/`, `objects/`,
`packed-refs`, and config) are read-only. Refs are changed only through
Git porcelain, preserving reflogs and locking. Under **soft mode** no
git command is hard-blocked by the bash-guard; the recommendations
below remain the recommended pattern, especially on complex
multi-task workflows.

Allowed (and recommended) from the main repository and other working
directories:

- `git checkout` or `git switch` for refs, new branches, or detached
  commits (avoid path checkout; avoid `--discard-changes`)
- `git branch` for creation and listing (avoid deletion)
- `git fetch`, `pull`, `remote -v`, and `remote add`
- `git merge`, `cherry-pick`, and `rebase`
- `git push` without any force option
- `git worktree add`
- `git tag` for creation and listing (avoid deletion)
- `git add`, `commit`, `stash`, and `stash pop`
- `git init` and `clone`
- `rm` / `mv` / `cp` / `unlink` / `rmdir` (no longer hard-blocked
  under soft mode; dispatch `developer` for an audit trail on
  complex workflows)

Avoid from every working directory (recommendation, not enforcement):

- `git checkout -- <paths>`, `git checkout <ref> -- <paths>`,
  `git switch --discard-changes`, and `git restore <paths>`
- `git reset --hard` and `git clean -fd`
- `git stash drop`, branch or tag deletion, and forced worktree
  removal
- `git push --force`, `-f`, `--force-with-lease`, or
  `--force-if-includes`
- direct edits to `.git/`

A worktree is recommended for production-code changes, parallel
tasks that need independent working trees, and destructive work
that benefits from an audit gate. It is not required merely to
read another branch, compare refs, or run a non-destructive ref
operation. A broken main worktree must be repaired from a fresh
managed worktree or by the user, never from inside the broken tree.

## `.pi/orchestrator/` namespace ownership

Subagents use role-owned records without sharing mutable files:

- Developers write `task-{task_id}-report.md` and
  `handoff/{workspace_id}/{task_id}-handoff.md`.
- Auditors write `audit-{task_id}.md`.
- L3 owns `goal-{id}.yaml`, DAG, audit-state, and workflow rollup files.
- Explore and Plan remain read-only.

Cross-namespace overwrites are prohibited. Each role must validate its output
path before writing and must not replace another role's state.

## Related

- **Workflow** (when to dispatch what, how to chain stages): `pi/skills/orchestrator/SKILL.md`
- **Agent identity** (tools, isolation, output format): `~/.pi/agent/agents/<name>.md`
- **Background policy** (which `run_in_background` for which type): `pi/src/tools/orchestrator/task-dispatcher.ts:defaultRunInBackground()`
- **Agent tool description** (text shown to the main agent for the `Agent` tool): `pi/templates/agent-tool-description.md`
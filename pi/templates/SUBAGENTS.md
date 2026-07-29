# Subagent Pipeline — Reference for the Orchestrator

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

The orchestrator dispatches subagents based on the task shape:

- **Meta-file edits / design-doc writes** → `developer` with `isolation: "current-workspace"` + `tdd: "none"` (no worktree; agent operates in dispatcher's cwd). For git ops that bash-guard would block, also pass `isolated: true` to bypass the bash-guard hook.
- **Production-code TDD work** → `developer` with `isolation: { dag_id, task_id, mode: "create" }` (managed worktree)
- **Serial follow-up in same workspace** → `developer` with `isolation: { dag_id, task_id, mode: "reuse" }` (reuses the prior worktree)
- **Audit / verify** → `auditor` (read-only, evidence-based)
- **Quick search** → `Explore`; **Planning Brief compilation** → `Plan` (bounded, read-only).
- **Multi-stage workflows** → `task_dispatch` (orchestrator tool) — emits developer / auditor dispatches automatically

The pipeline is main-agent understanding and decision → Planning Brief → Plan compilation and main-agent review → dispatch → audit.
- Use `developer` with `isolation: "current-workspace"` + `tdd: "none"` for meta-file edits and design-doc writes (no worktree; agent runs in dispatcher's cwd).
- Use `developer` with `isolation: { dag_id, task_id, mode: "create" }` (managed worktree) for production-code TDD work.
- Use `developer` with `isolation: { dag_id, task_id, mode: "reuse" }` to re-enter an existing worktree for serial follow-up tasks in the same DAG.
- Use `auditor` (read-only) for verification — never modify production code from an auditor dispatch.

The `developer` agent accepts three explicit isolation modes:
- `isolation: { dag_id, task_id, mode: "create" }` — fresh managed worktree at `.pi/worktree/<dag>/<task>` from `origin/main`; default for production code. Lease is held for the duration of the task; the developer commits inside the worktree and the orchestrator merges the result branch into main after audit.
- `isolation: { dag_id, task_id, mode: "reuse" }` — re-enter an existing worktree slot for serial follow-ups (concurrent reuse is rejected).
- `isolation: "current-workspace"` — opt out of a worktree entirely; the agent runs in the parent's cwd. Used for meta-file edits and design-doc writes; no audit gate.

The legacy `isolation: "worktree"` string literal is rejected by the current Agent dispatcher; the `developer` runtime also rejects `isolation: undefined` (every dispatch must name one of the three modes above).

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

### Example 4: git operations with `isolated: true` (bypass bash-guard)

```ts
// L3 main agent (orchestrator) - needs git add + git commit
// but the bash-guard classifies those as unknown and blocks.
// isolated: true disables Sages extension loading entirely,
// so the bash-guard hook never registers. The subagent bash
// is unrestricted (but loses AFT / MCP / magic-context - not
// needed for git ops).
Agent({
  subagent_type: "developer",
  isolated: true,
  tdd: "none",
  prompt: "Run these in sequence:\\n  cd /home/leroy/Project/sages\\n  git add pi/src/tools/foo.ts\\n  git commit -m 'fix(foo): ...'",
  description: "Commit fix to pi/src/tools/foo.ts",
  run_in_background: true,
})
// Subagent reports the SHA; main verifies with git log --oneline -2
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

## Git ops from main repo

The bare repository's `.git/` internals (`HEAD`, `refs/`, `objects/`,
`packed-refs`, and config) are read-only. Refs are changed only through Git
porcelain, preserving reflogs and locking. The Layer 2 destructive filter,
not a blanket worktree rule, controls these commands.

Allowed from the main repository and other working directories:

- `git checkout` or `git switch` for refs, new branches, or detached commits
  (never path checkout; never `--discard-changes`)
- `git branch` for creation and listing (never deletion)
- `git fetch`, `pull`, `remote -v`, and `remote add`
- `git merge`, `cherry-pick`, and `rebase`
- `git push` without any force option
- `git worktree add`
- `git tag` for creation and listing (never deletion)
- `git add`, `commit`, `stash`, and `stash pop`
- `git init` and `clone`

Denied from every working directory:

- `git checkout -- <paths>`, `git checkout <ref> -- <paths>`,
  `git switch --discard-changes`, and `git restore <paths>`
- `git rm`, `git mv`, `git reset --hard`, and `git clean -fd`
- `git stash drop`, branch or tag deletion, and forced worktree removal
- `git push --force`, `-f`, `--force-with-lease`, or `--force-if-includes`
- direct edits to `.git/`

A worktree is still required for production-code changes, parallel tasks that
need independent working trees, and destructive work that needs the audit
gate. It is not required merely to read another branch, compare refs, or run a
non-destructive ref operation. A broken main worktree must be repaired from a
fresh managed worktree or by the user, never from inside the broken tree.

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
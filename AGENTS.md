# Sages — Agent Operational Guide

> **Audience:** an LLM working in the Sages monorepo. This is the operational
> contract to read at session start. For the human-facing overview, see
> [README.md](README.md).

## What you are

You are the **L3 orchestrator**: the brain, not the implementation limb. You
understand goals, build a DAG, dispatch subagents, and audit their evidence.
Three guiding principles govern the work (soft mode — GC-2026-031):

1. **Soft mode: full tool access by default.** The main agent has full tool
   access (`edit`, `write`, `aft_edit`, `apply_patch`, unrestricted `bash`)
   — nothing is stripped on session startup and no bash command is blocked
   (including `rm` / `mv` / `cp` / `unlink` / `rmdir`). The bash-guard is
   a classifier under soft mode, not a gate. See "Soft mode and task-count
   threshold" below for the recommendation mechanism.
2. **Production code uses managed-worktree dispatch.** RECOMMENDED for
   `src/`, `test/`, `lib/`, the entire `pi/` tree, every sibling `pi-*/`
   subpackage, or any root source file: dispatch `developer` with
   `isolation: { dag_id, task_id, mode: "create" }` and use TDD. For ≤2-item
   workflows direct editing is also acceptable.
3. **Root meta-files use current-workspace dispatch (lightweight).** For
   root-level docs and config (`.pi/orchestrator/*`, `.pi/agents/*`,
   `.claude/`, `.codex/`, root `README.md`, `AGENTS.md`, `package.json`,
   `tsconfig*.json`, `.gitignore`, `.aft.jsonc`), dispatch `developer` with
   `isolation: "current-workspace"` and `tdd: "none"`; review the diff before
   committing. Direct editing in the main session is also acceptable for
   ≤2-item workflows. **Every Sages package subtree (`pi/`, every `pi-*/`)
   is production code** — no carve-outs (GC-2026-029).

## The 4 orchestrator tools

| Tool | Stage | Output |
|---|---|---|
| `goal_contract_create` | 1 | `.pi/orchestrator/goal-{id}.yaml` |
| `dag_synthesize` | 2 | `.pi/orchestrator/dag-{id}.yaml` |
| `task_dispatch` | 3 | Agent-call plan grouped by batch |
| `orchestrator_audit` | 4 | `.pi/orchestrator/audit-workflow.md` |

Load `pi/skills/orchestrator/SKILL.md` for the step-by-step workflow.

## The 5 subagents

| `subagent_type` | Background | Use | Isolation |
|---|---:|---|---|
| `Explore` | no | Bounded, read-only search | none |
| `Plan` | no | Compile a Planning Brief already decided by main | none |
| `developer` | yes | TDD implementation or meta-file writing | explicit object or `"current-workspace"` |
| `auditor` | yes | Re-run verification and certify evidence | read-only |
| `git-expert` | yes | Senior git inspection / backtrack / cross-subagent recipes | read-only (writes in `.pi/git-scratch-<task_id>-<suffix>/`) |

Two additional built-ins extend the roster when needed: `merger` handles
cross-workspace DAG merges (read-only inspection, writes only merge
commits into a scratch branch) and `git-expert` performs deep git
inspection, worktree / branch / merge diagnostics, and produces
git-usage recipes for other subagents (read-only on production code;
writes confined to `.pi/git-scratch-<task_id>-<suffix>/`). The complete
invocation contract, isolation modes, and examples are in
`pi/templates/SUBAGENTS.md`, installed as `~/.pi/agent/SUBAGENTS.md`.
`defaultRunInBackground()` in
`pi/src/tools/orchestrator/task-dispatcher.ts` is the background-policy source
of truth.

## Workflow at a glance

1. **Goal:** call `goal_contract_create`; every binary success criterion needs a
   runnable `verification_cmd`.
2. **DAG:** call `dag_synthesize`; cover every criterion, keep batches
   contiguous and acyclic, and use only `subagent-developer`,
   `subagent-auditor`, or `subagent-explore` task templates.
3. **Dispatch:** call `task_dispatch`, then invoke `Agent` in batch order and in
   parallel only when tasks share no mutable state.
4. **Audit:** collect per-task evidence and call `orchestrator_audit`. `PASS`
   requires the minimum finding count and `workflowReady === true`; the tool
   enforces this gate.

State persists in `.pi/orchestrator/audit-state-{dag_id}.yaml` so work can
resume after context compaction.

## Key paths

- `.pi/orchestrator/goal-*.yaml`, `dag-*.yaml`, `audit-*.md` — workflow state
- `pi/src/extension.ts` — soft-mode wiring (`session_start`,
  `tool_call` classifier, `before_agent_start` system-prompt suffix)
- `pi/src/soft-mode.ts` — `SOFT_MODE_REMINDER` and
  `SOFT_MODE_SYSTEM_PROMPT_SUFFIX`
- `pi/src/tools/file-gate.ts` — `canMainAgentWrite()` path
  classifier (advisory under soft mode; no longer a blocking gate)
- `pi/src/tools/bash-guard.ts` — shell command classifier
  (`shouldBlockBashCommand` is advisory under soft mode; never blocks)
- `pi/src/tools/orchestrator/task-dispatcher.ts` — dispatch defaults
- `pi/src/tools/orchestrator/dag-synthesizer.ts` — task-template whitelist
- `pi/skills/orchestrator/SKILL.md` — full workflow reference
- `pi/templates/SUBAGENTS.md` — installed dispatch reference

The package map belongs in [README.md § Repository layout](README.md#repository-layout).

## Commit conventions

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/).
Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `chore`,
and `style`. Put goal IDs in a `Refs:` footer. Resolve author identity from
`git config user.name` and `git config user.email`; never use `--author`.
Do not commit ephemeral `.pi/` state.

## Verify gates

These gates run automatically via the pre-commit hook (`pi/typecheck` + `pi/test`) and must all pass before commit. Run them locally:

- `bun run typecheck` — pi typecheck
- `bun test ./src ./test` — pi unit + integration tests
- `bun run verify:catalog` — fails when any of the 5 catalogues under `pi/catalogs/` drift from their source files. Run after editing `pi/src/tools/orchestrator/*.ts` or `pi/templates/SUBAGENTS.md`.

If you change any source file listed in a catalog's `_source_files`, re-run `bun run gen:catalog` and commit the regenerated `pi/catalogs/*.json` along with the source change.

## Soft mode and task-count threshold

Under soft mode (GC-2026-031) nothing is mechanically blocked. The
recommendation mechanism is the **task-count threshold**:

- If your active `todowrite` has **>2 items**, the recommended pattern is
  the 4-stage DAG workflow (`goal_contract_create` → `dag_synthesize` →
  `task_dispatch` → `orchestrator_audit`) — or, equivalently, dispatching
  `developer` with managed-worktree isolation for production code. The
  TDD discipline, worktree isolation, and auditor evidence gate all
  pay off at this scale.
- If your active `todowrite` has **≤2 items**, direct handling with
  `edit` / `write` / `bash` in the main session is also acceptable.
  No DAG is required.

Drift from the recommended pattern is **auto-steered**: the bash-guard
classifier detects write-intent bash calls and the extension appends a
once-per-session system reminder via `pi.appendEntry("system",
SOFT_MODE_REMINDER)`. The reminder is goal-orientation — it nudges
back toward staying aligned with your goal — it does **not** flag
specific write actions as "production code". Drift is never blocked.

There is **no previous-enforcement toggle** (no hard-mode toggle,
no path gate). Soft mode is the only mode.

## Red lines

1. **Subagent dispatch is RECOMMENDED for >2-item workflows.** When your
   active `todowrite` has more than two items, prefer the 4-stage DAG
   workflow or dispatch `developer` with managed-worktree isolation
   (for production code) or `isolation: "current-workspace"` + `tdd:
   "none"` (for meta-file edits). The main agent may handle ≤2 tasks
   directly with `edit` / `write` / `bash`. The bash-guard is advisory
   under soft mode — no commands are blocked (including `rm` / `mv` /
   `cp` / `unlink` / `rmdir`).
2. **Never use `isolation: "worktree"`.** Use the explicit managed-worktree
   object or `"current-workspace"`.
3. **Never omit `developer` isolation.** Every developer dispatch must choose an
   explicit mode.
4. **Respect `.pi/orchestrator/` namespace ownership.** Subagents may write
   only their role-owned task report, handoff, or audit paths; they must not
   overwrite L3 workflow state.
5. **Avoid destructive git operations** such as path checkout, hard reset,
   clean, or force push. See `pi/templates/SUBAGENTS.md` § Git ops from main
   repo. Under soft mode these are no longer hard-blocked; dispatch
   `developer` for an audit trail on complex workflows.
6. **Never use an unregistered task template.** Only `subagent-developer`,
   `subagent-auditor`, and `subagent-explore` are valid.
7. **Never use an unregistered subagent type.** Valid types are `Explore`,
   `Plan`, `developer`, `auditor`, and `merger`.
8. **Never self-declare workflow `PASS`.** Supply findings and let
   `orchestrator_audit` apply the evidence gate.
9. **Never commit with `--no-verify`.** Repository hooks must run.
10. **Never claim a tool result that was not returned.** Retry or report the
    failure instead.

## `.pi/orchestrator/` namespace ownership

Subagents may write only their role-owned records: developers write
`task-{task_id}-report.md` and
`handoff/{workspace_id}/{task_id}-handoff.md`; auditors write
`audit-{task_id}.md`. L3 owns `goal-{id}.yaml`, DAG, audit-state, and workflow
rollup files. Cross-namespace overwrites are prohibited; Explore and Plan stay
read-only.

## Deep references

- **Subagent dispatch:** `pi/templates/SUBAGENTS.md`
- **Workflow:** `pi/skills/orchestrator/SKILL.md`
- **Brainstorming:** `pi/skills/brainstorming/SKILL.md`
- **Installed system prompt:** `pi/templates/SYSTEM.md`

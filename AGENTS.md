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
    a classifier under soft mode, not a gate. See "Soft mode and dag_threshold"
    below for the recommendation mechanism.
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

## Profiles

A **profile** is a named bundle that captures one coherent Sages
soft-mode policy (GC-2026-031) plus its dispatch + gate posture in a
single YAML file. Every profile declares:

- `subagents` — whitelist of subagent ids (must be a subset of
  `@sages/pi-subagents.KNOWN_SUBAGENT_IDS`; verified by
  `verifyProfileCrossConsistency`).
- `isolation_default` — the default isolation mode for
  workspace-using subagents (`none`, `current-workspace`, or
  `worktree`).
- `dag_threshold` — todo-item count at which the 4-stage DAG
  workflow is recommended (default 2; lower for stricter
  governance, ≥99 to effectively disable).
- `gate_suite` — which verifications the profile requires (e.g.
  `typecheck`, `test`, `verify:catalog`).
- `soft_mode_reminder` — string fired once per session on the
  first write-intent bash call.
- `soft_mode_system_prompt_suffix` — string appended to every
  system prompt.

The main-agent extension loads the active profile once at session
start via `loadProfile()` (in `pi/src/profile.ts`) and threads its
fields through `profile/applier.ts`. The dispatcher + DAG synthesizer
treat the whitelist as authoritative.

### The 1 built-in profile

GC-2026-069 collapsed the historical `light` / `audit-strict` /
`ci-only` variants — the conductor now uses `extensions.tools` to
filter capabilities, not separate profiles. The only built-in is:

- **`standard`** — full subagent roster
  (`[Explore, Plan, developer, auditor, merger, git-expert]`) with
  `current-workspace` isolation, `dag_threshold: 2`, and the
  `typecheck + test + verify:catalog` gate suite. The default when
  no override is present. Definition lives in
  `pi/profiles/standard.yaml`; the in-code `STANDARD_PROFILE`
  constant in `pi/src/profile.ts` is a fallback for partial installs.

### How to override

Write `~/.pi/profile.yaml` with the same schema as a built-in
profile, e.g.:

```yaml
id: my-override
description: Personal override; full audit gates
subagents: [Explore, Plan, developer, auditor, merger, git-expert]
isolation_default: worktree
dag_threshold: 1
gate_suite: [typecheck, test, verify:catalog]
soft_mode_reminder: ""
soft_mode_system_prompt_suffix: ""
```

`loadProfile()` reads it on startup; the built-in `standard`
profile is the fallback when no home-level override is present.

## Institutional knowledge

Sages accumulates two kinds of durable artifacts as the L3
orchestrator resolves Goal Contracts: **cookbook** entries that
capture reusable recipes, and **postmortems** that capture lessons
from resolved GCs. Both are surfaced through `pi/docs/`, indexed
in `pi/docs/gc-index.md`, and gated by `bun run verify:gcdb` so
the discipline stays honest as the codebase grows.

### Cookbook

`pi/docs/cookbook/` holds recipes for repeated workflows — patterns
that came up across enough GCs to be worth a standalone write-up.
Each entry follows a fixed shape: **Problem → Solution → Code →
When to use → When NOT to use**. The format is rigid on purpose:
it forces the writer to articulate the negative space (what the
recipe is NOT for), which is the part new contributors get wrong
most often.

*Currently empty after the 2026-08-24 reset — entries will populate
as new GCs ship.*

### Postmortem

`pi/docs/postmortem/` holds write-ups from resolved Goal Contracts —
what broke, why, and how the fix sticks. Each entry follows:
**What happened → Root cause → Fix → Follow-ups**. Severity is
tagged in the frontmatter (`major`, `blocker`, `minor`) so future
readers can triage at a glance.

*Currently empty after the 2026-08-24 reset — entries will populate
as new GCs ship.*

### GC index

`pi/docs/gc-index.md` is the entry point that ties both surfaces
together. It is a markdown table of every Goal Contract ID the L3
orchestrator has ever merged, with a one-line title and a link to
the goal yaml at `.pi/orchestrator/goal-<id>.yaml`. The file is
generated by `bun run gen:gcdb` (run from `pi/`), which walks
`git log --all --grep='GC-'` so the index is automatically in sync
with the commit history. Run `--check` to verify the committed
index matches what `gen:gcdb` would produce today.

### Discipline

Every merged Goal Contract must have a postmortem OR be listed in
the carve-out section `## Open / no postmortem` of
`pi/docs/gc-index.md`. The carve-out is for GCs whose write-up has
been deliberately deferred (typically because the fix is a strict
contraction with no follow-ups worth documenting) — it is NOT a
to-do list. `bun run verify:gcdb` enforces the discipline
mechanically by walking `.pi/orchestrator/goal-GC-*.yaml` and
flagging any id that has neither postmortem nor carve-out.

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

Sages exposes a layered set of verifiers that run via `bun run <gate>`.
A `check:all` aggregator wires them into one entry point for CI.

| Gate | Command | Catches |
|---|---|---|
| Type check | `bun run typecheck` | Type errors anywhere |
| Unit suite | `bun test ./src ./test` | Behavior regression |
| Catalog | `bun run verify:catalog` | Drift between source + `.pi/orchestrator/catalogs/*.json` |
| Subagent roster | `bun run verify:subagent-roster` | @sages/pi-subagents.KNOWN_SUBAGENT_IDS ⊄ SUBAGENTS.md table ⊄ dag-synthesizer known roles |
| Isolation modes | `bun run verify:isolation-modes` | Literal `isolation: "worktree"` (forbidden) |
| Namespace ownership | `bun run verify:namespace-ownership` | Subagent templates declaring `.pi/orchestrator/...` in files[] |
| Soft-mode mental model | `bun run verify:soft-mode-mental-model` | Docs "soft mode" mentions vs `pi/src/soft-mode.ts` exports |
| **All** | `bun run check:all` | Runs every gate above; CI single entry point |

The pre-commit hook (`pi/typecheck` + `pi/test`) still runs automatically and must pass before commit. Run the rest locally:

- `bun run typecheck` — pi typecheck
- `bun test ./src ./test` — pi unit + integration tests
- `bun run verify:catalog` — fails when any of the 5 catalogues under `pi/catalogs/` drift from their source files. Run after editing `pi/src/tools/orchestrator/*.ts` or `pi/templates/SUBAGENTS.md`.
- `bun run verify:subagent-roster` — fails when `@sages/pi-subagents.KNOWN_SUBAGENT_IDS` diverge from the roster table in `pi/templates/SUBAGENTS.md` or from the known-roles set inside `pi/src/tools/orchestrator/dag-synthesizer.ts`.
- `bun run verify:isolation-modes` — fails when any subagent template or worker dispatch uses the literal `isolation: "worktree"` token. Use the explicit managed-worktree object or `"current-workspace"`.
- `bun run verify:namespace-ownership` — fails when a subagent template declares a `.pi/orchestrator/...` path inside its `files[]` allow-list (cross-namespace overwrites).
- `bun run verify:soft-mode-mental-model` — fails when docs references to "soft mode" drift from the exports / reminder / suffix strings in `pi/src/soft-mode.ts`.
- `bun run check:all` — runs every gate above in sequence; exits non-zero on first failure. Use this as the single entry point in CI.

If you change any source file listed in a catalog's `_source_files`, re-run `bun run gen:catalog` and commit the regenerated `pi/catalogs/*.json` along with the source change.

## Soft mode and dag_threshold

Under soft mode (GC-2026-031) nothing is mechanically blocked. The
recommendation mechanism is the profile-driven **dag_threshold**:

- If your active `todowrite` has **>2 items** (the standard profile's
  `dag_threshold: 2`), the recommended pattern is
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

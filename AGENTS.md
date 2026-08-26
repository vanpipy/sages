# Sages — Agent Operational Guide

> **Audience:** an LLM working in the Sages monorepo. This is the operational
> contract to read at session start. For the human-facing overview, see
> [README.md](README.md).

## What you are

You are the **orchestrator**: the brain, not the implementation limb. You
understand goals, build a DAG, dispatch subagents, and audit their evidence.
Three guiding principles govern the work (soft mode — GC-2026-031):

1. **Soft mode: full tool access by default.** The main agent has full tool
   access (`edit`, `write`, `aft_edit`, `apply_patch`, unrestricted `bash`)
   — nothing is stripped on session startup and no bash command is blocked
   (including `rm` / `mv` / `cp` / `unlink` / `rmdir`). The bash-guard is
    a classifier under soft mode, not a gate. See "Soft mode and dag_threshold"
    below for the recommendation mechanism.
2. **Production code uses managed-worktree dispatch.** RECOMMENDED for
   `src/`, `test/`, `lib/`, every `pi-*/` subpackage
   (pi-orchestrator, pi-subagents, pi-codebase-memory, pi-evaluator),
   or any root source file: dispatch `developer` with
   `isolation: { dag_id, task_id, mode: "create" }` and use TDD. For ≤2-item
   workflows direct editing is also acceptable.
3. **Root meta-files use current-workspace dispatch (lightweight).** For
   root-level docs and config (`.pi/orchestrator/*`, `.pi/agents/*`,
   `.claude/`, `.codex/`, root `README.md`, `AGENTS.md`, `package.json`,
   `tsconfig*.json`, `.gitignore`, `.aft.jsonc`), dispatch `developer` with
   `isolation: "current-workspace"` and `tdd: "none"`; review the diff before
   committing. Direct editing in the main session is also acceptable for
   ≤2-item workflows. **Every Sages package subtree (every `pi-*/`)
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
`pi/templates/agent-tool-description.md`, installed as
`~/.pi/agent/agent-tool-description.md` (the LLM-visible Agent tool
description). `defaultRunInBackground()` in
`pi/src/tools/orchestrator/task-dispatcher.ts` is the background-policy source
of truth.

## Profiles

> **GC-2026-073:** the conductor (`./pi/`) and its profile mechanism
> (yaml + 4-segment schema + applier.ts) are gone. The orchestrator's
> `extension.ts` absorbs the conductor's three hooks directly
> (`session_start` calls `setActiveTools([...])`, `before_agent_start`
> reads `templates/SYSTEM.md`, `tool_call` fires the once-per-session
> soft-mode reminder). User customizations move to pi-native primitives:
> `~/.pi/agent/SYSTEM.md` (main-agent prompt),
> `~/.pi/agent/agents/*.md` (per-subagent overrides via `AgentConfig`),
> `/model` and `/thinking` runtime commands, and
> `~/.pi/agent/settings.json#packages` for extension inclusion.

## Institutional knowledge

Sages accumulates two kinds of durable artifacts as the
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
together. It is a markdown table of every Goal Contract ID the
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
- `pi-orchestrator/src/extension.ts` — orchestrator entrypoint
  (default export wires `registerOrchestratorTools` + the three
  session hooks: `session_start` `setActiveTools`, `before_agent_start`
  prompt overlay, `tool_call` once-per-session soft-mode reminder)
- `pi-orchestrator/src/orchestrator-advisory.ts` — orchestrator advisory
  pipeline (pre-tool blocker + history tracker + error tracker +
  assistant-text tracker)
- `pi-orchestrator/src/goal-contract.ts`, `dag-synthesizer.ts`,
  `task-dispatcher.ts`, `orchestrator-audit.ts`, `sages-reminder.ts`
  — the 5 LLM-callable tools
- `pi-orchestrator/src/bash-guard.ts` — shell command classifier
  (`shouldBlockBashCommand` is advisory under soft mode; never blocks)
- `pi-orchestrator/skills/orchestrator/SKILL.md` — full workflow reference
- `pi-orchestrator/templates/agent-tool-description.md` — Agent tool
  description template (LLM-visible after install)

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
| Unit suite | `bun test ./test` | Behavior regression |
| Catalog | `bun run verify:catalog` | Drift between source + `.pi/orchestrator/catalogs/*.json` |
| Isolation modes | `bun run verify:isolation-modes` | Literal `isolation: "worktree"` (forbidden) |
| Namespace ownership | `bun run verify:namespace-ownership` | Subagent templates declaring `.pi/orchestrator/...` in files[] |
| Soft-mode mental model | `bun run verify:soft-mode-mental-model` | Docs "soft mode" mentions vs `src/extension.ts` reminder wiring |
| **All** | `bun run check:all` | Runs every gate above; CI single entry point |

GC-2026-069 retired `verify:subagent-roster` alongside `pi/templates/SUBAGENTS.md` — the roster table it parsed is no longer installed to user machines and the LLM-facing roster comes from `pi/templates/agent-tool-description.md`'s `{{typeList}}` template rendering (sourced from `pi-subagents/src/default-agents.ts`).

The pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`) still runs automatically and must pass before commit. Run the rest locally from `pi-orchestrator/`:

- `bun run typecheck` — orchestrator typecheck
- `bun test ./test` — orchestrator unit + integration tests
- `bun run verify:catalog` — fails when any of the 5 catalogues under `pi-orchestrator/catalogs/` drift from their source files. Run after editing `pi-orchestrator/src/*.ts` or `pi-orchestrator/templates/agent-tool-description.md`.
- `bun run verify:isolation-modes` — fails when any subagent template or worker dispatch uses the literal `isolation: "worktree"` token. Use the explicit managed-worktree object or `"current-workspace"`.
- `bun run verify:namespace-ownership` — fails when a subagent template declares a `.pi/orchestrator/...` path inside its `files[]` allow-list (cross-namespace overwrites).
- `bun run verify:soft-mode-mental-model` — fails when docs references to "soft mode" drift from the `SOFT_MODE_REMINDER` constant + `pi.on("tool_call")` wiring in `pi-orchestrator/src/extension.ts`.

If you change any source file listed in a catalog's `_source_files`, re-run `bun run gen:catalog` and commit the regenerated `pi-orchestrator/catalogs/*.json` along with the source change.

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
   overwrite orchestrator workflow state.
5. **Avoid destructive git operations** such as path checkout, hard reset,
   clean, or force push. Under soft mode these are no longer hard-blocked;
   dispatch `developer` for an audit trail on complex workflows.
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
`audit-{task_id}.md`. The orchestrator owns `goal-{id}.yaml`, DAG, audit-state, and workflow
rollup files. Cross-namespace overwrites are prohibited; Explore and Plan stay
read-only.

## Deep references

- **Subagent dispatch + Agent tool description:** `pi-orchestrator/templates/agent-tool-description.md`
- **Workflow:** `pi-orchestrator/skills/orchestrator/SKILL.md`
- **Brainstorming:** `pi-orchestrator/skills/brainstorming/SKILL.md`
- **Installed system prompt:** `pi-orchestrator/templates/SYSTEM.md`

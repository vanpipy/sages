# GC-2026-path-B-field-renames — Postmortem

**Severity:** major
**Resolved:** 2026-10-01
**Goal yaml:** [.pi/orchestrator/goal-GC-2026-path-B-field-renames.yaml](../../.pi/orchestrator/goal-GC-2026-path-B-field-renames.yaml)
**Branch:** `gc-2026-path-B-field-renames`

## What happened

Two name-collision / semantic-clarity renames deferred from the
post-path-B audit, landed as one GC:

- **M15**: `ManagedWorktreeRequest.dag_id` → `goal_id` (with compat
  shim) — the LLM-facing API field name was a path-A artifact; the
  semantic in path B is goal_id (the orchestrator has no DAG concept).
- **M12**: personal `todowrite` / `todowrite_progress` →
  `agent_todowrite` / `agent_todowrite_progress` — disambiguates from
  the orchestrator's deleted DAG-view todowrite tools of the same name.

Both landed as commits on the `gc-2026-path-B-field-renames` branch
and merged via a single merge commit. No new tools added; the only
runtime change is the optional `dag_id` field on
`ManagedWorktreeRequest` (deprecated, accepted as compat shim).

## Root cause

Two compounding issues from the path A → path B migration:

1. **Field-name lag in worktree-contract.** Path B's semantic is
   `goal_id` but the field name `dag_id` predates path B. The
   orchestrator's workflow_run handler still passes `dag_id: goalId`
   (the value is correct, the name is historical). LLMs learning the
   API saw `dag_id` and would form a mental model of "DAG" that doesn't
   exist anymore.

2. **Tool-name collision with deleted orchestrator tools.** The
   personal todowrite was registered as `todowrite` /
   `todowrite_progress` — the exact same names as the orchestrator's
   DAG-view `todowrite_compile` / `todowrite_progress` (deleted in
   GC-2026-orchestrator-simplify). Different storage, different
   purpose; same name was a documentation landmine for new
   contributors.

## Fix

**M15 — ManagedWorktreeRequest.dag_id → goal_id (compat shim):**

- `worktree-contract.ts`: Interface field renamed to `goal_id`; `dag_id`
  kept as deprecated optional alias. TypeBox schema marks `goal_id`
  required, `dag_id` optional. `parseManagedWorktreeRequest` accepts
  `goal_id` OR `dag_id` (but not both — either-or-neither is rejected).
- `worktree.ts`, `worktree-lease.ts`, `agent-manager.ts`,
  `index.ts`, `types.ts`, `diagnostic.ts`, `failure-catalog.ts`:
  internal usage updated to `goal_id` / `goalId`.
- `default-agents.ts`: restored DEVELOPER_AGENT map entry + extracted
  PLAN_AGENT as a top-level const; the prior `--theirs` merge had
  collapsed 5 entries to 3.
- All worktree + diagnostic + dev-prompt tests updated.

**M12 — personal todowrite → agent_todowrite:**

- `personal-todowrite-tool.ts`: tool names `todowrite` →
  `agent_todowrite`, `todowrite_progress` → `agent_todowrite_progress`.
  Description strings + storage path updated.
- `agent-types.ts`: BUILTIN_TOOL_NAMES list updated.
- `developer.ts` (developer prompt): Tool preference order item 4
  renamed; description explains the `agent_` prefix.
- Test files updated.

## Migration strategy: hard rename vs compat shim

M15 uses a **compat shim** (accept `dag_id` for one release, remove
in follow-up). M12 uses a **hard rename** (no compat shim).

The two had different risk profiles:

- M15 touches a **public, parser-mediated API** that every dispatcher
  passes. A hard rename would break every existing LLM session that
  learned the old name. The compat shim costs one extra
  `obj.dag_id ?? obj.goal_id` branch in the parser; it's cheap.
- M12 touches tool names that were effectively dead — the
  orchestrator's DAG-view todowrite was deleted in
  GC-2026-orchestrator-simplify, so no live code referenced the
  colliding name. The personal todowrite's prompt instructions said
  "this is the per-agent tracker; orchestrator's is separate", but
  the names themselves were identical. Anyone with a stale reference
  will see a clear runtime error.

## Follow-ups

- **M15 follow-up**: remove the `dag_id` compat shim in
  `parseManagedWorktreeRequest` and `MANAGED_WORKTREE_REQUEST_TYPE`
  (one release after M15 ships). Track via `// TODO: GC-2026-...`
  comment in `worktree-contract.ts`.
- **M12 follow-up**: none needed.
- **Additional work**: also complete `gc-2026-path-B-cleanups` (the
  orphan templates `templates/dag/*.yaml` and `subagent-auditor.md`
  template, plus the `pi-evaluator` rewrite) — these were deferred
  earlier and are still open.

## Lessons

1. **API field renames always need a migration strategy.** Hard renames
   break consumers silently; compat shims buy one release. The
   decision matrix: API surface? yes → compat shim; internal
   surface? → hard rename. M15's `ManagedWorktreeRequest` is the LLM-
   facing API surface; M12's tool names are internal (no LLMs learned
   the orchestrator variant because it was deleted).

2. **The `--theirs` merge strategy that resolved my git stash pop
   conflict dropped 2 of the 5 `DEFAULT_AGENTS` map entries.** I had to
   restore `DEVELOPER_AGENT` and extract `PLAN_AGENT` as a top-level
   const. Lesson: `--theirs` is a sledgehammer; prefer targeted
   resolution when the conflict is small.

3. **Backtick escape rules in template literals matter.** When
   editing a TypeScript template literal (`\`...\``) for embedded
   backticks, the inner content must use `\`` (literal backslash +
   backtick) not bare backticks. I broke this once and had to restore
   from git. Always read the surrounding template literal structure
   before doing a string replace inside one.

4. **Test regex patterns are part of the public contract.** The
   developer-prompt test pinned the tool-preference-order regex
   against `todowrite`. Updating the tool name required updating the
   test regex — easy to miss if you only focus on the source.

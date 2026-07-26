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

## Agent Roster

| Stage | `subagent_type`     | Source                              | Tools                | Purpose                                                                |
|-------|----------------------|--------------------------------------|----------------------|------------------------------------------------------------------------|
| 1     | `Explore`            | pi-subagents built-in                | read, bash, grep, find, ls | Fast codebase search. Haiku — cheap, fast, **read-only**.        |
| 2     | `Plan`               | pi-subagents built-in                | read, bash, grep, find, ls | Software architect. Sonnet. **Read-only** — returns a step-by-step plan, never edits. |
| 3     | `developer`         | **shipped** (pi-subagents built-in) | read, bash, grep, find, ls, edit, write | Strict TDD implementer. Sonnet + high thinking. Host-managed worktree. |
| 4     | `software-auditor`   | **shipped** (this repo)              | read, bash, grep, find, ls, aft_* | Evidence-based certifier. **Read-only** — re-runs commands, never modifies production code. |

**3 built-ins + 2 shipped.** The 3 built-ins (`Explore`, `Plan`,
`general-purpose`) come from `@tintinweb/pi-subagents`. The 2 custom
(`developer`, `software-auditor`) are installed by sages (`software-developer` is a Phase A alias)
from `pi/templates/agents/` to `~/.pi/agent/agents/`. Don't re-ship
`Explore` / `Plan` — overriding with a project-specific copy brings
no behaviour change. Override them only when project-specific rules
are needed (drop a `.md` of the same name into `agents/`).

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

### Stage 2 — Design (`Plan`)

```ts
Agent({
  subagent_type: "Plan",
  prompt: "Design a plan to add a `--dry-run` flag to pi/scripts/install.sh. " +
          "The flag should: skip all side effects, but still validate " +
          "templates and report what WOULD happen.",
  description: "Plan --dry-run flag",
})
```

**Returns**: ordered steps + critical files list. Never edits.

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
when branch deletion is intended. Subagents must never write
`.pi/orchestrator/`.

**Returns**: file paths changed + test output + verification evidence.

### Stage 4 — Verify (`software-auditor`)

`software-auditor` runs in the **background by default** (verifies the whole diff, can be steered to add new SCs — same canonical rule via `task-dispatcher.ts:defaultRunInBackground()`).

```ts
Agent({
  subagent_type: "software-auditor",
  prompt: "Audit the implementer's report at .pi/orchestrator/task-T3-report.md. " +
          "Re-run every verification_cmd from the task prompt. " +
          "Inspect git diff in <worktree-path>. " +
          "Write your report to .pi/orchestrator/audit-T3.md.",
  description: "Audit T3",
  run_in_background: true,
})
```

**Returns**: `CERTIFIED | NEEDS WORK | BLOCKED` + evidence-based report.

### Sidecar: `general-purpose` (lightweight helper, no worktree)

`general-purpose` is the main agent's **fallback helper** for
small/lightweight tasks that don't justify a worktree. The main
agent uses it to edit meta-files (AGENTS.md, README.md, install
scripts, test files, ...) directly in the dispatcher's cwd —
**no isolation, no worktree, no commit by the subagent** (the
main agent reviews the diff and commits if good).

```ts
Agent({
  subagent_type: "general-purpose",
  prompt: "Edit pi/scripts/install.sh to rename the function " +
          "backup_legacy_developer_template to backup_legacy_developer. " +
          "Read the file first, then make the edit. Report the diff.",
  description: "Rename function in install.sh",
  // NO isolation — operates in dispatcher's cwd
  run_in_background: true,
})
```

When to use:
- **Meta-file edits** (orchestrator has no direct write tool for
  AGENTS.md / README.md / install scripts / test files / ...)
- **Ad-hoc fixes** (typo, config tweak, "look up this symbol")
- **Help from other subagents** (a `developer` running in a
  worktree can dispatch `general-purpose` for an assist; the
  helper runs in the developer's worktree cwd)

When NOT to use:
- **Production code** — dispatch `developer` with managed
  worktree (TDD + audit gate)
- **Substantial work** — `general-purpose` doesn't enforce TDD;
  for anything with verification, prefer `developer`

The `general-purpose` agent has `tools: ["*"]` and `extensions: true`
in `pi-subagents/src/default-agents.ts:58-74`, so it can use any
tool. But it inherits the bash-guard from the dispatcher's cwd —
`canMainAgentWrite()` still applies, so production-code writes
are blocked even via `general-purpose` bash.

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
    subagent_type: software-auditor
    batch: 4
    depends_on: [I1]
    prompt: "Certify I1: re-run install.test.sh, inspect worktree diff"
```

Each stage gates the next via `depends_on`. The DAG's `batch: N`
field encodes dependency order — for parallel work, multiple tasks
share a batch number.

## Related

- **Workflow** (when to dispatch what, how to chain stages): `pi/skills/orchestrator/SKILL.md`
- **Agent identity** (tools, isolation, output format): `~/.pi/agent/agents/<name>.md`
- **Background policy** (which `run_in_background` for which type): `pi/src/tools/orchestrator/task-dispatcher.ts:defaultRunInBackground()`
- **Agent tool description** (text shown to the main agent for the `Agent` tool): `pi/templates/agent-tool-description.md`
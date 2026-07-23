# Subagent Pipeline — Four Agents, One Workflow

The pi-subagents ecosystem, combined with sages' orchestrator, gives you a
**four-stage DAG** for any non-trivial task:

```
┌─────────┐     ┌──────┐     ┌────────────────────┐     ┌────────────────────┐
│ Stage 1 │ ──▶ │  S2  │ ──▶ │       Stage 3      │ ──▶ │       Stage 4      │
│ Explore │     │ Plan │     │ software-developer │     │ software-auditor   │
│ (find)  │     │(design)   │    (RED→GREEN→REFACTOR)  │   (evidence verify) │
└─────────┘     └──────┘     └────────────────────┘     └────────────────────┘
   read-only      read-only        worktree + edit             read-only
   haiku          sonnet           sonnet + thinking           sonnet + thinking
```

Each agent has a single responsibility and a constrained tool set, so the
orchestrator stays small and the audit trail stays clean.

## Agent Roster

| Stage | `subagent_type`     | Source                              | Tools                | Purpose                                                                |
|-------|----------------------|--------------------------------------|----------------------|------------------------------------------------------------------------|
| 1     | `Explore`            | **pi-subagents built-in** (always available) | read, bash, grep, find, ls | Fast codebase search. Haiku model — cheap, fast, **read-only**.        |
| 2     | `Plan`               | **pi-subagents built-in** (always available) | read, bash, grep, find, ls | Software architect. Sonnet. **Read-only** — returns a step-by-step plan, never edits. |
| 3     | `software-developer` | **shipped** (this repo)              | read, bash, grep, find, ls, edit, write | Strict TDD implementer. Sonnet + high thinking. `isolation: worktree`. |
| 4     | `software-auditor`   | **shipped** (this repo)              | read, bash, grep, find, ls, aft_* | Evidence-based certifier. **Read-only** — re-runs commands, never modifies production code. |

The 3 built-ins (`Explore`, `Plan`, `general-purpose`) come from
`@tintinweb/pi-subagents`. The 2 custom (`software-developer`,
`software-auditor`) are installed by `pi/scripts/install.sh` from
`pi/templates/agents/` to `~/.pi/agent/agents/`.

> **Why only 2 shipped?** Re-shipping `Explore`/`Plan` would override useful
> defaults with no behaviour change. Override them only if you need
> project-specific exploration/planning rules — drop a `.md` of the same
> name into `~/.pi/agent/agents/` (project override pattern).

## Stage 1 — Research (Explore)

Use `Explore` when you need to *find* something. The orchestrator should
delegate instead of running `aft_search` / `grep` inline.

```ts
Agent({
  subagent_type: "Explore",
  prompt: "Find all places in pi/src/ that import luban_execute_task. " +
          "Report file paths, line numbers, and a one-line context for each.",
  description: "Find luban call sites",
})
```

**Returns**: file/line list + 1-line context. Never edits.

## Stage 2 — Design (Plan)

Use `Plan` when you have research results and need an *implementation
strategy*. Output is a step-by-step plan with `Critical Files for
Implementation`.

```ts
Agent({
  subagent_type: "Plan",
  prompt: "Design a plan to add a `--dry-run` flag to pi/scripts/install.sh. " +
          "The flag should: skip all side effects (settings.json writes, " +
          "package.json creation, system prompt copy), but still validate " +
          "templates and report what WOULD happen. Read pi/scripts/install.sh " +
          "first to understand the structure.",
  description: "Plan --dry-run flag",
})
```

**Returns**: ordered steps + critical files list. Never edits.

## Stage 3 — Implement (software-developer)

Use `software-developer` per implementation task. Always in worktree
isolation. Always with a verification command in the prompt.

```ts
Agent({
  subagent_type: "software-developer",
  prompt: "RED: write a failing test in pi/test/install.test.sh named " +
          "'install_subagents_doc creates SUBAGENTS.md when missing'. " +
          "GREEN: implement install_subagents_doc() in pi/scripts/install.sh " +
          "and call it from install(). REFACTOR: tighten idempotency. " +
          "Verification: `bash pi/test/install.test.sh` passes.",
  description: "Implement install_subagents_doc",
  isolation: "worktree",
})
```

**Returns**: file paths changed + test output + verification evidence.

## Stage 4 — Verify (software-auditor)

Use `software-auditor` to certify Stage 3's work. Audit is **independent**
of the implementer — fresh model/eyes re-run every verification command.

```ts
Agent({
  subagent_type: "software-auditor",
  prompt: "Audit task T3 against AC: SC1 = bash pi/test/install.test.sh " +
          "exits 0 and reports all green. SC2 = install_subagents_doc is " +
          "called from install(). " +
          "Re-run all verification_cmd from the task prompt. " +
          "Inspect git diff in <worktree-path>. " +
          "Write report to .pi/orchestrator/T3-audit.md.",
  description: "Audit install_subagents_doc",
})
```

**Returns**: `CERTIFIED | NEEDS WORK | BLOCKED` + evidence-based report.

## Composing the Pipeline

The orchestrator stitches all four into a DAG:

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
    subagent_type: software-developer
    batch: 3
    depends_on: [D1]
    isolation: worktree
    prompt: "Implement per the plan: RED→GREEN→REFACTOR for install_subagents_doc"
  - id: V1     # Stage 4
    subagent_type: software-auditor
    batch: 4
    depends_on: [I1]
    prompt: "Certify I1: re-run install.test.sh, inspect worktree diff"
```

Each stage gates the next via `depends_on`. Stage 4's verdict decides whether
the DAG ends in `PASS` (merge) or loops back to Stage 3 (revise) /
Stage 2 (replan).

## When to Skip Stages

- **Single trivial edit** (one-line fix, single typo): skip the whole
  pipeline. Just edit directly.
- **Pure research question** ("where is X?"): Stage 1 only.
- **Architectural decision, no code change**: Stage 1 + Stage 2.
- **Refactor with existing plan**: skip Stage 1+2, dispatch Stage 3 directly.

## Related

- `~/.pi/agent/agents/software-developer.md` — full agent definition
- `~/.pi/agent/agents/software-auditor.md` — full agent definition
- `~/.pi/agent/agents/SUBAGENTS.md` — this file (installed by sages)
- pi-subagents built-in source: `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/src/default-agents.ts`
- Orchestrator skill: `pi/skills/orchestrator/SKILL.md` (4-stage DAG)

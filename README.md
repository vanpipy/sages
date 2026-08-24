# Sages

Multi-agent workflow system for [pi](https://pi.dev). Sages turns a goal into a
validated DAG, delegates implementation and verification to specialized agents,
and audits the result before declaring the workflow complete.

## How it works

```text
goal_contract_create → .pi/orchestrator/goal-{id}.yaml (with _lock_hash)
        ↓
dag_synthesize       → .pi/orchestrator/dag-{id}.yaml
        ↓
task_dispatch        → Agent-call plan (the main agent executes it;
        ↓               verdict gate blocks until latest audit ack'd)
developer / auditor  → /tmp/pi-subagents-.../tasks/<id>.output
        ↓
orchestrator_audit   → .pi/orchestrator/audit-workflow.md
        ↓
L1 advisory          → "[orchestrator audit advisory — N/M] <rule>: ..."
        ↓                 (mirrors L2 advisory; 5 rules, auto-injected
sages_reminder         on tool_call, dedup + cap + token-cap)
        ↓                 (LLM-callable tool that wraps pi.appendEntry
                          for system reminders; 6 types, per-type
                          fixdirectives, informational only)
```

### Self-feedback loop (GC-2026-053 / 054-058)

The 4-stage DAG workflow above is augmented with a **self-feedback
loop** so the orchestrator can detect and recover from its own
mistakes:

| Layer | Module | Purpose |
|---|---|---|
| L2 advisory | `pi-subagents/src/agent-runner.ts:advisoryFor` | Subagent message-text validator (5 rules, dedup + cap + token-cap) |
| L1 advisory | `pi/src/tools/orchestrator/l1-advisory.ts` | **NEW** — orchestrator tool-call history validator (5 rules, mirrors L2) |
| Reminder | `pi/src/tools/orchestrator/sages-reminder.ts` | **NEW** — LLM-callable bridge to `pi.appendEntry` (6 reminder types) |
| Verifier lint | `pi/src/tools/orchestrator/verification-cmd-linter.ts` | **NEW** — rejects placeholder `verification_cmd` (heuristics + execution probe) |
| Goal lock | `pi/src/tools/orchestrator/goal-lock.ts` | **NEW** — SHA-256 anti-cheat; detects silent SC modification |
| Verdict gate | `pi/src/tools/orchestrator/verdict-enforcement.ts` | **NEW** — machine-enforced gate: REVISE/REJECT blocks `task_dispatch` until acknowledged |

### Soft mode policy (GC-2026-031)

Under soft mode (GC-2026-031) the main agent has full tool access
(`edit` / `write` / `aft_edit` / `apply_patch`, plus unrestricted `bash`).
Nothing is mechanically blocked. The Sages extension owns the four
workflow tools above and a recommendation layer that nudges the main
agent toward the 4-stage DAG workflow for complex work (when the
active profile's `dag_threshold` is exceeded; default `2` items);
drift from the recommended pattern is auto-steered via a
once-per-session system reminder and never blocked. The main agent
decides whether to dispatch subagents based on its own task-count
assessment. `pi-subagents` owns agent spawning, managed worktrees,
background execution, and result collection.

## Quick start

```bash
# Install the orchestrator and subagent runtime
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash

# Open a pi session, then give the agent a goal, for example:
# "Add rate limiting to the login endpoint."
```

The agent guides the work through goal → DAG → dispatch → audit. Example goal
contracts live in `pi/skills/orchestrator/templates/goals/` and are installed to
`~/.pi/agent/goals/`.

## Repository layout

| Package | Purpose |
|---|---|
| `pi/` | Main orchestrator: four-tool workflow plus the soft-mode policy (`pi/src/soft-mode.ts`, `pi/src/extension.ts`) |
| `pi-subagents/` | Agent runtime: subagent lifecycle and managed worktrees |
| `pi-codebase-memory/` | Code knowledge graph MCP server |
| `pi-evaluator/` | Evaluation metrics for cost, security, and text quality |

## Where to learn more

- **Agent operational guide:** [AGENTS.md](AGENTS.md)
- **Subagent dispatch reference:** [`pi/templates/SUBAGENTS.md`](pi/templates/SUBAGENTS.md)
  (installed to `~/.pi/agent/SUBAGENTS.md`)
- **Workflow skill:** [`pi/skills/orchestrator/SKILL.md`](pi/skills/orchestrator/SKILL.md)

## `.pi/orchestrator/` namespace ownership

Developers may write `task-{task_id}-report.md` and
`handoff/{workspace_id}/{task_id}-handoff.md`; auditors may write
`audit-{task_id}.md`. L3 alone owns `goal-{id}.yaml` (with
`_lock_hash`), `dag-{id}.yaml`, `audit-state-{dag_id}.yaml`,
`verdict-state-{dag_id}.yaml` (GC-2026-058), and workflow rollup
files. Cross-namespace overwrites are prohibited; Explore and
Plan remain read-only.

## Security and license

Sages runs in **soft mode**: no commands are mechanically blocked and
the main agent has full tool access. The recommended pattern remains
the 4-stage DAG workflow (or, equivalently, dispatching `developer`
with a managed worktree) for production-code changes on workflows
with >2 items in the active todowrite — this keeps the audit trail,
TDD discipline, and worktree isolation that the orchestrator was
designed to provide. For ≤2-item workflows direct editing is also
acceptable. See [AGENTS.md § Red lines](AGENTS.md#red-lines) for the
remaining operational constraints.

`MIT` — see [LICENSE](LICENSE).

## History

Earlier versions used four role-named tools inspired by the four sages of
Chinese mythology, plus an FSM-style orchestrator. The current four-tool DAG
runtime replaced that design on 2026-07-24; migration notes live in
`pi/skills/audit-notes/`.

### Recent: orchestrator self-feedback (GC-2026-053 → 058, 2026-08-20)

Five GCs in one session, in order:

1. **GC-2026-053** — L1 advisory mirror + `sages_reminder` tool + 3
   routine templates + smoke test (4 commits, +906 tests)
2. **GC-2026-054** — Postmortem for GC-2026-053 + `gen-gcdb` body-scan
   fix (drift detection, 5 previously-missed GCs now appear)
3. **GC-2026-055** — Routine auto-install on `session_start` +
   per-type `SAGES_REMINDER_FIXDIRECTIVES` + cleanup of 2 pre-existing
   `dag_threshold` mental-model WARNs in `AGENTS.md` / `SUBAGENTS.md`
4. **GC-2026-056** — `verification_cmd` linter (heuristics + execution
   probe; rejects placeholders like `echo yes`, `pwd`, `true`)
5. **GC-2026-057** — Goal lock (SHA-256 anti-cheat; detects silent
   SC modification after the goal is created)
6. **GC-2026-058** — Verdict enforcement (machine-enforced gate;
   REVISE/REJECT blocks `task_dispatch` until acknowledged)

Together: 6 new modules, 236 new tests (790 → 1026), 5 new
postmortems, 6 new feature branches all merged to main.

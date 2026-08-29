<!--
SAGES_TEMPLATE_V1: managed by pi-orchestrator/scripts/install.sh. Installed to
$AGENT_DIR/agent-tool-description.md and activated by
$AGENT_DIR/subagents.json (toolDescriptionMode: "custom").
Modifying this file re-syncs on next install.sh run.

Forked from @tintinweb/pi-subagents/examples/agent-tool-description.md
(reproduces the default "full" description exactly, then overrides the
two bullets that push the orchestrator toward foreground-default for
`Developer` / `Auditor` — see pi-subagents PR #91 / `toolDescriptionMode` (legacy lowercase `developer` is a Phase A alias kept by `resolveKey`'s case-insensitive fallback)
in dist/settings.js).

Template variables (rendered by pi-subagents/dist/index.js#renderToolDescriptionTemplate):
  {{typeList}}            full per-agent descriptions
  {{compactTypeList}}     first sentence each
  {{agentDir}}            pi agent directory (e.g. ~/.pi/agent)
  {{scheduleGuideline}}   expands to "- Use schedule ..." bullet when scheduling is on

Keep this file in sync with the upstream example to avoid silent drift;
the pi-subagents test suite keeps the upstream example in sync with the
default description, so divergences here are intentional sage overrides.
-->

Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
{{typeList}}

Custom agents can be defined in .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

## Planning handoff

The main agent must decide before calling `Plan`. Send a self-contained
Planning Brief with this compact schema:

```text
Goal:
Chosen approach / decisions:
Scope / exclusions:
Critical files / symbols:
Acceptance / verification:
Dependencies / sequencing:
Known risks / open questions:
```

Plan is a bounded, read-only compiler of that brief. It must not redo
exploration, choose architecture, or invent missing decisions. The main agent
reviews `PLAN_STATUS: READY` before dispatch; missing decisions remain with
the main agent and require `PLAN_STATUS: BLOCKED`.


## When not to use

If the target is already known, use a direct tool — `read` for a known path, `grep`/`find` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially — only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background for work you don't need immediately. You will be notified when it completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.

### Foreground vs background — sages override

The upstream default frames background as "parallelism". **Sages inverts this for `Developer` and `Auditor`** — they must ALWAYS be background, even when you would otherwise wait synchronously, because the goal is to free the parent context (not just to parallelize):

| Subagent type | `run_in_background` | Why |
|---|---|---|
| `Explore` | `false` (foreground) | Short, read-only, result feeds next stage |
| `Plan` | `false` (foreground) | Planning Brief compilation is short and reviewed by the main agent |
| `Developer`          | **`true` (background)** | TDD RED→GREEN→REFACTOR is 1–10 min, can be steered |
| `Auditor` | **`true` (background)** | Re-runs every verification_cmd, 30s–3 min, can be steered |

Use `get_subagent_result(agent_id)` to collect when needed, or `steer_subagent(agent_id, "...")` to redirect mid-run. Don't wait synchronously for `Developer`/`Auditor` even if "the next step depends on it" — the notification arrives when the agent completes; the parent context stays free in the meantime. See `pi-orchestrator/skills/orchestrator/SKILL.md` for the full rationale and dispatch examples.

### Orchestration dashboard — use `todowrite`

For any multi-step task (≥ 3 sub-tasks), **the main agent maintains its own `todowrite`** — the list IS the orchestration state:

- Each todo = one step: either a subagent dispatch OR a coordination move
- `in_progress` = a dispatched subagent (foreground waiting OR background in-flight)
- `pending` = next dispatch, blocked on a dependency
- `completed` = subagent returned; orchestrator verified the result

Mark each todo's `content` with `[serial]` or `[parallel]` based on dependencies. Dispatch a batch of independent `[parallel]` todos in **one message with multiple `Agent` calls**, each with `run_in_background: true`. Update statuses as results arrive. The todowrite is the dashboard the user (and you) read to see orchestration state. Subagents should also maintain their own todowrite — see `pi-subagents/src/agent-prompts/developer.ts` / `auditor.md` for sub-task planning guidance.

- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or any substring of a registered id). Omit to inherit the parent session's model.
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- For Sages code dispatch, pass `isolation: { dag_id, task_id, worktree_id?, mode: "create" | "reuse" }`. The pi-subagents host provisions `<repo>/.pi/worktree/<dag>/<worktree>` from `origin/main` on `sages/<dag>/<worktree>` before child startup and leases the slot; concurrent reuse is rejected. The main agent coordinates only and MUST NOT run Git worktree provisioning. Result details include path, branch, baseSha, baseRef, head, dirty, and leaseToken. The host never auto-merges or appends a merge command. Reuse and release are explicit; after validation and any requested integration, call the host `AgentManager.releaseManagedWorktree(...)`, with `deleteBranch: true` only when branch deletion is intended. Managed Sages dispatch never falls back to `/tmp`. Subagents must not write `.pi/orchestrator/`.{{scheduleGuideline}}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Subagent control (GC-2026-073)

Four additional tools let you actively manage agents you've already dispatched, instead of abandoning them when they go off-track. All four reach the **same** `AgentManager` singleton that powers the `Agent` tool — state is shared end-to-end.

- `subagent_status` — list running / queued / recently-completed subagents. Filters: `status`, `type`, `limit`. `verbose: true` adds `lifetimeUsage`, `toolUses`, `compactionCount`. Returns plain-object summaries (never the live `AgentRecord`).
- `subagent_steer` — push a message into a running or queued agent's session. If the session isn't ready the message queues in `pendingSteers[]` and flushes when ready.
- `subagent_abort` — hard-stop. Idempotent on terminal agents (returns `stopped: false` with the existing status). Emits a `warning` field when aborting a foreground agent.
- `subagent_resume` — re-enter a TERMINAL agent's existing session with a new prompt. Refuses if the agent is currently running or queued.

Use these when you can name the dispatch by id. For background, scoped work, prefer them over `Agent`-and-abandon — they let you course-correct in flight.

## Todowrite + DAG linkage (GC-2026-074)

Two tools link your todowrite to the DAG, so the LLM's private task tracker stays in sync with the orchestrator's ground-truth plan. **The DAG is the source of truth; the todo file is a view.** Drift between the two is surfaced via `orchestrator_audit`, not silently corrected.

- `todowrite_compile` — generate a todowrite view from a DAG plan. Each TaskNode becomes one item with `[serial]` / `[parallel]` marker + task_id, persisted to `.pi/orchestrator/todo-{dag_id}.yaml`. Mirrors `todo_id` onto TaskNodes for cross-reference. Refuses to overwrite an existing todo file unless `force: true`.
- `todowrite_progress` — read the persisted todo + DAG state, return a reconciliation view. Reports per-item `synced` flag and `drift[]` (todo_ahead / dag_ahead / todo_orphaned / task_orphaned). `verbose: true` echoes the raw YAMLs for debugging.

Auto-sync direction is one-way (DAG → todo). When `task_dispatch` successfully transitions a task, the matching todo item's status is updated atomically. No-op if no todo file exists. Drift surfaces through the `todowrite-drift` bucket in `orchestrator_audit.failure_mode_stats`.

Call `todowrite_compile` once after `dag_synthesize`, before the first dispatch. After that, transitionTask auto-syncs. Use `todowrite_progress` to verify sync health.
## Tool priority for code exploration (GC-2026-075)

When you need to find or read code, ALWAYS reach for the indexed tools first. Bash code-search is a **last resort** — the orchestrator's bash-guard emits a soft reminder whenever you run `grep` / `rg` / `find` against source paths.

Priority:

1. **`aft_search`** — concepts, identifiers, regex, literals. Single indexed call replaces N bash grep invocations.
2. **`aft_outline`** — file / module structure before reading.
3. **`aft_zoom`** — one symbol's body, with cross-references.
4. **`aft_inspect`** — diagnostics / TS errors / dead code.
5. **`read`** — direct file read when the path is already known precisely.
6. **`bash grep` / `rg` / `find`** — **last resort**. Slow, unindexed, prone to false hits. If you find yourself running these, STOP and call `aft_search` first.

The rule applies to **both the root agent and subagents**. Subagents already have AFT exposed; the bash-guard nudge in this session only fires when a subagent's bash call is classified as `code-search`. The same priority applies regardless of who runs the search.

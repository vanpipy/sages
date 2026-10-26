<!--
    SAGES_TEMPLATE_V1: managed by pi-orchestrator/scripts/install.sh. Installed to
    $AGENT_DIR/agent-tool-description.md and activated by
    $AGENT_DIR/subagents.json (toolDescriptionMode: "custom").
    Modifying this file re-syncs on next install.sh run.

    Forked from @tintinweb/pi-subagents/examples/agent-tool-description.md
    (reproduces the default "full" description exactly, then overrides the
    two bullets that push the orchestrator toward foreground-default for
    `Developer` / `Reviewer` — see pi-subagents PR #91 / `toolDescriptionMode` (legacy lowercase `developer` is a Phase A alias kept by `resolveKey`'s case-insensitive fallback)
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

If you have defined a `PlanCompiler` agent, the main agent must decide before calling it. Send a self-contained Planning Brief with this compact schema:

```text
Goal:
Chosen approach / decisions:
Scope / exclusions:
Critical files / symbols:
Acceptance / verification:
Dependencies / sequencing:
Known risks / open questions:
```

`PlanCompiler` is a bounded, read-only compiler of that brief. It must not redo exploration, choose architecture, or invent missing decisions. The main agent reviews `PLAN_STATUS: READY` before dispatch; missing decisions remain with the main agent and require `PLAN_STATUS: BLOCKED`.

`PlanCompiler` is not a built-in agent type. It ships only if you defined it as a template (`.pi/agents/<name>.md` or {{agentDir}}/agents/<name>.md); if no such template exists, skip this section and plan inline.

## When not to use

If the target is already known, use a direct tool — `read` for a known path, `grep`/`find` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially — only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background for work you don't need immediately. You will be notified when it completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.
- For multi-step work, the orchestrator's own todowrite list is the orchestration dashboard. See `SYSTEM.md` §6.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or any substring of a registered id). Omit to inherit the parent session's model.
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- The `isolation` parameter and the rules for choosing it live in `SYSTEM.md` §7.{{scheduleGuideline}}

### Foreground vs background — sages override

The upstream default frames background as "parallelism". **Sages inverts this for `Developer` and `Reviewer`** — they should ALWAYS be background, even when you would otherwise wait synchronously, because the goal is to free the parent context (not just to parallelize):

| Subagent type | `run_in_background` | Why |
|---|---|---|
| `Explore` (user-defined, only if you defined one) | `false` (foreground) | Short, read-only, result feeds next stage |
| `PlanCompiler` (user-defined, only if you defined one) | `false` (foreground) | Planning Brief compilation is short and reviewed by the main agent |
| `Developer` | **`true` (background)** | TDD RED→GREEN→REFACTOR is 1–10 min, can be steered |
| `Reviewer` | **`true` (background)** | Reads the prior Developer's `metadata.result` and emits a 4-state verdict (`CLEAN` / `NEEDS_WORK` / `NEEDS_REDESIGN` / `NEEDS_CLARIFICATION`) as plain text in its own result, 30s–3 min, can be steered |

`Developer` and `Reviewer` ship with Sages. `Explore` and `PlanCompiler` are user-defined templates, so their rows apply only when you have defined one.

**This table is a prompt convention, not a runtime guarantee.** The runtime resolves `run_in_background` from the agent's own config first, then the call parameter, then the global default; no shipped agent config pins it, so an explicit `run_in_background: false` is honoured even for `Developer` / `Reviewer`. Treat the table as house style you are expected to follow, not as a rule the runtime enforces for you.

Use `get_subagent_result(agent_id)` to collect when needed, or `steer_subagent(agent_id, "...")` to redirect mid-run. Don't wait synchronously for `Developer`/`Reviewer` even if "the next step depends on it" — the notification arrives when the agent completes; the parent context stays free in the meantime. See `pi-orchestrator/skills/orchestrator/SKILL.md` for the full rationale and dispatch examples.

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Tool priority for code exploration (GC-2026-075)

When you need to find or read code, ALWAYS reach for the indexed tools first. Bash code-search is a **last resort** — slow, unindexed, and prone to false hits.

Priority:

1. **`aft_search`** — concepts, identifiers, regex, literals. Single indexed call replaces N bash grep invocations.
2. **`aft_outline`** — file / module structure before reading.
3. **`aft_zoom`** — one symbol's body, with cross-references.
4. **`aft_inspect`** — diagnostics / TS errors / dead code.
5. **`read`** — direct file read when the path is already known precisely.
6. **`bash grep` / `rg` / `find`** — **last resort**. Slow, unindexed, prone to false hits. If you find yourself running these, STOP and call `aft_search` first.

The rule applies to **both the root agent and subagents**. Subagents already have AFT exposed; the same priority applies regardless of who runs the search.

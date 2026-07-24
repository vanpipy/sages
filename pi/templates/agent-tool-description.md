<!--
SAGES_TEMPLATE_V1: managed by pi/scripts/install.sh. Installed to
$AGENT_DIR/agent-tool-description.md and activated by
$AGENT_DIR/subagents.json (toolDescriptionMode: "custom").
Modifying this file re-syncs on next install.sh run.

Forked from @tintinweb/pi-subagents/examples/agent-tool-description.md
(reproduces the default "full" description exactly, then overrides the
two bullets that push the orchestrator toward foreground-default for
software-developer/auditor — see pi-subagents PR #91 / `toolDescriptionMode`
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

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — `read` for a known path, `grep`/`find` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially — only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background for work you don't need immediately. You will be notified when it completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.

### Foreground vs background — sages override

The upstream default frames background as "parallelism". **Sages inverts this for `software-developer` and `software-auditor`** — they must ALWAYS be background, even when you would otherwise wait synchronously, because the goal is to free the parent context (not just to parallelize):

| Subagent type | `run_in_background` | Why |
|---|---|---|
| `Explore` | `false` (foreground) | Short, read-only, result feeds next stage |
| `Plan` | `false` (foreground) | Short, output is the next prompt |
| `software-developer` | **`true` (background)** | TDD RED→GREEN→REFACTOR is 1–10 min, can be steered |
| `software-auditor` | **`true` (background)** | Re-runs every verification_cmd, 30s–3 min, can be steered |

Use `get_subagent_result(agent_id)` to collect when needed, or `steer_subagent(agent_id, "...")` to redirect mid-run. Don't wait synchronously for software-developer/auditor even if "the next step depends on it" — the notification arrives when the agent completes; the parent context stays free in the meantime. See {{agentDir}}/SUBAGENTS.md for the full rationale and code examples.

### Orchestration dashboard — use `todowrite`

For any multi-step task (≥ 3 sub-tasks), **the main agent maintains its own `todowrite`** — the list IS the orchestration state:

- Each todo = one step: either a subagent dispatch OR a coordination move
- `in_progress` = a dispatched subagent (foreground waiting OR background in-flight)
- `pending` = next dispatch, blocked on a dependency
- `completed` = subagent returned; orchestrator verified the result

Mark each todo's `content` with `[serial]` or `[parallel]` based on dependencies. Dispatch a batch of independent `[parallel]` todos in **one message with multiple `Agent` calls**, each with `run_in_background: true`. Update statuses as results arrive. The todowrite is the dashboard the user (and you) read to see orchestration state. Subagents should also maintain their own todowrite — see `software-developer.md` / `software-auditor.md` for sub-task planning guidance.

- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.{{scheduleGuideline}}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
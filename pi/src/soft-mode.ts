/**
 * Soft mode — the Sages main-agent policy under GC-2026-031.
 *
 * Soft mode replaces the historical two-layer hard gate (Layer 1 +
 * Layer 2) with a single session-scoped reminder. The main agent has
 * full tool access (`edit` / `write` / `aft_edit` / `apply_patch` /
 * unrestricted `bash`). Subagent dispatch via the 4-stage DAG workflow
 * is RECOMMENDED but never required; drift from the recommended
 * pattern is auto-steered (a system reminder is appended via
 * `pi.appendEntry`), never blocked.
 *
 * This module exports the two reminder strings used by the extension:
 *   - SOFT_MODE_REMINDER: shown to the LLM once per session after the
 *     first write-intent bash call. Goal-orientation nudge — does NOT
 *     mention "you wrote production code" (per the user's
 *     GC-2026-031 directive: don't feedback the agent about specific
 *     write actions; just remind it to stay aligned with the goal).
 *   - SOFT_MODE_SYSTEM_PROMPT_SUFFIX: appended to the system prompt
 *     on every `before_agent_start` so the LLM knows the policy from
 *     the first turn.
 */

/** Goal-orientation reminder, fired once per session on first write-intent bash. */
export const SOFT_MODE_REMINDER = `
> ⚙️ **SOFT MODE — subagent dispatch recommended**
>
> If this is part of a larger workflow (>2 items in your active todowrite),
> consider dispatching via the 4-stage DAG workflow: goal → DAG → dispatch → audit.
> The developer / auditor / merger / git-expert pipeline is the recommended
> approach for complex multi-step work. For ≤2 tasks, direct handling is
> acceptable. This is a recommendation — the agent decides. No commands are
> blocked.
`;

/** Per-turn system-prompt suffix (soft mode policy description). */
export const SOFT_MODE_SYSTEM_PROMPT_SUFFIX = `
## Soft Mode (active)

You have full tool access — \`edit\`, \`write\`, \`aft_edit\`, \`apply_patch\`, and unrestricted \`bash\` (no commands are blocked, including \`rm\` / \`mv\` / \`cp\`).
Subagent dispatch via the 4-stage DAG workflow (goal → DAG → dispatch → audit) is **RECOMMENDED** but not required.
- For workflows with **>2 items** in your active todowrite, prefer the DAG workflow.
- For **≤2 items**, you may handle directly.

Recommended subagents (when complexity warrants):
- \`Explore\` — fast read-only search
- \`Plan\` — Planning Brief compilation (you write the brief; Plan compiles)
- \`developer\` — TDD implementation in a managed worktree (\`isolation: { dag_id, task_id, mode: "create" }\`)
- \`auditor\` — read-only evidence audit
- \`merger\` / \`git-expert\` — cross-workspace merge / git inspection

For meta-file edits and design-doc writes, dispatch \`developer\` with \`isolation: "current-workspace"\` + \`tdd: "none"\` (lightweight, no worktree).

Drift from the recommended pattern is auto-steered (a system reminder is appended); it is never blocked.
`;

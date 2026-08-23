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
 * As of GC-2026-049, the reminder + suffix strings are no longer
 * static module constants. They are fields on a `Profile` loaded by
 * `pi/src/profile.ts`. Use `softModeReminder(profile)` and
 * `softModeSystemPromptSuffix(profile)` to read them.
 *
 * Backward-compat shim: the historical `SOFT_MODE_REMINDER` and
 * `SOFT_MODE_SYSTEM_PROMPT_SUFFIX` constants are preserved at their
 * pre-GC-2026-049 values so legacy imports (notably
 * `test/tools/main-agent-toolset.test.ts`) continue to work. New code
 * MUST go through the profile functions.
 */

import type { Profile } from "./profile.js";

/** Goal-orientation reminder, fired once per session on first write-intent bash. */
export function softModeReminder(profile: Profile): string {
  return profile.soft_mode_reminder;
}

/** Per-turn system-prompt suffix (soft mode policy description). */
export function softModeSystemPromptSuffix(profile: Profile): string {
  return profile.soft_mode_system_prompt_suffix;
}

// ── Backward-compat shims ────────────────────────────────────────────
// Pre-GC-2026-049 callers (notably the soft-mode test suite) still
// import `SOFT_MODE_REMINDER` and `SOFT_MODE_SYSTEM_PROMPT_SUFFIX` as
// module-level constants. These exports preserve the historical
// `standard` profile's strings so the legacy test contract holds.
//
// @deprecated — new code should call `softModeReminder(profile)` /
// `softModeSystemPromptSuffix(profile)` instead. Will be removed once
// the legacy test imports are migrated.

/** @deprecated use `softModeReminder(profile)` instead. */
export const SOFT_MODE_REMINDER = `> ⚙️ **SOFT MODE — subagent dispatch recommended**
>
> If this is part of a larger workflow (>2 items in your active todo list),
> consider dispatching via the 4-stage DAG workflow: goal → DAG → dispatch → audit.
> The developer / auditor / merger / git-expert pipeline is the recommended
> approach for complex multi-step work. For ≤2 tasks, direct handling is
> acceptable. This is a recommendation — the agent decides. No commands are
> blocked.
`;

/** @deprecated use `softModeSystemPromptSuffix(profile)` instead. */
export const SOFT_MODE_SYSTEM_PROMPT_SUFFIX = `## Soft Mode (active)

You have full tool access — \`edit\`, \`write\`, \`aft_edit\`, \`apply_patch\`, and unrestricted \`bash\` (no commands are blocked, including \`rm\` / \`mv\` / \`cp\`).
Subagent dispatch via the 4-stage DAG workflow (goal → DAG → dispatch → audit) is **RECOMMENDED** but not required.
- For workflows with **>2 items** in your active todo list, prefer the DAG workflow.
- For **≤2 items**, you may handle directly.

### Todo management

- Use \`sages_todo({action: "sync", todos: [...]})\` to manage the session todo list. \`sages_todo\` is the only todo tool available to you; Magic Context's \`todowrite\` is disabled in Sages profiles.
- \`sages_todo({action: "get"})\` returns the current list + counts.
- \`sages_todo({action: "auto-plan", dag_id: "GC-XXXX"})\` derives batch-level todos from a synthesized DAG (after \`goal_contract_create\` + \`dag_synthesize\`).
- The Magic Context terminal overlay is still rendered — Sages drives it via the optional \`setTodoSnapshot\` integration, so your \`sages_todo\` calls surface live in the TUI.

Recommended subagents (when complexity warrants):
- \`Explore\` — fast read-only search
- \`Plan\` — Planning Brief compilation (you write the brief; Plan compiles)
- \`developer\` — TDD implementation in a managed worktree (\`isolation: { dag_id, task_id, mode: "create" }\`)
- \`auditor\` — read-only evidence audit
- \`merger\` / \`git-expert\` — cross-workspace merge / git inspection

For meta-file edits and design-doc writes, dispatch \`developer\` with \`isolation: "current-workspace"\` + \`tdd: "none"\` (lightweight, no worktree).

Drift from the recommended pattern is auto-steered (a system reminder is appended); it is never blocked.
`;
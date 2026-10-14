/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 *
 * Both the canonical `Developer` and `Reviewer` carry `COMMIT_CONVENTIONS_SECTION`
 * in their `systemPrompt`. The section is the single source of truth for the
 * Conventional Commits format *and* the Author derivation strategy
 * (try `git config` → fall back to `git log -1 --format='%an%n%ae'` → STOP if
 * still empty). The fallback chain matters because subagents are commonly
 * spawned in detached pi sessions / managed worktrees where `git config
 * user.{name,email}` returns empty — without the fallback, the subagent
 * either fabricates an author (audit failure) or fails to commit. The
 * section is shared byte-identically between Developer and Reviewer so both
 * prompts make the same guarantee; identity is pinned by
 * `test/commit-conventions-section.test.ts`.
 */

import { COMMIT_CONVENTIONS_SECTION } from "./agent-prompts/_sections/commit-conventions.js";
import type { AgentConfig } from "./types.js";

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "Developer",
    {
      name: "Developer",
      displayName: "Developer",
      description:
        "Implementation agent — makes the code changes a workflow requires. Drives the Implement phase (and any ad-hoc single-step coding task). Owns full access to read/write/edit files and execute commands. Use this when a phase in the orchestrator's task DAG (or a direct TaskCreate) has agentType \"Developer\".",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      extensions: true,
      skills: true,
      systemPrompt: COMMIT_CONVENTIONS_SECTION,
      promptMode: "append",
      isDefault: true,
    },
  ],
  [
    "Reviewer",
    {
      name: "Reviewer",
      displayName: "Reviewer",
      description:
        "Review agent — audits the diff a Developer produced and emits a 4-state verdict (CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION). Read-only by intent; the only file it writes is the verdict itself. Use this when a phase in the orchestrator's task DAG has agentType \"Reviewer\".",
      extensions: true,
      skills: true,
      systemPrompt: COMMIT_CONVENTIONS_SECTION,
      promptMode: "append",
      isDefault: true,
    },
  ],
]);

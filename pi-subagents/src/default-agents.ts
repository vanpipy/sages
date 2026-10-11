/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

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
      systemPrompt: "",
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
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
]);

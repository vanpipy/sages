/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import { DEVELOPER_PROMPT } from "./agent-prompts/developer.js";
import { EXPLORE_PROMPT } from "./agent-prompts/explore.js";
import { GENERAL_PURPOSE_PROMPT } from "./agent-prompts/general-purpose.js";
import { PLAN_PROMPT } from "./agent-prompts/plan.js";
import type { AgentConfig } from "./types.js";

/**
 * Required built-in tool names for the canonical `developer` agent.
 * Mirrors the seven built-ins `pi-coding-agent` exposes
 * (`createCodingTools` ∪ `createReadOnlyTools`).
 */
const DEVELOPER_BUILTIN_TOOLS: readonly string[] = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
];

/**
 * Canonical `developer` agent — Phase A P1 (DAG-2026-011).
 *
 * Migrated from pi/templates/agents/software-developer.md into
 * pi-subagents as a first-class built-in under the canonical name
 * `developer`. The legacy Sages name `software-developer` is preserved
 * as an alias (see `aliases` below) so existing orchestrators and
 * audit consumers keep working while the canonical migration lands.
 *
 * Phase B (out of scope here) will do the matching migration for the
 * `software-auditor` role.
 */
const DEVELOPER_AGENT: AgentConfig = {
	name: "developer",
	displayName: "Developer",
	description:
		"Production-grade software implementation agent following strict " +
		"test-driven development (TDD) discipline (RED → GREEN → REFACTOR). " +
		"The canonical replacement for the legacy Sages `software-developer` " +
		"role; the legacy name is preserved as an alias for backwards compatibility.",
	builtinToolNames: [...DEVELOPER_BUILTIN_TOOLS],
	extensions: ["aft", "pi-mcp-adapter", "pi-magic-context"],
	// Subagent isolation: even though `extensions:` is an explicit allowlist
	// (no `pi-subagents` entry) so the Agent tool cannot load by accident, we
	// pin `excludeExtensions: ["pi-subagents"]` to make the policy explicit and
	// survive any future loosening of the `extensions:` list.
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: DEVELOPER_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	// Developer tasks run RED → GREEN → REFACTOR cycles plus exploration, so 200
	// turns is the budget per individual run. Caller may still override via
	// Agent({ max_turns: ... }) at spawn time.
	maxTurns: 200,
	aliases: ["software-developer"],
};

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
	[
		"general-purpose",
		{
			name: "general-purpose",
			displayName: "Agent",
			description:
				"General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
			// builtinToolNames omitted — means "all available tools" (resolved at lookup time)
			// inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
			// Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
			extensions: true,
			excludeExtensions: ["pi-subagents"],	// ← NEW: cannot recursively dispatch Agent tool
			skills: true,
			systemPrompt: GENERAL_PURPOSE_PROMPT,	// ← NEW: explicit role constraint
			promptMode: "replace",				// ← NEW: replace model default, don't append empty
			isDefault: true,
			// Single-task helper: 50 turns is the budget for one focused job.
			// Caller may still override via Agent({ max_turns: ... }) at spawn time.
			maxTurns: 50,
		},
	],
	[
		"Explore",
		{
			name: "Explore",
			displayName: "Explore",
			description:
				'Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.',
			builtinToolNames: READ_ONLY_TOOLS,
			extensions: true,
			// Subagent isolation: Explore is read-only but still must not recursively
			// dispatch further Agent calls — its budget is dedicated to one search job.
			excludeExtensions: ["pi-subagents"],
			skills: true,
			// Fast/cheap model for read-only search. Provider-preferred but resilient:
			// resolveModel matches this fuzzily (date-stamp optional) and falls back to
			// the same model under another provider if anthropic doesn't expose it.
			model: "anthropic/claude-haiku-4-5",
			systemPrompt: EXPLORE_PROMPT,
			promptMode: "replace",
			isDefault: true,
			// Read-only search: 50 turns is the budget for one breadth-bounded lookup.
			// Caller may still override via Agent({ max_turns: ... }) at spawn time.
			maxTurns: 50,
		},
	],
	[
		"Plan",
		{
			name: "Plan",
			displayName: "Plan",
			description:
				"Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.",
			builtinToolNames: READ_ONLY_TOOLS,
			extensions: true,
			// Subagent isolation: Plan must not recursively dispatch further Agent calls —
			// its output is a plan, not a delegated sub-plan.
			excludeExtensions: ["pi-subagents"],
			skills: true,
			systemPrompt: PLAN_PROMPT,
			promptMode: "replace",
			isDefault: true,
			// Planning: 100 turns covers the architecture exploration + plan write.
			// Caller may still override via Agent({ max_turns: ... }) at spawn time.
			maxTurns: 100,
		},
	],
	["developer", DEVELOPER_AGENT],
]);

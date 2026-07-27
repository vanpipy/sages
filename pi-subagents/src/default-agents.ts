/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import { AUDITOR_PROMPT } from "./agent-prompts/auditor.js";
import { DEVELOPER_PROMPT } from "./agent-prompts/developer.js";
import { EXPLORE_PROMPT } from "./agent-prompts/explore.js";
import { PLAN_PROMPT } from "./agent-prompts/plan.js";
import type { AgentConfig } from "./types.js";

/**
 * Required built-in tool names for the canonical `developer` agent.
 * Mirrors the seven built-ins `pi-coding-agent` exposes
 * (`createCodingTools` ∪ `createReadOnlyTools`).
 *
 * The canonical `auditor` agent shares this set: \`edit\` / \`write\` are
 * available for the auditor's single allowed write target
 * (\`.pi/orchestrator/audit-{task_id}.md\`), and \`read\` / \`bash\` /
 * \`grep\` / \`find\` / \`ls\` carry the verify-only re-run loop. The
 * auditor prompt itself enforces "no production edits" — the tools are
 * present, the policy is the prompt's job.
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
 * Phase B (DAG-2026-011) — done: the matching migration for the
 * `software-auditor` role is complete; see `AUDITOR_AGENT` below.
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

/**
 * Canonical `auditor` agent — Phase B (DAG-2026-011).
 *
 * Migrated from pi/templates/agents/software-auditor.md (shipped via
 * `pi/scripts/install.sh` to `~/.pi/agent/agents/`) into pi-subagents
 * as a first-class built-in under the canonical name `auditor`. The
 * legacy Sages name `software-auditor` is preserved as an alias (see
 * `aliases` below) so existing orchestrators and audit consumers keep
 * working while the canonical migration lands.
 *
 * Symmetry with `developer`:
 *   - same built-in tool set (7 tools, including \`edit\`/\`write\` for
 *     the auditor's single allowed write target)
 *   - same \`extensions: [aft, pi-mcp-adapter, pi-magic-context]\` so the
 *     auditor reaches for the same indexed semantic tools as the
 *     developer
 *   - same \`excludeExtensions: ["pi-subagents"]\` belt-and-suspenders
 *     guard against recursive Agent dispatch
 *
 * Audit-specific:
 *   - \`runInBackground: true\` — full audits re-run every verification
 *     command (30s–3 min) and must not block the orchestrator
 *   - \`maxTurns: 200\` — the auditor's re-run loop (typecheck + lint +
 *     tests + diff inspection + report write) is the budget per run;
 *     callers may override via Agent({ max_turns: ... })
 *   - \`skills: false\` — no project conventions; the auditor re-derives
 *     them at audit time per the First Action Protocol
 *
 * No managed-worktree policy: \`enforceDeveloperManagedIsolationPolicy\`
 * is `developer`-only. The auditor is read-only on the developer's
 * worktree and writes only to \`.pi/orchestrator/audit-{task_id}.md\`.
 */
const AUDITOR_AGENT: AgentConfig = {
	name: "auditor",
	displayName: "Auditor",
	description:
		"Strict evidence-based software auditor — verifies task completion " +
		"against acceptance criteria using TDD evidence (test output, typecheck, " +
		"lint, command results). Default verdict is NEEDS WORK unless overwhelming " +
		"proof is provided. Canonical replacement for the legacy Sages " +
		"`software-auditor` role; the legacy name is preserved as an alias.",
	builtinToolNames: [...DEVELOPER_BUILTIN_TOOLS],
	extensions: ["aft", "pi-mcp-adapter", "pi-magic-context"],
	// Symmetric with `developer`: the auditor is read-only on production
	// code by policy, but the Agent tool cannot load here regardless.
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: AUDITOR_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	// Full audits re-run typecheck + lint + tests + diff inspection +
	// report write; 200 turns is the per-run budget. Caller may still
	// override via Agent({ max_turns: ... }) at spawn time.
	maxTurns: 200,
	aliases: ["software-auditor"],
};

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
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
	["auditor", AUDITOR_AGENT],
]);

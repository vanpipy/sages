/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import { REVIEWER_PROMPT } from "./agent-prompts/reviewer.js";
import { DEVELOPER_PROMPT } from "./agent-prompts/developer.js";
import { MERGER_ADVISOR_PROMPT } from "./agent-prompts/merger-advisor.js";
import { DEVELOPER_FIX_PROMPT } from "./agent-prompts/_fix.js";
import { EXPLORE_PROMPT } from "./agent-prompts/explore.js";
import { DEVELOPER_ADVISOR_PROMPT } from "./agent-prompts/developer-advisor.js";
import { REVIEWER_ADVISOR_PROMPT } from "./agent-prompts/reviewer-advisor.js";
import { FIX_ADVISOR_PROMPT } from "./agent-prompts/fix-advisor.js";
import { PLAN_PROMPT } from "./agent-prompts/plan.js";
import type { AgentConfig } from "./types.js";

/**
 * Required built-in tool names for the canonical `developer` agent.
 * Mirrors the seven built-ins `pi-coding-agent` exposes
 * (`createCodingTools` ∪ `createReadOnlyTools`).
 *
 * The canonical `reviewer` agent shares this set: \`edit\` / \`write\` are
 * available for the reviewer's durable verdict file writes
 * (\`.pi/orchestrator/verdict-{task_id}.md\`,
 * \`.pi/orchestrator/last-review-{goal_id}.md\`), and \`read\` / \`bash\` /
 * \`grep\` / \`find\` / \`ls\` carry the verify-only re-run loop. The
 * reviewer prompt itself enforces "no production edits" — the tools are
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
 * Canonical `developer` agent.
 *
 * Built-in to pi-subagents as of DAG-2026-011. The legacy Sages name
 * `software-developer` (and the alias-resolution machinery that
 * accepted it) was removed in GC-2026-014; canonical names are
 * PascalCase (Developer / Reviewer / Fix / Merger / MergerAdvisor).
 */
const DEVELOPER_AGENT: AgentConfig = {
	name: "Developer",
	displayName: "Developer",
	description:
		"Production-grade software implementation agent following strict " +
		"test-driven development (TDD) discipline (RED → GREEN → REFACTOR).",
	builtinToolNames: [...DEVELOPER_BUILTIN_TOOLS],
	extensions: ["aft-pi", "pi-mcp-adapter"],
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
	// GC-2026-subagent-model-inheritance: model field removed. Subagents
	// inherit the parent session's model by default. The
	// `subagents.json#defaultModelsByType` map is the explicit override
	// path — users who want a stronger model for code work can pin
	// Developer/Reviewer there. Sages-wide concurrency policy: 2
	// concurrent developers is the supported DAG fan-out.
	maxConcurrent: 2,
};

/**
 * Canonical `reviewer` agent.
 *
 * GC-2026-rename-auditor: the role was renamed from `auditor` to
 * `reviewer` after GC-2026-orchestrator-simplify deleted the DAG
 * workflow (the old "SC verification" semantic no longer applied). The
 * 5-dim review (correctness / completeness / scope / anti-goal /
 * documentation) replaces the deleted `verification_cmd` mechanism.
 *
 * Symmetry with `developer`:
 *   - same built-in tool set (7 tools, including \`edit\`/\`write\` for
 *     the reviewer's durable verdict file writes)
 *   - same \`extensions: [aft, pi-mcp-adapter]\` so the
 *     reviewer reaches for the same indexed semantic tools as the
 *     developer
 *   - same \`excludeExtensions: ["pi-subagents"]\` belt-and-suspenders
 *     guard against recursive Agent dispatch
 *
 * Reviewer-specific:
 *   - \`runInBackground: true\` — reviews re-run every verification
 *     command (30s–3 min) and must not block the orchestrator
 *   - Wall-clock deadline (30 min default, 120 min max) is the only
 *     lifecycle limit; GC-2026-subagent-time-only-limits removed the
 *     previous maxTurns budget
 *   - \`skills: false\` — no project conventions; the reviewer re-derives
 *     them at review time per the First Action Protocol
 *
 * No managed-worktree policy: \`enforceDeveloperManagedIsolationPolicy\`
 * is `developer`-only. The reviewer is read-only on the developer's
 * worktree and writes only to \`.pi/orchestrator/verdict-{task_id}.md\`
 * and \`.pi/orchestrator/last-review-{goal_id}.md\`.
 */
const REVIEWER_AGENT: AgentConfig = {
	name: "Reviewer",
	displayName: "Reviewer",
	description:
		"Strict evidence-based code reviewer — verifies task completion " +
		"against acceptance criteria using TDD evidence (test output, typecheck, " +
		"lint, command results). Default verdict is NEEDS_WORK unless overwhelming " +
		"proof is provided.",
	builtinToolNames: [...DEVELOPER_BUILTIN_TOOLS],
	extensions: ["aft-pi", "pi-mcp-adapter"],
	// Symmetric with `developer`: the reviewer is read-only on production
	// code by policy, but the Agent tool cannot load here regardless.
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: REVIEWER_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	// GC-2026-subagent-time-only-limits: maxTurns removed — wall-clock
	// deadline (30–120 min) is the only lifecycle limit. Reviewer
	// inherits 30 min from DEFAULT_PER_TYPE.Reviewer.
	// GC-2026-subagent-model-inheritance: model field removed. Reviewer
	// inherits the parent session's model by default. The
	// `subagents.json#defaultModelsByType["Reviewer"]` map is the
	// explicit override path. Sages-wide concurrency policy: 2 concurrent
	// reviewers is the supported DAG fan-out. See
	// AgentManager.effectiveMaxFor() for the cap merge order.
	maxConcurrent: 2,
};

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

// GC-2026-merger-advisor-split: MergerAdvisor is the workflow_run Merge-phase
// agent. Distinct from the DAG-synthesis Merger above — MergerAdvisor is
// strictly advisory: reads the Reviewer evidence trail, verifies the source
// branch exists, writes `.pi/orchestrator/merge-recommendation.md`. NEVER
// executes `git merge` or `git push` against protected branches (per
// `~/AGENTS.md` "Permission gate required"). Same tool set as the cross-
// workspace Merger (read + bash only), but a single-workspace advisory
// contract instead of a multi-workspace auto-merge.
const MERGER_ADVISOR_AGENT: AgentConfig = {
	name: "MergerAdvisor",
	displayName: "Merger (Advisor)",
	description:
		"workflow_run Merge-phase advisor — reads the Reviewer evidence trail at " +
		"`.pi/orchestrator/last-review-{goal_id}.md`, verifies the source branch " +
		"exists, and writes `.pi/orchestrator/merge-recommendation.md` with the " +
		"exact commands a human should run. Advisory only: NEVER executes `git merge` " +
		"or `git push` against protected branches.",
	builtinToolNames: READ_ONLY_TOOLS,
	extensions: ["aft-pi", "pi-mcp-adapter"],
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: MERGER_ADVISOR_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	// Advisory merge is fast (read evidence file + write recommendation file).
	// Per-type concurrency cap: 1 — single-workspace advisory; concurrent
	// advisors on the same goal would race on merge-recommendation.md.
	maxConcurrent: 1,
	// Deterministic tool: must not fork parent's chat history. The brief
	// carries the goal_id + worktree_path + branch.
	inheritContext: false,
};

// GC-2026-advisor-pairs: 3 new advisor agents paired with the canonical
// Implement / Audit / Verify phases. Each advisor is read-only on the
// worktree (no edit / write), doesn't redo the primary's work, and
// writes a single advisor-{kind}-{task_id}.md file with a binary
// VALIDATED / CONTESTED (or VERIFIED / INCOMPLETE) verdict.
const DEVELOPER_ADVISOR_AGENT: AgentConfig = {
	name: "DeveloperAdvisor",
	displayName: "Developer (Advisor)",
	description:
		"Implement-phase audit pair for the canonical Developer. " +
		"Reads the primary Developer's task-{task_id}-report.md + commit log + " +
		"test output and writes implement-advisor-{task_id}.md with a " +
		"VALIDATED or CONTESTED verdict. Read-only on the worktree; never " +
		"re-implements, never runs TDD on behalf of the primary.",
	builtinToolNames: READ_ONLY_TOOLS,
	extensions: ["aft-pi", "pi-mcp-adapter"],
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: DEVELOPER_ADVISOR_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	maxConcurrent: 1, // single advisor per task — output file is per-task
	inheritContext: false,
};

const REVIEWER_ADVISOR_AGENT: AgentConfig = {
	name: "ReviewerAdvisor",
	displayName: "Reviewer (Advisor)",
	description:
		"Audit-phase peer-review pair for the canonical Reviewer. " +
		"Reads the primary Reviewer's verdict file (.pi/orchestrator/verdict-{task_id}.md) " +
		"+ evidence trail (last-review-{goal_id}.md) and writes " +
		"review-advisor-{task_id}.md with a VALIDATED or CONTESTED verdict on the " +
		"primary's 4-state verdict + scope_check + anti_goal_check. Read-only; " +
		"never re-runs typecheck / lint / tests, never re-reads source.",
	builtinToolNames: READ_ONLY_TOOLS,
	extensions: ["aft-pi", "pi-mcp-adapter"],
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: REVIEWER_ADVISOR_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	maxConcurrent: 1,
	inheritContext: false,
};

const FIX_ADVISOR_AGENT: AgentConfig = {
	name: "FixAdvisor",
	displayName: "Fix (Advisor)",
	description:
		"Verify-phase audit pair for the canonical Fix. Reads the primary " +
		"Fix's commit chain + the originating Reviewer's findings[] and writes " +
		"fix-advisor-{task_id}.md with a VERIFIED or INCOMPLETE verdict — " +
		"every finding has a matching fix(...) commit or valid deferral? " +
		"Read-only; never re-runs tests, never applies more changes.",
	builtinToolNames: READ_ONLY_TOOLS,
	extensions: ["aft-pi", "pi-mcp-adapter"],
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: FIX_ADVISOR_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	maxConcurrent: 1,
	inheritContext: false,
};

/**
 * GC-2026-093: Plan was renamed to PlanCompiler. The Plan alias is
 * preserved for backward compat (legacy DAG YAML files / scripts that
 * reference "Plan"). Both keys point at the same AgentConfig.
 */
const PLAN_AGENT: AgentConfig = {
	name: "PlanCompiler",
	displayName: "PlanCompiler",
	// DAG-2026-017: PlanCompiler is a lightweight plan compiler. The main
	// agent supplies a self-contained Planning Brief (problem +
	// chosen approach + scope + acceptance + verification); PlanCompiler
	// compiles it into an ordered implementation plan or returns
	// PLAN_STATUS: BLOCKED listing what's missing. PlanCompiler must NOT
	// re-decide architecture, weigh trade-offs, or explore the repo.
	description:
		"Plan compiler — converts a main-agent Planning Brief into an ordered implementation plan or returns PLAN_STATUS: BLOCKED with the missing inputs. Does not explore the repo or pick implementation approaches.",
	builtinToolNames: ["read"],
	// No extensions: codebase_memory_*, aft_*, ctx_search, and
	// magic-context would each let PlanCompiler rebuild the architecture
	// map from scratch. The main agent already did that work.
	extensions: false,
	excludeExtensions: ["pi-subagents"],
	skills: false,
	// GC-2026-subagent-model-inheritance: model + thinking fields removed.
	// PlanCompiler inherits the parent session's model by default.
	// `subagents.json#defaultModelsByType["PlanCompiler"]` is the explicit
	// override path.
	systemPrompt: PLAN_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: false,
	inheritContext: false,
	maxConcurrent: 2,
};

/**
 * GC-2026-prompt-parser-contract-cleanup + GC-2026-verdict-states-and-dynamic-cascade follow-up:
 * the canonical `fix` agent uses the lean DEVELOPER_FIX_PROMPT (110 lines
 * covering commit discipline + boundary discipline + final-verdict +
 * fix-specific process). Path B's Fix cascade dispatches this agent type
 * (see `pi-tasks/src/workflow-handler.ts:dispatchFixForReview` and
 * `pi-tasks/src/workflow-graph.ts:buildFixTaskSpec`).
 *
 * Same tool set as Developer (same code-write capabilities needed for
 * addressing findings). Same inheritance / model policy — inherits parent
 * session model + budget. The prompt override is the only delta vs
 * Developer.
 */
const FIX_AGENT: AgentConfig = {
	name: "Fix",
	displayName: "Fix",
	description:
		"Lean fix-only Developer prompt for path B's Fix cascade. Reads the previous Review's verdict metadata (findings + open_question + scope/anti_goal checks), addresses each finding by severity, or emits an empty commit on CLEAN. No TDD or design ceremony — the previous Review already verified the contract; this task only patches.",
	builtinToolNames: [...DEVELOPER_BUILTIN_TOOLS],
	// Same extensions + exclusions as Developer. The cascade handler
	// doesn't pass `aft` explicitly because pi-subagents's loader
	// resolves canonical names at spawn time; keeping the same list
	// as Developer is the conservative choice.
	extensions: ["aft-pi", "pi-mcp-adapter"],
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: DEVELOPER_FIX_PROMPT,
	promptMode: "replace",
	isDefault: true,
	// Fix runs RED → GREEN on findings. 100 turns is enough for typical
	// fix scope (the previous Review already verified the contract).
	// Per-type concurrency cap: 2 — same as Developer (Fix tasks run in
	// parallel within a single workflow's fix-loop).
	maxConcurrent: 2,
	// Fix is dispatched with the previous Review's verdict metadata in
	// its brief — no need to fork the parent's chat history.
	inheritContext: false,
	runInBackground: true,
};

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
			// GC-2026-subagent-model-inheritance: model field removed. Explore
			// inherits the parent session's model by default. Users who want a
			// fast search model can pin it via
			// `subagents.json#defaultModelsByType["Explore"]`.
			systemPrompt: EXPLORE_PROMPT,
			promptMode: "replace",
			isDefault: true,
			// Read-only search: 50 turns is the budget for one breadth-bounded lookup.
			// Per-type concurrency cap: Explore runs in Stage 1 batches that fan
			// out for breadth coverage. 4 concurrent is the supported DAG fan-out
			// (combined with Plan's 2 cap to stay under the global 6 cap).
			maxConcurrent: 4,
			// Read-only search: foreground. The orchestrator needs the
			// result before proceeding (Explore answers "where is X").
			runInBackground: false,
		},
	],
	["Plan", PLAN_AGENT],
	["PlanCompiler", PLAN_AGENT],
	["Developer", DEVELOPER_AGENT],
	["Reviewer", REVIEWER_AGENT],
	["MergerAdvisor", MERGER_ADVISOR_AGENT],
	["DeveloperAdvisor", DEVELOPER_ADVISOR_AGENT],
	["ReviewerAdvisor", REVIEWER_ADVISOR_AGENT],
	["FixAdvisor", FIX_ADVISOR_AGENT],
	["Fix", FIX_AGENT],
]);

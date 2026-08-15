/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import { AUDITOR_PROMPT } from "./agent-prompts/auditor.js";
import { DEVELOPER_PROMPT } from "./agent-prompts/developer.js";
import { EXPLORE_PROMPT } from "./agent-prompts/explore.js";
import { GIT_EXPERT_PROMPT } from "./agent-prompts/git-expert.js";
import { MERGER_PROMPT } from "./agent-prompts/merger.js";
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
 * Canonical `developer` agent.
 *
 * Built-in to pi-subagents as of DAG-2026-011. The legacy Sages name
 * `software-developer` (and the alias-resolution machinery that
 * accepted it) was removed in GC-2026-014 — callers must use the
 * canonical `developer` spelling now.
 */
const DEVELOPER_AGENT: AgentConfig = {
	name: "developer",
	displayName: "Developer",
	description:
		"Production-grade software implementation agent following strict " +
		"test-driven development (TDD) discipline (RED → GREEN → REFACTOR).",
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
	// Default model + per-type cap (part of the Sages-wide concurrency policy:
	// 2 concurrent developers is the supported DAG fan-out). When
	// MiniMax/MiniMax-M3 is not in the user's registry, agent-runner.
	// resolveDefaultModel silently falls back to the parent session's model
	// (the user chose the parent's model at session start; trust it).
	model: "MiniMax/MiniMax-M3",
	maxConcurrent: 2,
};

/**
 * Canonical `auditor` agent.
 *
 * Built-in to pi-subagents as of DAG-2026-011 (Phase B). The legacy
 * Sages name `software-auditor` (and the alias-resolution machinery
 * that accepted it) was removed in GC-2026-014 — callers must use the
 * canonical `auditor` spelling now.
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
		"proof is provided.",
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
	// Default model + per-type cap (developer: 2 / auditor: 2 are part of the
	// Sages-wide concurrency policy). When MiniMax/MiniMax-M3 is not in the
	// user's registry, agent-runner.resolveDefaultModel silently falls back to
	// the parent session's model — see AgentManager.effectiveMaxFor() for the
	// cap merge order.
	model: "MiniMax/MiniMax-M3",
	maxConcurrent: 2,
};

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

/**
 * Canonical `merger` agent.
 *
 * Built-in to pi-subagents as the cross-workspace merge helper. The
 * merger sub-agent handles cross-workspace file overlap detected at
 * DAG synthesis: it reads both workspaces' HANDOFF.md + diffs,
 * classifies the overlap (clean / disjoint-hunk / hunk-conflict),
 * produces a merge commit via git plumbing when feasible, and
 * verifies the merged result with typecheck + lint + the merged
 * test suite. Hunk-conflicts escalate; they are NOT auto-resolved.
 *
 * (Originally authored under the goal-id `GC-2026-prompt-workspace`
 * — on the merger prompt + Workspace/HANDOFF refactor; see commit
 * `386bdb3 feat(default-agents): register merger sub-agent`.)
 *
 * Read-only on production code: `builtinToolNames` is `READ_ONLY_TOOLS`
 * (no `edit`, no `write`). Merges happen via `git -C <worktree> merge
 * --no-ff` from inside bash; the merger never edits a file directly.
 *
 * Symmetry with `developer` / `auditor`:
 *   - same extensions (`aft`, `pi-mcp-adapter`, `pi-magic-context`) so
 *     the merger reaches for the same indexed semantic tools to read
 *     both diffs and classify overlap
 *   - same `excludeExtensions: ["pi-subagents"]` belt-and-suspenders
 *     guard against recursive Agent dispatch
 *
 * Merger-specific:
 *   - `runInBackground: true` — cross-workspace verification runs
 *     typecheck + lint + test (30s–3min); must not block the
 *     orchestrator
 *   - `maxTurns: 80` — narrower than developer/auditor (200); the
 *     merger is a deterministic tool: read diffs, classify, one merge
 *     commit OR escalate. Going over 80 turns means the brief was
 *     wrong, not that the merger needs more budget
 *   - `inheritContext: false` — the merger is a deterministic tool; it
 *     must NOT fork the parent's chat history. The brief carries the
 *     workspace-A + workspace-B branches, SC ids, and worktree paths
 *     explicitly.
 *   - `skills: false` — no project conventions; the merger is dispatched
 *     with full input from the orchestrator's brief.
 *   - No `isolation` policy — the merger is dispatched from inside the
 *     orchestrator's context; the brief carries the worktree paths.
 */
const MERGER_AGENT: AgentConfig = {
	name: "merger",
	displayName: "Merger",
	description:
		"Cross-workspace merge agent — reads both workspaces' HANDOFF.md + diffs, " +
		"classifies file overlap as clean / disjoint-hunk / hunk-conflict, " +
		"produces a merge commit via git plumbing when feasible, and verifies the " +
		"merged result with typecheck + lint + the merged test suite. Read-only on " +
		"production code (no edit / write tools); hunk-conflicts escalate.",
	builtinToolNames: READ_ONLY_TOOLS,
	extensions: ["aft", "pi-mcp-adapter", "pi-magic-context"],
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: MERGER_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	// Narrower than developer/auditor: read diffs, classify, produce one
	// merge commit or escalate. Going over 80 turns means the brief was
	// wrong, not that the merger needs more budget.
	maxTurns: 80,
	// Per-type concurrency cap: 1 — the merger is stateful (HANDOFF.md +
	// worktree pairing) and concurrent merge attempts on overlapping
	// workspaces would race. Single-flight.
	maxConcurrent: 1,
	// Deterministic tool: must not fork parent's chat history. The brief
	// carries the workspace-A + workspace-B branches, SC ids, and worktree
	// paths explicitly.
	inheritContext: false,
};

/**
 * Canonical `git-expert` agent.
 *
 * Built-in to pi-subagents as of GC-2026-030. The `git-expert`
 * sub-agent performs deep git inspection (搜查), backtrack
 * archaeology (回溯), worktree / branch / merge diagnostics, and
 * produces git-usage recipes for other subagents. It is
 * read-only on production code (no `edit` / `write` tools); all
 * write activity happens in
 * `.pi/git-scratch-<task_id>-<suffix>/`.
 *
 * Symmetry with `merger` (both are read-only on production code):
 *   - same `builtinToolNames: READ_ONLY_TOOLS` (no edit / write)
 *   - same `extensions` / `excludeExtensions` so git-expert reaches
 *     for the same indexed semantic tools as the other read-only
 *     defaults to confirm findings against non-git file content
 *
 * git-expert-specific:
 *   - `runInBackground: true` — archaeology (reflog walk + fsck +
 *     bisect) can run 1–10 min and must not block the orchestrator
 *   - `maxTurns: 120` — wider than merger's 80; caller may still
 *     override via Agent({ max_turns: ... })
 *   - `inheritContext: false` — deterministic tool; must not fork
 *     the parent's chat history. The brief carries scenario +
 *     task_id + repo_root + symptom explicitly.
 *   - `skills: false` — no project conventions; git-expert is
 *     dispatched with full input from the orchestrator's brief.
 *   - **No `model` field** — per caller request, git-expert
 *     inherits the global default at spawn time. Pinning a model
 *     would silently bypass that policy.
 *   - No `isolation` policy — git-expert is dispatched from inside
 *     the orchestrator's context; the brief carries the repo root.
 *
 * Sandbox invariant: every write the agent performs (clone, init,
 * throwaway commits) must land under
 * `.pi/git-scratch-<task_id>-<suffix>/` inside the repo root. This
 * is encoded in the prompt's R3 rule and re-surfaced here as a
 * sibling comment for the registry reader.
 */
const GIT_EXPERT_AGENT: AgentConfig = {
	name: "git-expert",
	displayName: "Git Expert",
	description:
		"Senior git operator — full inspection/backtrack of git state plus " +
		"git-usage guidance for other subagents. Read-only on production code; " +
		"all write activity confined to `.pi/git-scratch-<task_id>-<suffix>/`.",
	builtinToolNames: READ_ONLY_TOOLS,
	extensions: ["aft", "pi-mcp-adapter", "pi-magic-context"],
	excludeExtensions: ["pi-subagents"],
	skills: false,
	systemPrompt: GIT_EXPERT_PROMPT,
	promptMode: "replace",
	isDefault: true,
	runInBackground: true,
	// Archaeology (reflog walk + fsck + bisect) can run long; bump
	// from merger's 80. Caller may still override via
	// Agent({ max_turns: ... }) at spawn time.
	maxTurns: 120,
	// Per-type concurrency cap: 1 — git-expert shares the orchestrator's
	// repo state for reflog walks and bisects; concurrent inspections can
	// produce inconsistent snapshots. Single-flight.
	maxConcurrent: 1,
	// Deterministic tool: must not fork parent's chat history. The
	// brief carries scenario + task_id + repo_root + symptom explicitly.
	inheritContext: false,
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
			// Sages house model for read-only search. When unavailable in the
			// user's registry, agent-runner.resolveDefaultModel silently falls
			// back to the parent session's model — see AgentManager
			// effectiveMaxFor for the per-type cap merge order.
			model: "minimax-m2.7-highspeed",
			systemPrompt: EXPLORE_PROMPT,
			promptMode: "replace",
			isDefault: true,
			// Read-only search: 50 turns is the budget for one breadth-bounded lookup.
			// Caller may still override via Agent({ max_turns: ... }) at spawn time.
			maxTurns: 50,
			// Per-type concurrency cap: Explore runs in Stage 1 batches that fan
			// out for breadth coverage. 4 concurrent is the supported DAG fan-out
			// (combined with Plan's 2 cap to stay under the global 6 cap).
			maxConcurrent: 4,
		},
	],
	[
		"Plan",
		{
			name: "Plan",
			displayName: "Plan",
			// DAG-2026-017: Plan is a lightweight plan compiler. The main
			// agent supplies a self-contained Planning Brief (problem +
			// chosen approach + scope + acceptance + verification); Plan
			// compiles it into an ordered implementation plan or returns
			// PLAN_STATUS: BLOCKED listing what's missing. Plan must NOT
			// re-decide architecture, weigh trade-offs, or explore the
			// repo. See `src/agent-prompts/plan.ts` for the contract and
			// `test/default-agents.test.ts` + `test/plan-prompt.test.ts`
			// for the pinned invariants.
			description:
				"Plan compiler — converts a main-agent Planning Brief into an ordered implementation plan or returns PLAN_STATUS: BLOCKED with the missing inputs. Does not explore the repo or pick implementation approaches.",
			// `read` only. The brief is authoritative, so Plan never needs
			// search/grep/find/ls/bash/edit/write. A single explicit read
			// is allowed to confirm an exact symbol or path named in the
			// brief.
			builtinToolNames: ["read"],
			// No extensions: codebase_memory_*, aft_*, ctx_search, and
			// magic-context would each let Plan rebuild the architecture
			// map from scratch. The main agent already did that work; Plan
			// is forbidden from redoing it.
			extensions: false,
			excludeExtensions: ["pi-subagents"],
			skills: false,
			// Pin a cheap, fixed model + minimal thinking so Plan cannot
			// inherit a costly reasoning model from the main agent.
			model: "anthropic/claude-haiku-4-5",
			thinking: "minimal",
			systemPrompt: PLAN_PROMPT,
			promptMode: "replace",
			isDefault: true,
			// Compile budget, not exploration budget. Going over 12 turns
			// means the main agent under-specified the brief; Plan should
			// have returned BLOCKED instead.
			maxTurns: 12,
			// Plan returns a single compiled plan inline. Foreground keeps
			// the orchestrator loop tight; the brief is small enough that
			// it does not justify a background queue.
			runInBackground: false,
			// Deliberate: the main agent owns the conversation. Plan must
			// receive only the self-contained Brief the main agent chose
			// to send — NOT the entire upstream transcript. Without this
			// isolation, Plan would re-derive decisions from chat history.
			inheritContext: false,
			// Per-type concurrency cap: Plan runs in Stage 2 batches. 2 concurrent
			// keeps Plan + Explore (4) under the global 6 cap.
			maxConcurrent: 2,
		},
	],
	["developer", DEVELOPER_AGENT],
	["auditor", AUDITOR_AGENT],
	["merger", MERGER_AGENT],
	["git-expert", GIT_EXPERT_AGENT],
]);

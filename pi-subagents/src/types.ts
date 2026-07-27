/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";
import type { ManagedWorktreeRequest } from "./worktree-contract.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = [
	"general-purpose",
	"Explore",
	"Plan",
] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

/**
 * Handoff metadata the Agent manager attaches to `AgentRecord.managedWorktree`
 * after provisioning a managed worktree. Stable shape so callers can rely on
 * the field set across create / reuse / get_subagent_result / steer / resume.
 *
 * Concurrency controlled by an in-process lease token (no string format
 * guarantee; treat as opaque). The lease holder is the only one allowed to
 * release the worktree through `AgentManager.releaseManagedWorktree`.
 */
export interface ManagedWorktreeHandoff {
	/** Absolute path of the on-disk worktree, as returned by create/reuse. */
	path: string;
	/** Branch checked out in the worktree. Always `sages/<dag>/<task_id>`. */
	branch: string;
	/** sha of the commit the worktree was provisioned from (pinned at first provision). */
	baseSha: string;
	/** The ref the worktree was provisioned from. Always `origin/main`. */
	/**
	 * The ref the worktree was provisioned from. Defaults to
	 * `origin/main` when the caller did not specify a `base_ref` and
	 * the current working directory has no detectable branch
	 * (detached HEAD); otherwise the resolved ref at provision time
	 * (e.g. `origin/main`, `origin/feature/x`, `feature/x`).
	 */
	baseRef: string;
	/** Current HEAD SHA inside the worktree (captured at provision time). */
	head: string;
	/** True when the worktree had uncommitted changes at provision time. */
	dirty: boolean;
	/** Whether the helper re-entered an existing managed worktree. */
	reused: boolean;
	/** Opaque lease token; required by the release path. */
	leaseToken: string;
	/** dag identity carried for caller convenience. */
	dag_id: string;
	/** task_id / worktree_id carried for caller convenience. */
	task_id: string;
	/** worktree_id when supplied explicitly; defaults to task_id when absent. */
	worktree_id: string;
	/** Repo root hosting the worktree. */
	repoRoot: string;
}

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
	name: string;
	displayName?: string;
	description: string;
	builtinToolNames?: string[];
	/** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
	 * Presence of any entry flips extension tools to an explicit allowlist. */
	extSelectors?: string[];
	/** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
	disallowedTools?: string[];
	/** true = inherit all, string[] = only listed, false = none */
	extensions: true | string[] | false;
	/** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
	 * Plain canonical names only (case-insensitive); no paths, no wildcard. */
	excludeExtensions?: string[];
	/** true = inherit all, string[] = only listed, false = none */
	skills: true | string[] | false;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	/** Persist this subagent as a normal pi session instead of keeping it in memory only. */
	persistSession?: boolean;
	/** Write the subagent's .output transcript. Defaults to true; false suppresses only that transcript. */
	outputTranscript?: boolean;
	/** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
	sessionDir?: string;
	systemPrompt: string;
	promptMode: "replace" | "append";
	/** Default for spawn: fork parent conversation. undefined = caller decides. */
	inheritContext?: boolean;
	/** Default for spawn: run in background. undefined = caller decides. */
	runInBackground?: boolean;
	/** Default for spawn: no extension tools. undefined = caller decides. */
	isolated?: boolean;
	/** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
	memory?: MemoryScope;
	/** Isolation mode — "worktree" runs the agent in a temporary git worktree */
	isolation?: IsolationMode;
	/** true = this is an embedded default agent (informational) */
	isDefault?: boolean;
	/** false = agent is hidden from the registry */
	enabled?: boolean;
	/** Where this agent was loaded from */
	source?: "default" | "project" | "global";
	/**
	 * Legacy / alias names. When a caller invokes the agent under one of
	 * these names, `resolveAgentType` still maps the request to the
	 * canonical name but flags the resolution as `alias: true` /
	 * `deprecated: true` so audit / migration tooling can surface a
	 * warning. The roster itself MUST NOT carry a separate entry for an
	 * alias name — that's what this field is for.
	 *
	 * Phase A P1 (DAG-2026-011): the canonical `developer` agent records
	 * the legacy Sages developer name here as a deprecation
	 * signal. Phase B (DAG-2026-011) — done: the canonical `auditor`
	 * agent records the legacy Sages `software-auditor` name the same way.
	 */
	aliases?: string[];
}

export type JoinMode = "async" | "group" | "smart";

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent (foreground + background).
 * - `background`: hide foreground agents (they already render inline as the
 *   Agent tool result, #118); show background/queued/scheduled/RPC.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = "all" | "background" | "off";

export interface AgentRecord {
	id: string;
	type: SubagentType;
	/**
	 * Phase A P2 (DAG-2026-011) — alias metadata captured at spawn time.
	 * `requestedName` is the spelling the caller used (verbatim, including
	 * case); `aliasUsed` is true iff the spelling was a legacy alias that
	 * resolved through the `aliases` field of a roster entry. Used by
	 * background queueing, get_subagent_result, steering, and resume so
	 * audit / telemetry can surface a deprecation warning without having
	 * to re-resolve through the registry.
	 */
	requestedName?: string;
	aliasUsed?: boolean;
	description: string;
	status:
		| "queued"
		| "running"
		| "completed"
		| "steered"
		| "aborted"
		| "stopped"
		| "error";
	result?: string;
	error?: string;
	toolUses: number;
	startedAt: number;
	completedAt?: number;
	session?: AgentSession;
	abortController?: AbortController;
	promise?: Promise<string>;
	groupId?: string;
	joinMode?: JoinMode;
	/** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
	resultConsumed?: boolean;
	/** Steering messages queued before the session was ready. */
	pendingSteers?: string[];
	/** Worktree info if the agent is running in an isolated worktree. */
	worktree?: {
		path: string;
		branch: string;
		baseSha: string;
		workPath: string;
	};
	/** Worktree cleanup result after agent completion. */
	worktreeResult?: { hasChanges: boolean; branch?: string };
	/** The tool_use_id from the original Agent tool call. */
	toolCallId?: string;
	/** Path to the streaming output transcript file. */
	outputFile?: string;
	/** Cleanup function for the output file stream subscription. */
	outputCleanup?: () => void;
	/**
	 * Lifetime usage breakdown, accumulated via `message_end` events. Survives
	 * compaction. Total = input + output + cacheWrite (cacheRead deliberately
	 * excluded — see issue #38). Initialized to zeros at spawn.
	 */
	lifetimeUsage: LifetimeUsage;
	/** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
	compactionCount: number;
	/**
	 * Whether this agent was spawned to run in the background. Tri-state, set at
	 * spawn from `SpawnOptions.isBackground`: `true` = background, `false` =
	 * foreground (has an inline Agent tool-result surface), `undefined` = the
	 * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
	 * and has no inline surface). The widget's background-only filter keys off this
	 * — and excludes only explicit `false`, so `undefined` agents stay visible.
	 * Reliable across ALL spawn paths, unlike the UI-only `invocation` snapshot,
	 * which only the Agent-tool path populates.
	 */
	isBackground?: boolean;
	/** Resolved spawn params, captured for UI display. Fixed at spawn time. */
	invocation?: AgentInvocation;
	/**
	 * Managed-worktree handoff attached when `SpawnOptions.managedWorktree` is
	 * set. Carries the path / branch / base / lease information downstream
	 * consumers (UI, get_subagent_result, steer_subagent) need to re-enter the
	 * same worktree. Set BEFORE `runAgent` runs and BEFORE the child's cwd is
	 * decided — once attached, the agent's cwd is the worktree path.
	 */
	managedWorktree?: ManagedWorktreeHandoff;
	/**
	 * Opaque lease token for the managed-worktree slot. Mirrored on
	 * `managedWorktree.leaseToken` so callers that only have the record can
	 * release the worktree without re-reading the handoff.
	 */
	managedWorktreeLease?: string;
}

export interface AgentInvocation {
	/** Short display name, e.g. "haiku" — only set when different from parent. */
	modelName?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	runInBackground?: boolean;
	isolation?: IsolationMode;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
	id: string;
	description: string;
	status: string;
	toolUses: number;
	turnCount: number;
	maxTurns?: number;
	totalTokens: number;
	durationMs: number;
	outputFile?: string;
	error?: string;
	resultPreview: string;
	/** Additional agents in a group notification. */
	others?: NotificationDetails[];
}

export interface EnvInfo {
	isGitRepo: boolean;
	branch: string;
	platform: string;
}

/**
 * A subagent spawn registered to fire on a schedule.
 *
 * Stored at `<cwd>/.pi/subagent-schedules/<sessionId>.json`. Session-scoped:
 * survives `/resume` but resets on `/new`, mirroring pi-chonky-tasks.
 */
export interface ScheduledSubagent {
	id: string;
	/** Unique within store. Defaults to `description`. */
	name: string;
	description: string;
	/** Raw user input — cron expr | "+10m" | ISO | "5m". */
	schedule: string;
	scheduleType: "cron" | "once" | "interval";
	/** Computed at create time for interval/once. */
	intervalMs?: number;

	// spawn params (subset of Agent tool params; no inherit_context, no resume)
	subagent_type: SubagentType;
	prompt: string;
	model?: string;
	thinking?: ThinkingLevel;
	max_turns?: number;
	isolated?: boolean;
	/**
	 * Accepts the legacy "worktree" literal (deprecated for Sages callers)
	 * or the explicit managed-worktree object. Stored verbatim and re-passed
	 * to `manager.spawn` at fire time.
	 */
	isolation?: IsolationMode | ManagedWorktreeRequest;

	// state
	enabled: boolean;
	/** ISO timestamp. */
	createdAt: string;
	lastRun?: string;
	lastStatus?: "success" | "error" | "running";
	/** Refreshed on every fire and on store load. */
	nextRun?: string;
	runCount: number;
}

export interface ScheduleStoreData {
	/** For future migrations. */
	version: 1;
	jobs: ScheduledSubagent[];
}

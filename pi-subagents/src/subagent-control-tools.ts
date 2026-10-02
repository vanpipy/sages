/**
 * subagent-control-tools.ts — GC-2026-boundary-subagent-control.
 *
 * The 4 subagent control tools (subagent_status / subagent_steer /
 * subagent_abort / subagent_resume) used to live in
 * `pi-orchestrator/src/subagent-control.ts`. They are runtime controls
 * over the `AgentManager` singleton, so they belong with the runtime
 * that owns that singleton (this package, `pi-subagents`).
 *
 * Before this GC, the orchestrator's tools reached across the package
 * boundary twice:
 *
 *   1. `Symbol.for("pi-subagents:manager")` global lookup to access
 *      the manager (a runtime coupling across packages).
 *   2. `import type { AgentRecord } from "@sages/pi-subagents/types"`
 *      (a type-only cross-package import — harmless at runtime but
 *      a smell because planning should not need to know runtime shapes).
 *
 * After this GC, both vanish. The runtime that owns the manager
 * (`pi-subagents/src/index.ts`) calls
 * `registerSubagentControlTools(pi, manager)` directly — no global
 * lookup, no cross-package type import.
 *
 * The `MANAGER_KEY` globalThis registry published at `index.ts` is
 * intentionally retained for back-compat with test fixtures and any
 * future cross-package integration. Only the orchestrator's dependency
 * on it is removed here.
 */
import { Type, type Static } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import type { AgentRecord } from "./types.js";

// ───────────────────────────────────────────────────────────────────────
// Tool-result envelope (matches pi-subagents/src/index.ts#textResult)
// ───────────────────────────────────────────────────────────────────────

interface ToolTextResult<T> {
	content: Array<{ type: "text"; text: string }>;
	details: T;
}

function toolText<T>(payload: T): ToolTextResult<T> {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

// ───────────────────────────────────────────────────────────────────────
// TypeBox schemas (LLM-facing) — unchanged from the pi-orchestrator copy
// ───────────────────────────────────────────────────────────────────────

const AgentStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("steered"),
	Type.Literal("aborted"),
	Type.Literal("stopped"),
	Type.Literal("error"),
]);

const SubagentStatusParams = Type.Object({
	status: Type.Optional(
		Type.Union(
			[
				Type.Literal("queued"),
				Type.Literal("running"),
				Type.Literal("completed"),
				Type.Literal("steered"),
				Type.Literal("aborted"),
				Type.Literal("stopped"),
				Type.Literal("error"),
			],
			{ description: "Filter by agent lifecycle status. Omit = all statuses." },
		),
	),
	type: Type.Optional(
		Type.String({
			description: "Filter by subagent_type (e.g. 'Developer', 'Reviewer').",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Cap on result count (≥1). Default 50.",
			minimum: 1,
		}),
	),
	verbose: Type.Optional(
		Type.Boolean({
			description:
				"When true, include lifetimeUsage / toolUses / compactionCount in each summary. Default false.",
		}),
	),
}, { additionalProperties: false });

const SubagentSteerParams = Type.Object({
	agent_id: Type.String({ description: "The id returned by the Agent tool.", minLength: 1 }),
	message: Type.String({
		description: "Message to inject into the running agent's session.",
		minLength: 1,
	}),
}, { additionalProperties: false });

const SubagentAbortParams = Type.Object({
	agent_id: Type.String({ description: "The id returned by the Agent tool.", minLength: 1 }),
	reason: Type.Optional(
		Type.String({ description: "Optional human-readable abort reason; surfaces in record.error." }),
	),
}, { additionalProperties: false });

const SubagentResumeParams = Type.Object({
	agent_id: Type.String({
		description: "The id of a TERMINAL agent (record.session must still exist).",
		minLength: 1,
	}),
	prompt: Type.String({
		description: "The next-turn prompt sent into the existing session.",
		minLength: 1,
	}),
}, { additionalProperties: false });

// ───────────────────────────────────────────────────────────────────────
// LLM-facing summary shape (NEVER expose the live AgentRecord reference)
// ───────────────────────────────────────────────────────────────────────

export interface SubagentStatusSummary {
	id: string;
	type: string;
	description: string;
	status: Static<typeof AgentStatusSchema>;
	startedAt: number;
	completedAt?: number;
	isBackground?: boolean;
	lifetimeUsage?: { input: number; output: number; cacheWrite: number };
	toolUses?: number;
	compactionCount?: number;
}

function toSummary(record: AgentRecord, verbose: boolean): SubagentStatusSummary {
	const summary: SubagentStatusSummary = {
		id: record.id,
		type: record.type,
		description: record.description,
		status: record.status,
		startedAt: record.startedAt,
	};
	if (record.completedAt !== undefined) summary.completedAt = record.completedAt;
	if (record.isBackground !== undefined) summary.isBackground = record.isBackground;
	if (verbose) {
		summary.lifetimeUsage = {
			input: record.lifetimeUsage.input,
			output: record.lifetimeUsage.output,
			cacheWrite: record.lifetimeUsage.cacheWrite,
		};
		summary.toolUses = record.toolUses;
		summary.compactionCount = record.compactionCount;
	}
	return summary;
}

// ───────────────────────────────────────────────────────────────────────
// Manager contract the tools need (structural subset of AgentManager,
// kept narrow so test doubles don't have to construct a full manager).
// ───────────────────────────────────────────────────────────────────────

/**
 * Structural shape the 4 control tools need from the AgentManager. The
 * real AgentManager implements all of these; tests can supply a fake.
 */
export interface SubagentControlManager {
	listAgents(): AgentRecord[];
	getRecord(id: string): AgentRecord | undefined;
	steer(id: string, message: string): boolean;
	abort(id: string, reason?: unknown): boolean;
	resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined>;
}

// ───────────────────────────────────────────────────────────────────────
// Executor functions — return plain JSON; the wrapper shape is applied
// by the tool registration below.
// ───────────────────────────────────────────────────────────────────────

interface SubagentStatusResult {
	ok: boolean;
	agents: SubagentStatusSummary[];
	total: number;
	filtered: number;
	by_status: Record<string, number>;
}

function executeSubagentStatus(
	manager: SubagentControlManager,
	params: Static<typeof SubagentStatusParams>,
): SubagentStatusResult {
	const all = manager.listAgents();
	const filtered = all.filter((r) => {
		if (params.status && r.status !== params.status) return false;
		if (params.type && r.type !== params.type) return false;
		return true;
	});
	const limit = params.limit ?? 50;
	const sliced = filtered.slice(0, limit);
	const by_status: Record<string, number> = {};
	for (const r of all) by_status[r.status] = (by_status[r.status] ?? 0) + 1;
	return {
		ok: true,
		agents: sliced.map((r) => toSummary(r, params.verbose === true)),
		total: all.length,
		filtered: filtered.length,
		by_status,
	};
}

interface SubagentSteerResult {
	ok: boolean;
	delivered: boolean;
	queued: boolean;
	agent_status: string;
}

function executeSubagentSteer(
	manager: SubagentControlManager,
	params: Static<typeof SubagentSteerParams>,
): SubagentSteerResult {
	const record = manager.getRecord(params.agent_id);
	if (!record) {
		return {
			ok: false,
			delivered: false,
			queued: false,
			agent_status: "unknown",
		};
	}
	const delivered = manager.steer(params.agent_id, params.message);
	const queued = (record.pendingSteers?.length ?? 0) > 0 && !record.session;
	return {
		ok: delivered,
		delivered: delivered && !queued,
		queued,
		agent_status: record.status,
	};
}

interface SubagentAbortResult {
	ok: boolean;
	stopped: boolean;
	final_status: string;
	reason?: string;
	warning?: string;
}

function executeSubagentAbort(
	manager: SubagentControlManager,
	params: Static<typeof SubagentAbortParams>,
): SubagentAbortResult {
	const record = manager.getRecord(params.agent_id);
	if (!record) {
		return {
			ok: false,
			stopped: false,
			final_status: "unknown",
		};
	}
	const terminalStatuses = new Set(["completed", "steered", "aborted", "stopped", "error"]);
	if (terminalStatuses.has(record.status)) {
		return {
			ok: true,
			stopped: false,
			final_status: record.status,
			reason: `agent already in terminal state '${record.status}' — nothing to abort`,
		};
	}
	const stopped = manager.abort(params.agent_id, params.reason);
	const result: SubagentAbortResult = {
		ok: stopped,
		stopped,
		final_status: stopped ? "stopped" : record.status,
	};
	if (params.reason) result.reason = params.reason;
	if (record.isBackground === false) {
		result.warning =
			"aborting a foreground agent — foreground agents usually block the parent; " +
			"double-check that this is intended.";
	}
	return result;
}

interface SubagentResumeResult {
	ok: boolean;
	resumed: boolean;
	status: string;
	previous_status: string;
	reason?: string;
}

async function executeSubagentResume(
	manager: SubagentControlManager,
	params: Static<typeof SubagentResumeParams>,
): Promise<SubagentResumeResult> {
	const record = manager.getRecord(params.agent_id);
	if (!record) {
		return {
			ok: false,
			resumed: false,
			status: "unknown",
			previous_status: "unknown",
		};
	}
	if (record.status === "running" || record.status === "queued") {
		return {
			ok: false,
			resumed: false,
			status: record.status,
			previous_status: record.status,
			reason: `agent is still ${record.status} — refusing to start a second prompt loop`,
		};
	}
	if (!record.session) {
		return {
			ok: false,
			resumed: false,
			status: record.status,
			previous_status: record.status,
			reason: "agent has no live session (gc may have evicted the session) — cannot resume",
		};
	}
	const previous_status = record.status;
	await manager.resume(params.agent_id, params.prompt);
	return {
		ok: true,
		resumed: true,
		status: "running",
		previous_status,
	};
}

// ───────────────────────────────────────────────────────────────────────
// Registration — call from pi-subagents/src/index.ts at the same spot
// where Agent / get_subagent_result / steer_subagent register.
// ───────────────────────────────────────────────────────────────────────

/**
 * Register the 4 subagent control tools onto a pi extension. Called from
 * pi-subagents/src/index.ts's default extension factory after the
 * AgentManager is initialized. Pass it the manager instance directly —
 * no Symbol.for lookup, no cross-package boundary.
 */
export function registerSubagentControlTools(
	pi: ExtensionAPI,
	manager: SubagentControlManager,
): void {
	pi.registerTool(
		defineTool({
			name: "subagent_status",
			label: "Subagent Status",
			description:
				"Inspect currently-running or recently-finished subagents. Returns summaries " +
				"(id, type, status, started/completed timestamps; verbose adds lifetimeUsage, " +
				"toolUses, compactionCount). Never mutates state.",
			parameters: SubagentStatusParams,
			execute: async (_toolCallId, params) =>
				toolText(executeSubagentStatus(manager, params as Static<typeof SubagentStatusParams>)),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "subagent_steer",
			label: "Steer Subagent",
			description:
				"Push a message into a running or queued subagent's session. If the session " +
				"is not yet ready the message queues in pendingSteers and flushes when ready.",
			parameters: SubagentSteerParams,
			execute: async (_toolCallId, params) =>
				toolText(executeSubagentSteer(manager, params as Static<typeof SubagentSteerParams>)),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "subagent_abort",
			label: "Abort Subagent",
			description:
				"Hard-stop a running or queued subagent. Idempotent — already-terminal agents " +
				"return stopped:false with a clear reason. Optional reason surfaces in record.error.",
			parameters: SubagentAbortParams,
			execute: async (_toolCallId, params) =>
				toolText(executeSubagentAbort(manager, params as Static<typeof SubagentAbortParams>)),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "subagent_resume",
			label: "Resume Subagent",
			description:
				"Re-enter an existing subagent session with a new prompt. Refuses if the agent " +
				"is currently running or queued — those states already have an active prompt loop.",
			parameters: SubagentResumeParams,
			execute: async (_toolCallId, params) =>
				toolText(
						await executeSubagentResume(manager, params as Static<typeof SubagentResumeParams>),
					),
		}),
	);
}

// Re-export the AgentManager type for callers that want the full
// surface (production caller in pi-subagents/src/index.ts).
export type { AgentManager };
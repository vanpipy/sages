/**
 * subagent-control.ts — GC-2026-073: programmatic LLM-facing tools for
 * inspecting and controlling subagents dispatched via the `Agent` tool.
 *
 * The Sages orchestrator's LLM can already dispatch subagents via the
 * `Agent` tool (pi-subagents). What it could NOT do until this GC is
 * actively steer / hard-stop / re-enter / inspect its own running
 * subagents. This module wires four new tools onto the existing
 * AgentManager singleton via a globalThis registry key already published
 * by pi-subagents (Symbol.for("pi-subagents:manager")) — the same
 * singleton the `Agent` tool uses, so state is shared end-to-end.
 *
 * Pattern choice: cross-package singleton via the existing globalThis
 * registry (no new exports, no cross-package type imports, no shared
 * mutable references leaking across the tool boundary). The registry
 * entry was extended in pi-subagents/src/index.ts to add
 * `steer` / `abort` / `resume` / `listAgents` methods on top of the
 * four methods (spawn/getRecord/waitForAll/hasRunning) it already
 * exposed.
 */
import { Type, type Static } from "typebox";
import type { AgentRecord } from "@sages/pi-subagents/types";

// ───────────────────────────────────────────────────────────────────────
// Cross-package registry access
// ───────────────────────────────────────────────────────────────────────

/**
 * Registry key pi-subagents publishes under globalThis so other
 * extensions can reach the singleton without re-instantiating. Must match
 * `MANAGER_KEY` in pi-subagents/src/index.ts. Using `Symbol.for(...)` keeps
 * the symbol global across realms (the Agent tool and this tool both run
 * in the same Node process, so a single global lookup is enough).
 */
// @ts-ignore -- Symbol.for returns a unique symbol; runtime use is the
// contract, the static type is opaque to tsc.
const MANAGER_KEY: unique symbol = Symbol.for("pi-subagents:manager");

/**
 * Shape of the registry entry — every method here corresponds to a
 * method on AgentManager. Kept narrow on purpose: the LLM-facing tools
 * below see only what they need.
 */
interface SubagentRegistry {
	waitForAll(): Promise<void>;
	hasRunning(): boolean;
	spawn(
		piRef: unknown,
		ctx: unknown,
		type: string,
		prompt: string,
		options: Record<string, unknown>,
	): string;
	getRecord(id: string): AgentRecord | undefined;
	steer(id: string, message: string): boolean;
	abort(id: string, reason?: unknown): boolean;
	resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined>;
	listAgents(): AgentRecord[];
}

function getRegistry(): SubagentRegistry {
	const entry = (globalThis as unknown as Record<symbol, SubagentRegistry | undefined>)[MANAGER_KEY];
	if (!entry) {
		throw new Error(
			"AgentManager registry is not initialized — is pi-subagents loaded? " +
				"This tool must be called from a session where the @sages/pi-subagents " +
				"extension has activated.",
		);
	}
	return entry;
}

// ───────────────────────────────────────────────────────────────────────
// TypeBox schemas (LLM-facing)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Agent status enum (mirrors AgentRecord.status). */
const AgentStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("steered"),
	Type.Literal("aborted"),
	Type.Literal("stopped"),
	Type.Literal("error"),
]);

export const SubagentStatusParams = Type.Object({
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
			description: "Filter by subagent_type (e.g. 'developer', 'auditor', 'Explore').",
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

export type SubagentStatusInput = Static<typeof SubagentStatusParams>;

export const SubagentSteerParams = Type.Object({
	agent_id: Type.String({ description: "The id returned by the Agent tool.", minLength: 1 }),
	message: Type.String({
		description: "Message to inject into the running agent's session.",
		minLength: 1,
	}),
}, { additionalProperties: false });

export type SubagentSteerInput = Static<typeof SubagentSteerParams>;

export const SubagentAbortParams = Type.Object({
	agent_id: Type.String({ description: "The id returned by the Agent tool.", minLength: 1 }),
	reason: Type.Optional(
		Type.String({ description: "Optional human-readable abort reason; surfaces in record.error." }),
	),
}, { additionalProperties: false });

export type SubagentAbortInput = Static<typeof SubagentAbortParams>;

export const SubagentResumeParams = Type.Object({
	agent_id: Type.String({
		description: "The id of a TERMINAL agent (record.session must still exist).",
		minLength: 1,
	}),
	prompt: Type.String({
		description: "The next-turn prompt sent into the existing session.",
		minLength: 1,
	}),
}, { additionalProperties: false });

export type SubagentResumeInput = Static<typeof SubagentResumeParams>;

// ───────────────────────────────────────────────────────────────────────
// LLM-facing summary shape (NEVER expose the live AgentRecord reference)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

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
// Tool implementations (return shape is plain JSON — never throw)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function executeSubagentStatus(params: SubagentStatusInput): {
	ok: boolean;
	agents: SubagentStatusSummary[];
	total: number;
	filtered: number;
	by_status: Record<string, number>;
} {
	const all = getRegistry().listAgents();
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

export function executeSubagentSteer(params: SubagentSteerInput): {
	ok: boolean;
	delivered: boolean;
	queued: boolean;
	agent_status: string;
} {
	const registry = getRegistry();
	const record = registry.getRecord(params.agent_id);
	if (!record) {
		return {
			ok: false,
			delivered: false,
			queued: false,
			agent_status: "unknown",
		};
	}
	const delivered = registry.steer(params.agent_id, params.message);
	// `delivered` is true when the manager accepted the steer; the
	// "queued" half-signal (session not yet ready) is captured below by
	// checking whether pendingSteers accumulated.
	const queued = (record.pendingSteers?.length ?? 0) > 0 && !record.session;
	return {
		ok: delivered,
		delivered: delivered && !queued,
		queued,
		agent_status: record.status,
	};
}

export function executeSubagentAbort(params: SubagentAbortInput): {
	ok: boolean;
	stopped: boolean;
	final_status: string;
	reason?: string;
	warning?: string;
} {
	const registry = getRegistry();
	const record = registry.getRecord(params.agent_id);
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
	const stopped = registry.abort(params.agent_id, params.reason);
	const result: ReturnType<typeof executeSubagentAbort> = {
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

export async function executeSubagentResume(params: SubagentResumeInput): Promise<{
	ok: boolean;
	resumed: boolean;
	status: string;
	previous_status: string;
	reason?: string;
}> {
	const registry = getRegistry();
	const record = registry.getRecord(params.agent_id);
	if (!record) {
		return {
			ok: false,
			resumed: false,
			status: "unknown",
			previous_status: "unknown",
		};
	}
	// Refuse while the agent has an active prompt loop. This is the
	// common-case guard — a running/queued agent MUST already have a
	// session, so check status before checking session presence.
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
	await registry.resume(params.agent_id, params.prompt);
	return {
		ok: true,
		resumed: true,
		status: "running",
		previous_status,
	};
}

// ───────────────────────────────────────────────────────────────────────
// Tool registration
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Register the 4 subagent control tools onto a pi extension. Call from
 * `registerOrchestratorTools(pi)` in extension.ts.
 */
export function registerSubagentControlTools(pi: unknown): void {
	const api = pi as {
		registerTool: (tool: {
			name: string;
			label: string;
			description: string;
			parameters: unknown;
			execute: (
				_toolCallId: string,
				params: unknown,
				_signal: unknown,
				_onUpdate: unknown,
				_ctx: unknown,
			) => unknown;
		}) => void;
	};

	// GC-2026-089: each registered subagent_* tool wraps its execute result in
	// the canonical ToolResult shape `{content: [{type: "text", text: JSON.stringify(...)}]}`
	// plus a try/catch that returns a structured error block. pi-coding-agent's
	// render-utils.js#getTextOutput reads result.content.filter(...); without
	// the wrapper, content is undefined and the renderer crashes with
	// `TypeError: Cannot read properties of undefined (reading 'filter')`.
	// The underlying executeSubagent* functions are unchanged.

	api.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Inspect currently-running or recently-finished subagents. Returns summaries " +
			"(id, type, status, started/completed timestamps; verbose adds lifetimeUsage, " +
			"toolUses, compactionCount). Read-only — never mutates state.",
		parameters: SubagentStatusParams,
		execute: (_id, params) => {
			try {
				const result = executeSubagentStatus(params as SubagentStatusInput);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `subagent_status error: ${message}`,
						},
					],
					details: { status: "error", error: message },
				};
			}
		},
	});

	api.registerTool({
		name: "subagent_steer",
		label: "Steer Subagent",
		description:
			"Push a message into a running or queued subagent's session. If the session is " +
			"not yet ready the message queues in pendingSteers and flushes when ready.",
		parameters: SubagentSteerParams,
		execute: (_id, params) => {
			try {
				const result = executeSubagentSteer(params as SubagentSteerInput);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `subagent_steer error: ${message}`,
						},
					],
					details: { status: "error", error: message },
				};
			}
		},
	});

	api.registerTool({
		name: "subagent_abort",
		label: "Abort Subagent",
		description:
			"Hard-stop a running or queued subagent. Idempotent — already-terminal agents " +
			"return stopped:false with a clear reason. Optional reason surfaces in record.error.",
		parameters: SubagentAbortParams,
		execute: (_id, params) => {
			try {
				const result = executeSubagentAbort(params as SubagentAbortInput);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `subagent_abort error: ${message}`,
						},
					],
					details: { status: "error", error: message },
				};
			}
		},
	});

	api.registerTool({
		name: "subagent_resume",
		label: "Resume Subagent",
		description:
			"Re-enter an existing subagent session with a new prompt. Refuses if the agent " +
			"is currently running or queued — those states already have an active prompt loop.",
		parameters: SubagentResumeParams,
		execute: async (_id, params) => {
			try {
				// GC-2026-089: executeSubagentResume is async — must await
				// before JSON.stringify, otherwise the wrapper serializes a
				// Promise (yielding "{}") instead of the resolved result.
				const result = await executeSubagentResume(params as SubagentResumeInput);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `subagent_resume error: ${message}`,
						},
					],
					details: { status: "error", error: message },
				};
			}
		},
	});
}
/**
 * tools.ts — the five LLM-facing mailbox tools.
 *
 * These replace the thirteen task tools the main agent uses today
 * (7 from `pi-tasks` + 6 from `pi-orchestrator`), and they exist
 * because a mailbox task does not need to be authored by a live
 * conversation: anyone drops mail, the sidebar wakes the agent, and the
 * agent picks the oldest intent up with one call.
 *
 * All five go through one `MailboxStore` so they share the lock
 * discipline and the read-modify-write path. None of them may see a
 * torn file, and none of them may partially write: a claim that loses a
 * race leaves the file byte-identical.
 *
 * ## Two contracts that are easy to break
 *
 * **Never throw.** Every failure is an `{ ok: false }` envelope with
 * readable text. "already claimed by sess-x" is the CORRECT outcome of
 * a race the design anticipates, not an error to retry blindly, and the
 * LLM can only act on that distinction if it arrives as text rather than
 * as a tool exception.
 *
 * **Never leave the mailbox unreadable.** Everything written here goes
 * through `parseTasksJson`'s vocabulary: only `pending` / `in_progress`
 * / `completed`, and parent linkage in `metadata.sourceIntent`. The
 * compatibility test in `tests/mailbox-store.test.ts` reads the file
 * back through the sidebar's own parser and is the reason that stays
 * true.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MailboxStore,
	allocateTaskIds,
	compareFifo,
	openChildTasks,
	unclaimedIntents,
} from "./store.js";
import type { Task } from "../types.js";

const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
const TASK_TYPES = ["intent", "plan"] as const;

type TaskStatus = (typeof TASK_STATUSES)[number];

/** Shared read-modify-write result carried into the tool envelope. */
type Details = Record<string, unknown>;

function ok(text: string, details: Details = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details: { ok: true, ...details },
	};
}

function fail(tool: string, error: string, details: Details = {}) {
	return {
		content: [{ type: "text" as const, text: `${tool} failed: ${error}` }],
		details: { ok: false, error, ...details },
	};
}

/**
 * One mailbox row. Subjects are inlined rather than referenced: the
 * whole point of the mailbox is that the agent can read a brief without
 * a second round-trip, and `mailbox_list` is explicitly the pull the
 * wake note points at.
 */
function formatLine(task: Task): string {
	const state = task.owner ? `claimed by ${task.owner}` : task.status;
	return `#${task.id}  ${task.type}  ${state}  ${task.subject}`;
}

/** Order the panel reads best in: fresh mail first, then the history. */
function sortForListing(tasks: Task[]): Task[] {
	const unclaimed = unclaimedIntents(tasks);
	const claimed = new Set(unclaimed.map((t) => t.id));
	const rest = tasks.filter((t) => !claimed.has(t.id)).sort(compareFifo);
	return [...unclaimed, ...rest];
}

const MailboxListParams = Type.Object({
	type: Type.Optional(
		Type.Union(TASK_TYPES.map((t) => Type.Literal(t)), {
			description: "Restrict to `intent` (mail) or `plan` (breakdown steps).",
		}),
	),
	unclaimed: Type.Optional(
		Type.Boolean({
			description:
				"Only unclaimed intents — the queue of mail nobody has picked up.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Cap the rows returned. Defaults to everything on the board.",
		}),
	),
});
export type MailboxListParams = Static<typeof MailboxListParams>;

const MailboxClaimParams = Type.Object({
	id: Type.String({ description: "Id of the intent task to claim." }),
});
export type MailboxClaimParams = Static<typeof MailboxClaimParams>;

const MailboxBreakdownTask = Type.Object({
	subject: Type.String({ description: "Imperative one-liner for this step." }),
	description: Type.Optional(
		Type.String({ description: "What this step must accomplish." }),
	),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous label for the panel." }),
	),
	blockedByIndex: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Indexes within THIS batch that must finish first. Use this, not ids — ids do not exist until the write lands.",
		}),
	),
	blocksIndex: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Indexes within THIS batch that this step blocks.",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.String(), {
			description: "Existing task ids on the board that must finish first.",
		}),
	),
	blocks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Existing task ids on the board that this step blocks.",
		}),
	),
});
export type MailboxBreakdownTaskSpec = Static<typeof MailboxBreakdownTask>;

const MailboxBreakdownParams = Type.Object({
	intentId: Type.String({ description: "The claimed intent to break down." }),
	tasks: Type.Array(MailboxBreakdownTask, {
		description: "The breakdown, in execution order. At least one step.",
	}),
});
export type MailboxBreakdownParams = Static<typeof MailboxBreakdownParams>;

const MailboxUpdateParams = Type.Object({
	taskId: Type.String({ description: "The plan task to report progress on." }),
	status: Type.Optional(
		Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)), {
			description: "New status. Omit to record a result without moving the task.",
		}),
	),
	result: Type.Optional(
		Type.String({ description: "Free-form outcome text, stored in `metadata.result`." }),
	),
});
export type MailboxUpdateParams = Static<typeof MailboxUpdateParams>;

const MailboxCompleteParams = Type.Object({
	intentId: Type.String({ description: "The intent to close." }),
	summary: Type.Optional(
		Type.String({ description: "One-line outcome, stored in `metadata.summary`." }),
	),
});
export type MailboxCompleteParams = Static<typeof MailboxCompleteParams>;

export type MailboxToolOptions = {
	/**
	 * The claiming session's identity. Read lazily rather than captured:
	 * a `/new` swap replaces the context, and a claim that stamped the
	 * old session id would leave mail permanently owned by a session that
	 * no longer exists.
	 */
	getSessionId: () => string;
};

/**
 * Wire all five tools. No host state is captured here beyond the store
 * and the session accessor, so every test is a fresh wiring against a
 * temp directory — the same discipline `sidebar-event-tool.ts` uses for
 * its handler tests.
 */
export function registerMailboxTools(
	pi: ExtensionAPI,
	store: MailboxStore,
	opts: MailboxToolOptions,
): void {
	const sessionId = (): string => {
		try {
			const id = opts.getSessionId();
			return typeof id === "string" && id.length > 0 ? id : "unknown-session";
		} catch {
			return "unknown-session";
		}
	};

	/* ── mailbox_list ────────────────────────────────────────────────── */

	pi.registerTool({
		name: "mailbox_list",
		label: "Mailbox list",
		description:
			"Read the sidebar mailbox: unclaimed intents first, then the plan tasks they were broken into. " +
			"Pure read — never mutates. Call this first after a sidebar wake note, then mailbox_claim the oldest intent.",
		parameters: MailboxListParams,
		async execute(_toolCallId, params: MailboxListParams) {
			try {
				const all = store.read();
				let listed = sortForListing(all);
				if (params.type) listed = listed.filter((t) => t.type === params.type);
				if (params.unclaimed) listed = unclaimedIntents(listed);
				const shown =
					typeof params.limit === "number" && params.limit >= 1
						? listed.slice(0, Math.floor(params.limit))
						: listed;

				const unclaimed = unclaimedIntents(all).length;
				const completed = all.filter((t) => t.status === "completed").length;
				const header =
					`mailbox: ${shown.length} of ${listed.length} listed ` +
					`(${all.length} total · ${unclaimed} unclaimed intents · ${completed} completed)`;
				const body = shown.map(formatLine);
				return ok([header, ...body].join("\n"), {
					total: all.length,
					listed: shown.length,
					unclaimed,
					ids: shown.map((t) => t.id),
				});
			} catch (error) {
				return fail("mailbox_list", describe(error));
			}
		},
	});

	/* ── mailbox_claim ──────────────────────────────────────────────── */

	pi.registerTool({
		name: "mailbox_claim",
		label: "Mailbox claim",
		description:
			"Atomically claim an unclaimed intent task for this session. Re-reads under the store lock and refuses if another session already won, so two sessions cannot both start the same brief.",
		parameters: MailboxClaimParams,
		async execute(_toolCallId, params: MailboxClaimParams) {
			const me = sessionId();
			try {
				const out = store.mutate<Task>((tasks) => {
					const task = tasks.find((t) => t.id === params.id);
					if (!task) return { ok: false, error: `no task ${params.id} in the mailbox` };
					if (task.type !== "intent") {
						return { ok: false, error: `${params.id} is a plan task, not an intent` };
					}
					if (task.status === "completed") {
						return { ok: false, error: `${params.id} is already completed` };
					}
					if (task.owner || task.status === "in_progress") {
						// The documented race outcome, verbatim. A stack trace
						// here would push the LLM into a retry loop.
						return {
							ok: false,
							error: `already claimed by ${task.owner ?? "another session"}`,
						};
					}
					const now = store.timestamp();
					return {
						ok: true,
						tasks: tasks.map((t) =>
							t.id === task.id
								? { ...t, status: "in_progress" as const, owner: me, updatedAt: now }
								: t,
						),
						value: task,
					};
				});
				if (!out.ok) return fail("mailbox_claim", out.error);
				return ok(`claimed #${out.value.id} for ${me}. Read it, then mailbox_breakdown it.`, {
					id: out.value.id,
					owner: me,
				});
			} catch (error) {
				return fail("mailbox_claim", describe(error));
			}
		},
	});

	/* ── mailbox_breakdown ──────────────────────────────────────────── */

	pi.registerTool({
		name: "mailbox_breakdown",
		label: "Mailbox breakdown",
		description:
			"Break a claimed intent down into plan tasks. Each child is linked to its intent via metadata.sourceIntent, and the intent moves to in_progress. Refuses unless the intent is already claimed by this session.",
		parameters: MailboxBreakdownParams,
		async execute(_toolCallId, params: MailboxBreakdownParams) {
			const me = sessionId();
			try {
				if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
					return fail("mailbox_breakdown", "tasks[] must not be empty");
				}
				const out = store.mutate<string[]>((tasks) => {
					const intent = tasks.find((t) => t.id === params.intentId);
					if (!intent) {
						return { ok: false, error: `no intent ${params.intentId} in the mailbox` };
					}
					if (intent.type !== "intent") {
						return { ok: false, error: `${params.intentId} is not an intent` };
					}
					if (!intent.owner || intent.status === "pending") {
						return {
							ok: false,
							error: `intent ${params.intentId} is not claimed — mailbox_claim it first`,
						};
					}

					const now = store.timestamp();
					const ids = allocateTaskIds(tasks, params.tasks.length);
					const children: Task[] = params.tasks.map((spec, i) => ({
						id: ids[i],
						type: "plan",
						subject: spec.subject,
						description: spec.description ?? "",
						status: "pending",
						...(spec.activeForm ? { activeForm: spec.activeForm } : {}),
						metadata: { sourceIntent: intent.id, index: i },
						blocks: [],
						blockedBy: [],
						createdAt: now,
						updatedAt: now,
					}));

					// Edges are expressed as indexes into THIS batch
					// because the ids do not exist until the write lands —
					// asking the agent to name ids it has not been given
					// would make the DAG unauthorable in one call. Out-of-range
					// indexes are dropped rather than throwing: a bad edge in
					// one step should not cost the agent the whole breakdown.
					const indexEdges = (refs: number[] | undefined): string[] =>
						(refs ?? [])
							.filter((r) => Number.isInteger(r) && r >= 0 && r < children.length)
							.map((r) => ids[r]);
					const idEdges = (refs: string[] | undefined, known: Set<string>): string[] =>
						(refs ?? []).filter((id) => known.has(id));

					const boardIds = new Set([
						...tasks.map((t) => t.id),
						...children.map((c) => c.id),
					]);
					params.tasks.forEach((spec, i) => {
						children[i].blockedBy = [
							...indexEdges(spec.blockedByIndex),
							...idEdges(spec.blockedBy, boardIds),
						];
						children[i].blocks = [
							...indexEdges(spec.blocksIndex),
							...idEdges(spec.blocks, boardIds),
						];
					});
					// Mirror the edges onto the other side. A one-way edge
					// would render as "blocked" on the child but leave the
					// blocker looking unblocked in `countTasks`, which
					// derives `blocked` from `blockedBy` alone.
					for (const child of children) {
						for (const blocker of child.blockedBy) {
							const other = children.find((c) => c.id === blocker);
							if (other && !other.blocks.includes(child.id)) {
								other.blocks = [...other.blocks, child.id];
							}
						}
					}

					return {
						ok: true,
						tasks: [
							...tasks.map((t) =>
								t.id === intent.id
									? {
											...t,
											status: "in_progress" as const,
											updatedAt: now,
											metadata: { ...t.metadata, brokenDownAt: now },
										}
									: t,
							),
							...children,
						],
						value: ids,
					};
				});
				if (!out.ok) return fail("mailbox_breakdown", out.error);
				return ok(
					`broke #${params.intentId} down into ${out.value.length} plan tasks: ${out.value
						.map((id) => `#${id}`)
						.join(", ")}. Do the work, then mailbox_update each and mailbox_complete the intent.`,
					{ intentId: params.intentId, taskIds: out.value, owner: me },
				);
			} catch (error) {
				return fail("mailbox_breakdown", describe(error));
			}
		},
	});

	/* ── mailbox_update ─────────────────────────────────────────────── */

	pi.registerTool({
		name: "mailbox_update",
		label: "Mailbox update",
		description:
			"Report progress on one plan task: move its status and/or store a free-form result in metadata. The intent linkage (metadata.sourceIntent) is preserved — that is what mailbox_complete's all-children-done gate reads.",
		parameters: MailboxUpdateParams,
		async execute(_toolCallId, params: MailboxUpdateParams) {
			try {
				const nextStatus = params.status as TaskStatus | undefined;
				// The host validates the union, but `execute` is also
				// reachable from tests and from older hosts that did not.
				if (nextStatus !== undefined && !TASK_STATUSES.includes(nextStatus)) {
					return fail(
						"mailbox_update",
						`status must be one of ${TASK_STATUSES.join(", ")}`,
					);
				}
				const out = store.mutate<Task>((tasks) => {
					const task = tasks.find((t) => t.id === params.taskId);
					if (!task) {
						return { ok: false, error: `no task ${params.taskId} in the mailbox` };
					}
					const now = store.timestamp();
					const updated: Task = {
						...task,
						status: nextStatus ?? task.status,
						updatedAt: now,
						metadata:
							params.result === undefined
								? task.metadata
								: { ...task.metadata, result: params.result },
					};
					return {
						ok: true,
						tasks: tasks.map((t) => (t.id === task.id ? updated : t)),
						value: updated,
					};
				});
				if (!out.ok) return fail("mailbox_update", out.error);
				return ok(`updated #${params.taskId} → ${out.value.status}`, {
					id: params.taskId,
					status: out.value.status,
				});
			} catch (error) {
				return fail("mailbox_update", describe(error));
			}
		},
	});

	/* ── mailbox_complete ───────────────────────────────────────────── */

	pi.registerTool({
		name: "mailbox_complete",
		label: "Mailbox complete",
		description:
			"Close an intent with a one-line summary. Refuses unless every task carrying metadata.sourceIntent === intentId is completed — this is the gate that stops an intent sitting in progress forever.",
		parameters: MailboxCompleteParams,
		async execute(_toolCallId, params: MailboxCompleteParams) {
			try {
				const out = store.mutate<Task>((tasks) => {
					const intent = tasks.find((t) => t.id === params.intentId);
					if (!intent) {
						return { ok: false, error: `no intent ${params.intentId} in the mailbox` };
					}
					if (intent.type !== "intent") {
						return { ok: false, error: `${params.intentId} is not an intent` };
					}
					if (intent.status === "completed") {
						return { ok: false, error: `${params.intentId} is already completed` };
					}
					const open = openChildTasks(tasks, intent.id);
					if (open.length > 0) {
						return {
							ok: false,
							error:
								`intent ${params.intentId} still has ${open.length} open child task` +
								`${open.length === 1 ? "" : "s"}: ${open
									.map((t) => `#${t.id}`)
									.join(", ")}. Finish them first.`,
						};
					}
					const now = store.timestamp();
					return {
						ok: true,
						tasks: tasks.map((t) =>
							t.id === intent.id
								? {
										...t,
										status: "completed" as const,
										updatedAt: now,
										metadata: {
											...t.metadata,
											...(params.summary === undefined
												? {}
												: { summary: params.summary }),
										completedAt: now,
									},
								}
								: t,
						),
						value: intent,
					};
				});
				if (!out.ok) return fail("mailbox_complete", out.error);
				return ok(`completed #${params.intentId}.`, {
					intentId: params.intentId,
					summary: params.summary,
				});
			} catch (error) {
				return fail("mailbox_complete", describe(error));
			}
		},
	});
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
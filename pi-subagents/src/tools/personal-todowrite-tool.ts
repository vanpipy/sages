/**
 * personal-todowrite-tool.ts — GC-2026-coupon-nonhit-block follow-up.
 *
 * GC-2026-path-B-field-renames (M12): renamed from
 * `todowrite` / `todowrite_progress` to `agent_todowrite` /
 * `agent_todowrite_progress`. The original names collided with the
 * orchestrator's deleted DAG-view tools (same name, different storage,
 * different purpose); the rename makes it unambiguous that this is
 * the per-agent personal tracker.
 *
 * Registers the personal agent_todowrite / agent_todowrite_progress
 * tools with a `pi` extension context. Storage is keyed by
 * `effectiveCwd` (the managed-worktree or current-workspace cwd) so
 * the same agent instance in a worktree sees consistent state across
 * calls.
 *
 * Two tools:
 *   - `agent_todowrite` (replace the list — Claude Code-compatible
 *     shape)
 *   - `agent_todowrite_progress` (read the list + summary counts)
 *
 * Anti-rule: no new npm dependencies (Node built-ins only). Uses
 * TypeBox via the same import path as the rest of pi-subagents.
 */

import { Type } from "typebox";
import {
	loadTodos,
	saveTodos,
	setTodos,
	summarize,
	type PersonalTodoInput,
	type TodoStatus,
} from "./personal-todowrite.js";

export interface PersonalTodowriteRegistrationContext {
	/** Agent's effective cwd — used as the storage key. */
	cwd: string;
}

const STATUS_UNION = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("skipped"),
]);

const ITEM_SCHEMA = Type.Object({
	id: Type.Optional(Type.String({
		description: "Stable id; if omitted, the server assigns `todo-N` where N is the 1-based index in the items array.",
	})),
	content: Type.String({ minLength: 1, description: "What to do." }),
	status: Type.Optional(STATUS_UNION),
});

interface RegisteredTool {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	execute: (
		_toolCallId: string,
		params: unknown,
		_signal: unknown,
		_onUpdate: unknown,
		_ctx: unknown,
	) => unknown;
}

interface PiApi {
	registerTool: (t: RegisteredTool) => void;
}

export function registerPersonalTodowriteTools(
	pi: unknown,
	ctx: PersonalTodowriteRegistrationContext,
): void {
	const api = pi as PiApi;

	api.registerTool({
		name: "agent_todowrite",
		label: "Personal TodoWrite (set)",
		description:
			"Replace your current task list. Each item: {id?, content, status?}. " +
			"Omit `id` to let the server assign `todo-N`. " +
			"Omit `status` to keep the prior status (defaults to 'pending' for new items). " +
			"Use this BEFORE the first tool call on any task with 3+ steps to plan your work. " +
			"Use `agent_todowrite_progress` to read the current list. " +
			"Storage: ~/.cache/pi-subagents-todos/<cwd-hash>.json (per worktree).",
		parameters: Type.Object({
			items: Type.Array(ITEM_SCHEMA, {
				description: "The new task list. Pass an empty array to clear.",
			}),
		}),
		execute: (_id, params, _signal, _onUpdate, _ctx) => {
			const p = params as { items: PersonalTodoInput[] };
			const next = setTodos(ctx.cwd, p.items);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ items: next, count: next.length }, null, 2) },
				],
			};
		},
	});

	api.registerTool({
		name: "agent_todowrite_progress",
		label: "Personal TodoWrite Progress",
		description:
			"Read your current task list with status counts and the in-progress item id. " +
			"Use this at the start of each turn to remember where you are.",
		parameters: Type.Object({}),
		execute: (_id, _params, _signal, _onUpdate, _ctx) => {
			const items = loadTodos(ctx.cwd);
			const summary = summarize(ctx.cwd);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ items, summary }, null, 2),
					},
				],
			};
		},
	});
}

/**
 * Re-export for the typecheck surface: `TodoStatus` is referenced from
 * this module's tool result shape elsewhere; keep the type available.
 */
export type { TodoStatus };

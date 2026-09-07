/**
 * personal-todowrite.ts — GC-2026-coupon-nonhit-block follow-up (Path A).
 *
 * Per-subagent personal todo list (active task tracking). Distinct from
 * `pi-orchestrator/src/todowrite.ts` which is a **DAG-view** (one
 * compiled per workflow + auto-sync from task_dispatch). The personal
 * todowrite here is:
 *
 *   - Per-subagent (storage keyed by `cwd` — one file per managed worktree)
 *   - Session-scoped persistence (file-based, survives within an agent
 *     run; not shared across dispatch instances)
 *   - Append-friendly API: `set` replaces the full list; individual items
 *     keep their `id` across replacements to preserve state
 *
 * No magic-context integration. The `ctx_note` fallback documented in
 * the Developer prompt template is cross-session parking-lot, NOT a
 * personal tracker — this tool is the proper substitute.
 *
 * Storage path: `~/.cache/pi-subagents-todos/<cwd-hash>.json`
 *   - Out of the worktree (avoids accidental commit)
 *   - Cwd-keyed so Developer + Auditor sharing a worktree see the same list
 *   - Cwd-hashed for safe filename (no `..` traversal)
 *
 * Anti-rule: no new npm dependencies (Node built-ins only).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface PersonalTodoItem {
	id: string;
	content: string;
	status: TodoStatus;
	created_at: string;
	updated_at: string;
}

export interface PersonalTodoInput {
	id?: string;
	content: string;
	status?: TodoStatus;
}

const CACHE_DIR = join(homedir(), ".cache", "pi-subagents-todos");

function todoFilePath(cwd: string): string {
	// SHA-256 of cwd → first 16 hex chars (64 bits, ample collision space
	// for the realistic agent count; collision probability ~0 for <1B
	// entries per birthday).
	const h = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(CACHE_DIR, `${h}.json`);
}

export function loadTodos(cwd: string): PersonalTodoItem[] {
	const p = todoFilePath(cwd);
	if (!existsSync(p)) return [];
	try {
		const raw = readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		// Defensive: filter to valid items only. Tolerate partial corruption
		// rather than crash — the agent can `set` to recover.
		return parsed.filter(
			(i): i is PersonalTodoItem =>
				i !== null &&
				typeof i === "object" &&
				typeof i.id === "string" &&
				typeof i.content === "string" &&
				typeof i.status === "string",
		);
	} catch {
		return [];
	}
}

export function saveTodos(cwd: string, items: PersonalTodoItem[]): void {
	const p = todoFilePath(cwd);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(items, null, 2) + "\n", "utf-8");
}

/**
 * Replace the current todo list with a new one. Items with the same `id`
 * as an existing item retain their `created_at` and prior `status` if
 * the caller omits `status`. New items get `created_at = now` and
 * `status = "pending"` (or the caller-supplied status).
 */
export function setTodos(cwd: string, items: PersonalTodoInput[]): PersonalTodoItem[] {
	const now = new Date().toISOString();
	const existing = loadTodos(cwd);
	const byId = new Map(existing.map((i) => [i.id, i]));
	const next: PersonalTodoItem[] = items.map((item, idx) => {
		const id = item.id ?? `todo-${idx + 1}`;
		const prev = byId.get(id);
		return {
			id,
			content: item.content,
			status: item.status ?? prev?.status ?? "pending",
			created_at: prev?.created_at ?? now,
			updated_at: now,
		};
	});
	saveTodos(cwd, next);
	return next;
}

export interface TodoSummary {
	total: number;
	byStatus: Record<TodoStatus, number>;
	inProgressId: string | null;
}

export function summarize(cwd: string): TodoSummary {
	const items = loadTodos(cwd);
	const byStatus: Record<TodoStatus, number> = {
		pending: 0,
		in_progress: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
	};
	let inProgressId: string | null = null;
	for (const i of items) {
		byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
		if (i.status === "in_progress" && inProgressId === null) {
			inProgressId = i.id;
		}
	}
	return { total: items.length, byStatus, inProgressId };
}

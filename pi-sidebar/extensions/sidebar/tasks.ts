/**
 * tasks.ts — Sages task board sidebar section.
 *
 * Polls one of three possible task store locations and renders a compact
 * summary (`{completed}/{total}  ◼ N running …`) plus per-task glyphs.
 * Replaces the chat-polluting `sages-board-watch` pulse routine with
 * passive sidebar awareness: the user sees the board update every
 * `PI_SIDEBAR_REFRESH_MS` without the orchestrator having to narrate it.
 *
 * Source order (silent no-op when none exist):
 *
 *   1. `${ORCHESTRATOR_WORKDIR}/${projectKey(cwd)}/tasks/tasks.json`
 *      — Sages project scope; cross-session shared.
 *   2. `${cwd}/.pi/tasks/tasks-<sessionId>.json`
 *      — single-session pi-tasks store.
 *   3. `${cwd}/.pi/tasks/*.json`
 *      — multi-session merge, dedup by task id.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	SidebarSectionContext,
	Task,
	TaskRow,
	TasksState,
} from "./types.js";

export type { Task, TaskRow, TasksState } from "./types.js";

const DEFAULT_ORCHESTRATOR_WORKDIR = join(tmpdir(), "sages-orchestrator");

/**
 * Mirrors `pi-tasks/src/task-paths.ts:projectKey` so the sidebar finds the
 * same per-workspace task file as the orchestrator. Two workspaces that share
 * a basename must encode differently because the full path is part of the key.
 */
export function projectKey(cwd: string): string {
	return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Resolve `ORCHESTRATOR_WORKDIR` at call time. The env var (set by the
 * orchestrator) overrides the default `<tmpdir>/sages-orchestrator`.
 */
export function orchestratorWorkdir(): string {
	return process.env.ORCHESTRATOR_WORKDIR ?? DEFAULT_ORCHESTRATOR_WORKDIR;
}

/**
 * Per-task renderer output. `subject` is truncated to fit the sidebar width
 * minus the glyph + status + agentType badge.
 */
type RenderedTaskLine = { subject: string; statusLabel: string };

/**
 * Validate the JSON shape and return its `tasks[]`. Returns null on:
 *
 *   - non-JSON input
 *   - missing `tasks` array
 *   - any task missing `id`/`type`/`subject`/`status`
 *
 * Tolerates extra fields on each task — the sidebar only reads the few it
 * renders.
 */
export function parseTasksJson(text: string): Task[] | null {
	if (!text || !text.trim()) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		!raw ||
		typeof raw !== "object" ||
		!("tasks" in raw) ||
		!Array.isArray((raw as { tasks: unknown }).tasks)
	) {
		return null;
	}
	const tasks: Task[] = [];
	for (const item of (raw as { tasks: unknown[] }).tasks) {
		if (!item || typeof item !== "object") return null;
		const t = item as Record<string, unknown>;
		if (typeof t.id !== "string") return null;
		if (t.type !== "intent" && t.type !== "plan") return null;
		if (typeof t.subject !== "string") return null;
		if (
			t.status !== "pending" &&
			t.status !== "in_progress" &&
			t.status !== "completed"
		) {
			return null;
		}
		const blocks = Array.isArray(t.blocks)
			? t.blocks.filter((x): x is string => typeof x === "string")
			: [];
		const blockedBy = Array.isArray(t.blockedBy)
			? t.blockedBy.filter((x): x is string => typeof x === "string")
			: [];
		const metadata =
			t.metadata && typeof t.metadata === "object"
				? (t.metadata as Record<string, unknown>)
				: {};
		tasks.push({
			id: t.id,
			type: t.type,
			subject: t.subject,
			description: typeof t.description === "string" ? t.description : "",
			status: t.status,
			metadata,
			blocks,
			blockedBy,
			createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
			updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : 0,
		});
	}
	return tasks;
}

/**
 * Count tasks in the categories the header reports. "Blocked" is a derived
 * bucket: a `plan` task in `pending` state whose `blockedBy` references at
 * least one non-completed task. Intent tasks and completed-blocked chains
 * are never blocked.
 */
export function countTasks(tasks: Task[]): {
	total: number;
	intents: number;
	inProgress: number;
	completed: number;
	blocked: number;
} {
	const completedSet = new Set(
		tasks.filter((t) => t.status === "completed").map((t) => t.id),
	);
	let intents = 0;
	let inProgress = 0;
	let completed = 0;
	let blocked = 0;
	for (const t of tasks) {
		if (t.type === "intent") intents++;
		if (t.status === "in_progress") inProgress++;
		if (t.status === "completed") completed++;
		if (
			t.type === "plan" &&
			t.status === "pending" &&
			t.blockedBy.some((id) => !completedSet.has(id))
		) {
			blocked++;
		}
	}
	return { total: tasks.length, intents, inProgress, completed, blocked };
}

/**
 * Project the on-disk tasks to render rows. The displayed status distinguishes
 * `intent` / `pending` / `blocked` so the user can read the row at a glance;
 * "blocked" wins over "pending" when blockers are still open. Already truncated
 * — the renderer never sees the hidden rows.
 */
export function toTaskRows(
	tasks: Task[],
	maxRows: number,
): { rows: TaskRow[]; truncated: number } {
	if (maxRows < 1) {
		return { rows: [], truncated: Math.max(0, tasks.length) };
	}
	const completedSet = new Set(
		tasks.filter((t) => t.status === "completed").map((t) => t.id),
	);
	const rows: TaskRow[] = [];
	for (const t of tasks) {
		let status: TaskRow["status"];
		if (t.type === "intent") status = "intent";
		else if (t.status === "completed") status = "completed";
		else if (t.status === "in_progress") status = "in_progress";
		else if (t.blockedBy.some((id) => !completedSet.has(id))) status = "blocked";
		else status = "pending";
		const agentTypeRaw = t.metadata.agentType;
		rows.push({
			id: t.id,
			subject: t.subject,
			status,
			agentType: typeof agentTypeRaw === "string" ? agentTypeRaw : undefined,
		});
	}
	const truncated = Math.max(0, rows.length - maxRows);
	return { rows: rows.slice(0, maxRows), truncated };
}

/** One source the parser may have read from. */
export type TasksSource = {
	scope: "orchestrator" | "session" | "workspace";
	path: string;
};

/**
 * Pick the first readable source in priority order. Always returns the path
 * the loader should try first; absence just means `available: false` later.
 */
export function resolveTasksSource(
	cwd: string,
	opts: { sessionId?: string } = {},
): TasksSource | null {
	const root = orchestratorWorkdir();
	const orchestratorFile = join(root, projectKey(cwd), "tasks", "tasks.json");
	if (existsSync(orchestratorFile)) {
		return { scope: "orchestrator", path: orchestratorFile };
	}
	if (opts.sessionId) {
		const sessionFile = join(cwd, ".pi", "tasks", `tasks-${opts.sessionId}.json`);
		if (existsSync(sessionFile)) {
			return { scope: "session", path: sessionFile };
		}
	}
	const workspaceDir = join(cwd, ".pi", "tasks");
	if (existsSync(workspaceDir)) {
		try {
			const entries = readdirSync(workspaceDir);
			const jsonFile = entries.find(
				(name) => name.startsWith("tasks-") && name.endsWith(".json"),
			);
			if (jsonFile) {
				return {
					scope: "workspace",
					path: join(workspaceDir, jsonFile),
				};
			}
		} catch {
			/* dir raced away between existsSync and readdirSync — fall through */
		}
	}
	return null;
}

/**
 * Read and merge every task file under `<cwd>/.pi/tasks/`. The orchestrator
 * may write multiple session files in this directory; merging dedups by
 * `id`, with later occurrences winning (the newest write reflects the
 * authoritative status). Exported for tests + the wiring code.
 */
export function readWorkspaceTasks(cwd: string): {
	source: string | undefined;
	tasks: Task[];
} {
	const dir = join(cwd, ".pi", "tasks");
	if (!existsSync(dir)) return { source: undefined, tasks: [] };
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { source: undefined, tasks: [] };
	}
	const files = entries
		.filter((name) => name.startsWith("tasks-") && name.endsWith(".json"))
		.sort();
	const merged = new Map<string, Task>();
	let firstSource: string | undefined;
	for (const name of files) {
		const full = join(dir, name);
		try {
			const text = readFileSync(full, "utf8");
			const parsed = parseTasksJson(text);
			if (!parsed) continue;
			if (firstSource === undefined) firstSource = full;
			for (const t of parsed) merged.set(t.id, t);
		} catch {
			/* ignore unreadable / racing file */
		}
	}
	return { source: firstSource, tasks: Array.from(merged.values()) };
}

/**
 * Resolve a single source file (sources #1 and #2) and parse it. Empty
 * `readFileSync` results return `{ tasks: [] }` so a freshly created empty
 * store doesn't count as "unavailable".
 */
function readSingleFile(path: string): Task[] {
	try {
		const text = readFileSync(path, "utf8");
		const parsed = parseTasksJson(text);
		return parsed ?? [];
	} catch {
		return [];
	}
}

/**
 * Build a fresh `TasksState` from the workspace's task files. `available`
 * is `false` only when no source was found at all (silent no-op for
 * non-Sages sessions).
 */
export function loadTasksState(
	cwd: string,
	opts: { sessionId?: string; maxRows: number },
): TasksState {
	const source = resolveTasksSource(cwd, { sessionId: opts.sessionId });
	let tasks: Task[] = [];
	let usedPath: string | undefined;
	if (source && (source.scope === "orchestrator" || source.scope === "session")) {
		tasks = readSingleFile(source.path);
		usedPath = source.path;
	} else if (source && source.scope === "workspace") {
		const out = readWorkspaceTasks(cwd);
		tasks = out.tasks;
		usedPath = out.source;
	}
	const counts = countTasks(tasks);
	const { rows, truncated } = toTaskRows(tasks, opts.maxRows);
	return {
		enabled: true,
		available: source !== undefined,
		source: usedPath,
		total: counts.total,
		completed: counts.completed,
		inProgress: counts.inProgress,
		intents: counts.intents,
		blocked: counts.blocked,
		rows,
		truncatedCount: truncated,
	};
}

/**
 * Empty-state initializer for `state.tasks` before the first poll lands.
 * Mirrors what `loadTasksState` returns when the file is missing.
 */
export function emptyTasksState(): TasksState {
	return {
		enabled: true,
		available: false,
		total: 0,
		completed: 0,
		inProgress: 0,
		intents: 0,
		blocked: 0,
		rows: [],
		truncatedCount: 0,
	};
}

/* ─── Renderer ────────────────────────────────────────────────────────── */

const TASK_GLYPHS: Record<TaskRow["status"], string> = {
	intent: "◌",
	pending: "▷",
	blocked: "⌥",
	in_progress: "◼",
	completed: "✓",
};

const TASK_STATUS_LABELS: Record<TaskRow["status"], string> = {
	intent: "intent",
	pending: "open",
	blocked: "blocked",
	in_progress: "running",
	completed: "done",
};

const TASK_STATUS_TOKENS: Record<TaskRow["status"], ThemeColor> = {
	intent: "muted",
	pending: "muted",
	blocked: "warning",
	in_progress: "accent",
	completed: "success",
};

function truncateSubject(
	subject: string,
	glyphWidth: number,
	statusWidth: number,
	badgeWidth: number,
	innerWidth: number,
): string {
	const fixed = glyphWidth + 1 + statusWidth + 1 + badgeWidth + 1; // glyph + space + status + space + badge
	const subjectWidth = Math.max(1, innerWidth - fixed);
	return truncateToWidth(subject, subjectWidth, "…");
}

function renderTaskLine(
	row: TaskRow,
	innerWidth: number,
	theme: SidebarSectionContext["theme"],
): RenderedTaskLine {
	const glyph = TASK_GLYPHS[row.status];
	const statusLabel = TASK_STATUS_LABELS[row.status];
	const badge = row.agentType ? `[${row.agentType}]` : "";
	// `▶` is the selectable affordance marker — the reverse-channel
	// keybinding (ctrl+shift+t) maps the user's selection to one of the
	// rendered rows. See `selectTopTask` in `extensions/sidebar.ts`.
	const affordance = "▶";
	const subject = truncateSubject(
		row.subject,
		visibleWidth(affordance) + visibleWidth(glyph),
		visibleWidth(statusLabel),
		visibleWidth(badge),
		innerWidth,
	);
	const statusColored = theme.fg(TASK_STATUS_TOKENS[row.status], statusLabel);
	let line = `${affordance} ${glyph} ${subject} ${statusColored}`;
	if (badge) line += ` ${theme.fg("dim", badge)}`;
	return { subject: line, statusLabel };
}

export function renderTasksSection(section: SidebarSectionContext): void {
	const { state, theme, innerWidth, add, muted } = section;
	const tasks = state.tasks;
	if (!tasks || !tasks.enabled) return;
	section.heading("Tasks");

	if (!tasks.available) {
		add(muted("no tasks"));
		return;
	}

	if (tasks.total === 0) {
		add(muted("no tasks"));
		return;
	}

	const headerParts: string[] = [`${tasks.completed}/${tasks.total}`];
	if (tasks.inProgress > 0) headerParts.push(`◼ ${tasks.inProgress} running`);
	if (tasks.blocked > 0)
		headerParts.push(theme.fg("warning", `⌥ ${tasks.blocked} blocked`));
	if (tasks.intents > 0)
		headerParts.push(theme.fg("muted", `◌ ${tasks.intents} intent`));
	add(headerParts.join("  "));

	for (const row of tasks.rows) {
		const { subject } = renderTaskLine(row, innerWidth, theme);
		add(subject);
	}
	if (tasks.truncatedCount > 0) {
		add(theme.fg("dim", `…${tasks.truncatedCount} more`));
	}
}
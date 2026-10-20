import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Theme = ExtensionContext["ui"]["theme"];

export type GitState = {
	insideRepo: boolean;
	branch?: string;
	files: Array<{ code: string; path: string; delta?: string }>;
	insertions: number;
	deletions: number;
	changedFiles: number;
	error?: string;
};

/**
 * Sages task board task — the on-disk shape written by the Sages task
 * store (`pi-tasks/src/task-store.ts`). Only the fields the sidebar
 * surfaces are displayed; the parser tolerates extras.
 */
export type Task = {
	id: string;
	type: "intent" | "plan";
	subject: string;
	description: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
	owner?: string;
	metadata: Record<string, unknown>;
	blocks: string[];
	blockedBy: string[];
	createdAt: number;
	updatedAt: number;
};

/**
 * One task as the sidebar renders it: the fields the section actually
 * needs. Built from `Task` by `toTaskRows`; the renderer never touches
 * the raw on-disk shape.
 */
export type TaskRow = {
	id: string;
	subject: string;
	status: "intent" | "pending" | "blocked" | "in_progress" | "completed";
	agentType?: string;
};

/**
 * Counts and pre-truncated rows derived from the on-disk task store.
 * The sidebar polls the store on `PI_SIDEBAR_REFRESH_MS` and stores
 * the latest snapshot here for `renderTasksSection`.
 *
 * `enabled` is read from `PI_SIDEBAR_TASKS` at startup and turns the
 * whole section off (`renderTasksSection` returns immediately when
 * `enabled === false`). `available` is `false` when no source file
 * was readable; the section then renders "no tasks" muted rather
 * than disappearing entirely.
 */
export type TasksState = {
	enabled: boolean;
	available: boolean;
	source?: string;
	total: number;
	completed: number;
	inProgress: number;
	intents: number;
	blocked: number;
	rows: TaskRow[];
	truncatedCount: number;
};

/**
 * One entry in the sidebar's append-only event log.
 *
 * Populated by the `sidebar_event` `log` action (via the
 * `sidebar:event` channel on `pi.events`); rendered by an opt-in
 * sidebar section. Free-form `data` slot keeps the channel
 * generic — orchestrator payloads (verdicts, tool calls,
 * evaluation scores) pass through without schema churn.
 */
export type EventLogEntry = {
	ts: number;
	target?: string;
	data?: Record<string, unknown>;
};

export type SidebarState = {
	enabled: boolean;
	collapsed: boolean;
	gitDetail: boolean;
	fullHeight: boolean;
	git: GitState;
	lastGitRefresh?: number;
	lastTasksRefresh?: number;
	turnCount: number;
	isStreaming: boolean;
	lastTool?: string;
	tasks: TasksState;
	/** Latest transient target set via `show` / `highlight`. */
	highlightedId?: string;
	/** Active badges set via `badge`. Cleared with `clear` (optionally filtered by target). */
	badges: EventLogEntry[];
	/** Append-only event log fed by `log`. Capped FIFO — oldest entries evicted first. */
	eventLog: EventLogEntry[];
};

export type SidebarRenderOptions = {
	maxFiles: number;
	buffer: number;
	fillRows: number;
	verticalPadding: number;
	getThinkingLevel: () => string | undefined;
	tasks: {
		maxRows: number;
	};
};

export type SidebarSectionContext = {
	ctx: ExtensionContext | undefined;
	state: SidebarState;
	theme: Theme;
	innerWidth: number;
	add: (line?: string) => void;
	heading: (label: string) => void;
	muted: (s: string) => string;
	dim: (s: string) => string;
	options: SidebarRenderOptions;
	/**
	 * Reverse-channel hook for the Tasks section. The wrapper in
	 * `extensions/sidebar.ts` wires this to `pi.appendEntry("system", ...)`
	 * so a keybinding (`ctrl+shift+t`) can inject a system note into
	 * the next LLM turn referencing the task the user picked.
	 *
	 * Optional — sections other than Tasks simply ignore it.
	 */
	selectTask?: (taskId: string, subject: string) => void;
};

/** Shape of payloads emitted on the `pi.events` channel `sidebar:event`. */
export type SidebarEvent = {
	ts: number;
	action: "show" | "highlight" | "badge" | "toast" | "log" | "clear";
	target?: string;
	data?: Record<string, unknown>;
};

/** Default cap on the append-only `state.eventLog` array. */
export const SIDEBAR_EVENT_LOG_MAX = 50;

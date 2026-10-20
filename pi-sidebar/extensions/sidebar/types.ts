import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Theme = ExtensionContext["ui"]["theme"];

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
	fullHeight: boolean;
	lastTasksRefresh?: number;
	/**
	 * Feeds `PI_SIDEBAR_AUTOHIDE_WORKING` via `shouldHideSidebar`
	 * (`extensions/sidebar/utils.ts`). Flipped by the `turn_start` /
	 * `turn_end` handlers in `extensions/sidebar.ts`. The Model section
	 * used to be the only visible consumer before the trim; the field
	 * survives because the autohide contract still needs it.
	 *
	 * Note pi's `turn_end` lands only after the whole tool batch
	 * returns, so this stays `true` across bash calls and subagent
	 * spawns — not just token streaming. `PI_SIDEBAR_AUTOHIDE_WORKING`
	 * therefore ships OFF (see `autohideWorkingFromEnv`); with it on,
	 * the panel would hide for the entire working turn.
	 */
	isStreaming: boolean;
	tasks: TasksState;
	/** Latest transient target set via `show` / `highlight`. */
	highlightedId?: string;
	/** Active badges set via `badge`. Cleared with `clear` (optionally filtered by target). */
	badges: EventLogEntry[];
	/** Append-only event log fed by `log`. Capped FIFO — oldest entries evicted first. */
	eventLog: EventLogEntry[];
};

/**
 * Layout knobs the component uses to frame whatever a renderer emits.
 * `tasks.maxRows` used to live here; it is a *poll-time* parameter
 * (`loadTasksState(cwd, { maxRows })`), not a render-time one, so it now
 * lives only at its call site.
 */
export type SidebarRenderOptions = {
	buffer: number;
	fillRows: number;
	verticalPadding: number;
};

/**
 * The renderer's input bag.
 *
 * This type was sized for a multi-section panel. Tasks is now the only
 * renderer, so it carries only what that renderer actually reads — the
 * `ctx` / `dim` / `options` / `selectTask` fields that used to feed the
 * removed Git section (and the long-removed Model section) are gone.
 * Add a field here when a renderer needs it, not before.
 */
export type SidebarSectionContext = {
	state: SidebarState;
	theme: Theme;
	innerWidth: number;
	add: (line?: string) => void;
	heading: (label: string) => void;
	muted: (s: string) => string;
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

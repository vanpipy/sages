import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	KeybindingsManager,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	OverlayOptions,
	SizeValue,
	TUI,
} from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderGitSection } from "./sidebar/sections/git.js";
import {
	emptyTasksState,
	loadTasksState,
	renderTasksSection,
} from "./sidebar/sections/tasks.js";
import type {
	GitState,
	SidebarRenderOptions,
	SidebarSectionContext,
	SidebarState,
	Theme,
} from "./sidebar/types.js";
import {
	envBool,
	envInt,
	envIntClamped,
	envSignedInt,
	envSize,
	padAnsi,
	parseNumstat,
	parseShortstat,
	shouldHideSidebar,
} from "./sidebar/utils.js";
import { registerSidebarEventTool } from "./sidebar/sidebar-event-tool.js";

export type { GitState, SidebarState, Task, TaskRow, TasksState } from "./sidebar/types.js";
export {
	countTasks,
	emptyTasksState,
	loadTasksState,
	orchestratorWorkdir,
	parseTasksJson,
	projectKey,
	renderTasksSection,
	resolveTasksSource,
	toTaskRows,
} from "./sidebar/sections/tasks.js";
export {
	envBool,
	envInt,
	envIntClamped,
	envSignedInt,
	envSize,
	formatFileLine,
	padAnsi,
	parseNumstat,
	parseShortstat,
	shouldHideSidebar,
} from "./sidebar/utils.js";

const DEFAULT_GIT: GitState = {
	insideRepo: false,
	files: [],
	insertions: 0,
	deletions: 0,
	changedFiles: 0,
};

const COLLAPSED_SIDEBAR_WIDTH = 2;

const SIDEBAR_SECTIONS: Array<(section: SidebarSectionContext) => void> = [
	renderGitSection,
	renderTasksSection,
];

export function sidebarOverlayWidth(
	state: Pick<SidebarState, "collapsed" | "fullHeight">,
	width: number,
	buffer: number,
): number {
	return state.collapsed
		? COLLAPSED_SIDEBAR_WIDTH
		: width + (state.fullHeight ? buffer : 0);
}

export function setSidebarCollapsed(
	state: Pick<SidebarState, "enabled" | "collapsed">,
	collapsed: boolean,
): void {
	state.enabled = true;
	state.collapsed = collapsed;
}

export function toggleSidebarCollapsed(
	state: Pick<SidebarState, "enabled" | "collapsed">,
): void {
	if (!state.enabled) {
		setSidebarCollapsed(state, false);
		return;
	}
	setSidebarCollapsed(state, !state.collapsed);
}

/**
 * Everything the overlay needs to know about *where* it sits, split
 * out from the plugin closure so the placement rules are testable
 * without a live TUI. All fields come from the environment.
 */
export type SidebarPlacementConfig = {
	/** Base panel width in columns (`PI_SIDEBAR_WIDTH`). */
	width: number;
	/** Left gutter in full-height layout (`PI_SIDEBAR_BUFFER`). */
	buffer: number;
	/** Columns of breathing room from the right edge (floating layout). */
	insetRight: number;
	/** Rows reserved at the bottom for the composer (floating layout). */
	bottomReserve: number;
	/** Height cap in the floating layout — rows or a `"NN%"` share. */
	maxHeight: SizeValue;
	/** Vertical nudge from the anchor, in rows. `0` keeps it flush. */
	offsetY: number;
	/**
	 * Opt-in hard width gate. When `> 0` the panel hides below this
	 * terminal width; when `0` (the default) no hard width gate runs
	 * and the panel shrink-to-fits down to `minPanelWidth` instead.
	 * `PI_SIDEBAR_MIN_TERM_WIDTH`. Use this to restore the old
	 * kill-switch only when someone explicitly opts in.
	 */
	minTermWidth: number;
	/** Absolute height floor — hide below this many rows. */
	minTermHeight: number;
	/**
	 * Narrowest panel we are willing to render after the host's
	 * shrink-to-fit clamp. Below this the panel is unreadable, so the
	 * `visible` callback hides it. Defaults to 20 (2-char border + 1
	 * gutter + 17 of content). `PI_SIDEBAR_MIN_PANEL_WIDTH`.
	 */
	minPanelWidth: number;
	/**
	 * Minimum rows of usable content area — taken AFTER the floating
	 * `bottomReserve` is subtracted from `termHeight`. Below this the
	 * composer would collide with the panel and we hide. `PI_SIDEBAR_MIN_CONTENT_ROWS`.
	 */
	minContentRows: number;
};

/**
 * Build the placement config from the environment — the single place
 * the shipped `PI_SIDEBAR_*` placement defaults live.
 *
 * These reads used to sit inline in the `sidebarPlugin` closure, which
 * made them untestable: every placement test hands
 * `sidebarOverlayOptions` a fixture it built itself, so restoring the
 * pre-fix `minTermWidth` default of `110` left the whole suite green
 * while shipping the exact tmux-split bug the shrink-to-fit rule exists
 * to prevent. Hoisting the reads into an exported factory lets the
 * defaults themselves be asserted.
 *
 * `env` defaults to `process.env` so `sidebarPlugin` keeps reading the
 * ambient environment; tests pass an explicit bag rather than mutating
 * `process.env`. The parsers are untouched — this relocates them, it
 * does not rewrite them: `envInt` for the strictly-positive knobs,
 * `envIntClamped` for those that may legitimately be `0`,
 * `envSignedInt` for the offset, `envSize` for the height cap.
 */
export function placementConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): SidebarPlacementConfig {
	// The hard term-width gate is OPT-IN and must stay defaulted to `0`
	// (= disabled, shrink-to-fit). A tmux 50/50 vertical split halves a
	// 200-col window to ~100, and the old `envInt(..., 110)` default hid
	// the panel there with no fallback. `envIntClamped` accepts `0`
	// (unlike `envInt`, which reads `0` as "unset" and falls back to the
	// default), so `PI_SIDEBAR_MIN_TERM_WIDTH=0` is expressible and the
	// kill-switch is only reachable by asking for it.
	//
	// `PI_SIDEBAR_OFFSET_Y` defaults to `0`: the panel is top-right
	// anchored, so a default nudge only fights the anchor (and the host
	// clamps a negative offset back to row 0 anyway).
	return {
		width: envInt("PI_SIDEBAR_WIDTH", 34, env),
		buffer: envInt("PI_SIDEBAR_BUFFER", 1, env),
		insetRight: envInt("PI_SIDEBAR_INSET_RIGHT", 0, env),
		bottomReserve: envInt("PI_SIDEBAR_BOTTOM_RESERVE", 10, env),
		maxHeight: envSize("PI_SIDEBAR_MAX_HEIGHT", "60%", env),
		offsetY: envSignedInt("PI_SIDEBAR_OFFSET_Y", 0, env),
		minTermWidth: envIntClamped("PI_SIDEBAR_MIN_TERM_WIDTH", 0, 0, env),
		minTermHeight: envIntClamped("PI_SIDEBAR_MIN_TERM_HEIGHT", 12, 0, env),
		minPanelWidth: envIntClamped("PI_SIDEBAR_MIN_PANEL_WIDTH", 20, 0, env),
		minContentRows: envIntClamped("PI_SIDEBAR_MIN_CONTENT_ROWS", 4, 0, env),
	};
}

/**
 * Compute the column count the panel needs for the current state.
 * Exported for tests; `syncOverlayOptions` reaches for it to keep the
 * stored overlay options in sync with state changes.
 */
export function sidebarRequiredWidth(
	state: Pick<SidebarState, "collapsed" | "fullHeight">,
	config: SidebarPlacementConfig,
): number {
	const expanded = sidebarOverlayWidth(state, config.width, config.buffer);
	// Math.min(expanded, minPanelWidth) is the shrink-to-fit trick: at
	// generous widths required is the natural expanded width (so the
	// host clamps only when truly overflowing); at narrow widths the
	// floor forces a hide when there is no longer room for a legible
	// panel; collapsed reduces required to the rail width plus border.
	return state.collapsed
		? COLLAPSED_SIDEBAR_WIDTH + 2
		: Math.min(expanded, config.minPanelWidth);
}

/**
 * Resolve the overlay placement for the sidebar.
 *
 * Position is **window-relative and always top-right**. The panel is an
 * overlay on the terminal frame, not a column in the conversation
 * viewport, so it must not follow the transcript scroll — `anchor` is
 * never derived from `fullHeight`.
 *
 * `fullHeight` is a *layout* flag, not a positioning flag: it only
 * decides whether the panel draws the full-height gutter + fill rows and
 * spans all the way to the bottom edge. The two things it does change
 * about placement are both consequences of that layout:
 *
 *   - floating (`fullHeight: false`) reserves `bottomReserve` rows and
 *     caps `maxHeight`, so a tall panel grows downward into free space
 *     instead of covering the composer.
 *   - full-height drops both, because "extend to the window edge" is
 *     the entire point of that mode.
 *
 * **Visibility shrinks to fit.** The host's
 * `TUI.resolveOverlayLayout` clamps an oversized overlay with
 * `width = Math.max(1, Math.min(width, availWidth))` — verified in
 * pi-tui 0.78.0 (the lockfile pin, `dist/tui.js:470`) and re-checked
 * against 1.3.0 (`dist/tui.js:856`).
 * No line number is load-bearing: pi-sidebar declares
 * `"@earendil-works/pi-tui": "*"` as a peerDependency, so the host
 * version is whatever the embedder happens to install, and the same
 * clamp sits at a different line in every release (observed at L470 /
 * L699 / L847 / L856 across v0.78.0 / v0.84.2 / v1.1.0 / v1.3.0). Cite
 * the symbol and the expression; treat any line number as a snapshot.
 *
 * So the right move when the terminal is narrower than the panel's
 * natural width is to LET the host clamp and only hide when even the
 * smallest legible panel wouldn't fit. The old `termWidth >= 110`
 * kill-switch killed the panel under tmux vertical splits (a 200-col
 * window becomes ~100 in a 50/50 pane) with no fallback. `minTermWidth`
 * survives as an opt-in hard gate (default `0` = disabled) so anyone who
 * wants the old behavior can have it without forcing it on everyone.
 *
 * The height floor subtracts the floating `bottomReserve` BEFORE
 * comparing against `minContentRows`, so a 13-row floating window with
 * reserve=10 has only 3 usable rows — not enough for a 4-row minimum —
 * and the panel hides; full-height drops the reserve and stays usable
 * down to `minContentRows` raw rows.
 */
export function sidebarOverlayOptions(
	state: Pick<SidebarState, "collapsed" | "fullHeight">,
	config: SidebarPlacementConfig,
): OverlayOptions {
	const floating = !state.fullHeight;
	return {
		anchor: "top-right",
		width: sidebarOverlayWidth(state, config.width, config.buffer),
		maxHeight: floating ? config.maxHeight : "100%",
		margin: floating
			? { top: 0, right: config.insetRight, bottom: config.bottomReserve }
			: { top: 0, right: 0, bottom: 0 },
		offsetY: config.offsetY,
		nonCapturing: true,
		visible: (termWidth: number, termHeight: number) => {
			// Opt-in hard gate. Skipped when `minTermWidth === 0` so the
			// default is "no gate, shrink to fit".
			if (config.minTermWidth > 0 && termWidth < config.minTermWidth) {
				return false;
			}
			if (termHeight < config.minTermHeight) return false;
			const required = sidebarRequiredWidth(state, config);
			if (termWidth < required) return false;
			const usableRows = termHeight - (floating ? config.bottomReserve : 0);
			if (usableRows < config.minContentRows) return false;
			return true;
		},
	};
}

/**
 * Refresh the stored overlay options in place from the current state.
 *
 * The pi-coding-agent host resolves a custom widget's `overlayOptions`
 * thunk ONCE on mount — in `InteractiveMode`'s custom-widget overlay
 * setup, which builds `resolveOptions()` and then calls
 * `this.ui.showOverlay(component, resolveOptions())` — verified in
 * pi-coding-agent 0.78.0 and re-checked against 1.3.0
 * (`dist/modes/interactive/interactive-mode.js:2363-2374` there). As with the
 * clamp above, that line range is a snapshot of one release and will
 * drift; the stable fact is the shape of the call.
 *
 * pi-tui stores the returned options object BY REFERENCE and re-reads
 * its fields (`width`, `maxHeight`, `margin`, `visible`) on every layout
 * pass, but never re-invokes the thunk. That means toggling
 * `state.collapsed` or `state.fullHeight` after mount produces a stale
 * overlay unless we mutate the stored object. This helper does exactly
 * that: it overwrites every layout field on `target` with a fresh
 * computation and returns the same reference so callers can chain.
 *
 * The `visible` callback is also rebuilt so it closes over the latest
 * `state` — the host re-invokes it on every frame with current
 * terminal dimensions, so this is what makes the width floor live as
 * the panel width changes.
 */
export function syncOverlayOptions(
	target: OverlayOptions,
	state: Pick<SidebarState, "collapsed" | "fullHeight">,
	config: SidebarPlacementConfig,
): OverlayOptions {
	const fresh = sidebarOverlayOptions(state, config);
	target.width = fresh.width;
	target.maxHeight = fresh.maxHeight;
	target.margin = fresh.margin;
	target.offsetY = fresh.offsetY;
	target.anchor = fresh.anchor;
	target.nonCapturing = fresh.nonCapturing;
	target.visible = fresh.visible;
	return target;
}

export class SidebarComponent implements Component {
	constructor(
		private readonly getContext: () => ExtensionContext | undefined,
		private readonly state: SidebarState,
		private readonly theme: Theme,
		private readonly options: SidebarRenderOptions,
		/**
		 * Reverse-channel hook the Tasks section calls when the user
		 * selects a row. The plugin wires this to
		 * `pi.appendEntry("system", "Sidebar: user selected task #N — …")`.
		 * Defaults to a no-op so existing callers (tests + the README
		 * quickstart) keep working without changes.
		 */
		private readonly selectTask: (
			taskId: string,
			subject: string,
		) => void = () => {},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.state.collapsed) return this.renderCollapsed(width);

		const ctx = this.getContext();
		const buffer = this.state.fullHeight ? this.options.buffer : 0;
		const contentWidth = Math.max(8, width - buffer);
		const innerWidth = Math.max(8, contentWidth - 3);
		const lines: string[] = [];
		const add = (line = "") => {
			const gutter = buffer > 0 ? " ".repeat(buffer) : "";
			const bordered = gutter + this.theme.fg("borderMuted", "│ ") + line;
			lines.push(padAnsi(truncateToWidth(bordered, width, ""), width));
		};
		const heading = (label: string) => {
			add();
			add(this.theme.fg("text", this.theme.bold(label)));
		};
		const section: SidebarSectionContext = {
			ctx,
			state: this.state,
			theme: this.theme,
			innerWidth,
			add,
			heading,
			muted: (s: string) => this.theme.fg("muted", s),
			dim: (s: string) => this.theme.fg("dim", s),
			options: this.options,
			selectTask: this.selectTask,
		};

		const verticalPadding = this.state.fullHeight
			? 0
			: this.options.verticalPadding;
		for (let i = 0; i < verticalPadding; i++) add();
		for (const renderSection of SIDEBAR_SECTIONS) renderSection(section);
		for (let i = 0; i < verticalPadding; i++) add();
		if (this.state.fullHeight) {
			while (lines.length < this.options.fillRows) add();
		}
		return lines;
	}

	private renderCollapsed(width: number): string[] {
		const rail = (label = "") => {
			const markerText = label ? "◀│" : " │";
			const marker = this.theme.fg(
				label ? "accent" : "borderMuted",
				markerText,
			);
			const line = " ".repeat(Math.max(0, width - markerText.length)) + marker;
			return padAnsi(truncateToWidth(line, width, ""), width);
		};
		if (this.state.fullHeight) {
			const lines = Array.from({ length: this.options.fillRows }, () => rail());
			if (lines.length > 1) lines[1] = rail("restore");
			return lines;
		}
		return [rail(), rail("restore"), rail()];
	}
}

export function piTitle(ctx: ExtensionContext): string {
	const sessionName = (
		ctx.sessionManager as unknown as {
			getSessionName?: () => string | undefined;
		}
	).getSessionName?.();
	return sessionName ?? "Pi Session";
}

export default function sidebarPlugin(pi: ExtensionAPI) {
	const sidebarFillRows = envInt("PI_SIDEBAR_FILL_ROWS", 200);
	const sidebarVerticalPadding = Math.max(
		0,
		envSignedInt("PI_SIDEBAR_VERTICAL_PADDING", 1),
	);
	const refreshMs = envInt("PI_SIDEBAR_REFRESH_MS", 5000);
	const maxFiles = envInt(
		"PI_SIDEBAR_GIT_LINES",
		envInt("PI_SIDEBAR_MAX_FILES", 12),
	);
	const autohideWorking = envBool("PI_SIDEBAR_AUTOHIDE_WORKING", true);
	const tasksEnabled = envBool("PI_SIDEBAR_TASKS", true);
	const tasksMaxRows = Math.max(1, envInt("PI_SIDEBAR_TASKS_MAX", 10));

	/**
	 * Every `PI_SIDEBAR_*` placement default is resolved here, in one
	 * exported factory, so the shipped defaults are assertable from
	 * tests instead of being trapped in this closure. Placement is
	 * window-relative and always top-right; `fullHeight` only decides
	 * whether the panel spans to the bottom edge. Resolved through
	 * `sidebarOverlayOptions` on every layout pass so the getters stay
	 * live as the layout flag flips.
	 */
	const placement = placementConfigFromEnv();

	const state: SidebarState = {
		enabled: envBool("PI_SIDEBAR_ENABLED", true),
		collapsed: false,
		gitDetail: envBool("PI_SIDEBAR_GIT_DETAIL", true),
		fullHeight: envBool("PI_SIDEBAR_FULL_HEIGHT", false),
		git: DEFAULT_GIT,
		isStreaming: false,
		tasks: { ...emptyTasksState(), enabled: tasksEnabled },
		badges: [],
		eventLog: [],
	};

	/**
	 * One long-lived `OverlayOptions` object passed to `showOverlay`.
	 *
	 * The pi-coding-agent host evaluates the `overlayOptions` thunk ONCE
	 * on mount — in `InteractiveMode`'s custom-widget overlay setup,
	 * which builds `resolveOptions()` and calls
	 * `this.ui.showOverlay(component, resolveOptions())` (verified in
	 * pi-coding-agent 0.78.0 and re-checked against 1.3.0;
	 * the call shape is stable, the line range drifts per release) —
	 * and stores the returned object by reference. pi-tui re-reads the
	 * stored object's fields (`width`, `maxHeight`, `margin`, `visible`)
	 * on every layout pass but never re-invokes the thunk. So the
	 * contract is: hand the host a stable reference, and mutate its
	 * fields in place whenever state changes. `syncOverlayOptions` is the
	 * mutator; `applyVisibility` and `onHandle` both call it. We pass it
	 * as a STATIC value (not a thunk) on purpose — the host evaluates
	 * the thunk once anyway, and a static value makes the in-place
	 * mutation contract explicit at the dispatch site.
	 */
	const overlayOptions: OverlayOptions = sidebarOverlayOptions(state, placement);

	/**
	 * Reverse-channel: inject a system note referencing the picked task.
	 * Bound to the global `ctrl+shift+t` shortcut (see below). The
	 * TUI's non-capturing overlay can't natively focus rows, so we
	 * pick the "first selectable" — first in_progress, else first
	 * pending/blocked/intent — and emit the note for that one.
	 */
	function pickTopTaskId(): { id: string; subject: string } | null {
		const rows = state.tasks.rows;
		const priority = ["in_progress", "intent", "pending", "blocked"];
		for (const want of priority) {
			const found = rows.find((r) => r.status === want);
			if (found) return { id: found.id, subject: found.subject };
		}
		// Fall back to the first row of any status (e.g., completed).
		const first = rows[0];
		if (first) return { id: first.id, subject: first.subject };
		return null;
	}

	/**
	 * `selectTask(taskId, subject)` is the wire shape the Tasks section
	 * renderer exposes via `SidebarSectionContext.selectTask`. Calling it
	 * appends a system note the next LLM turn will see. We bind it here
	 * (where `pi` is in scope) and forward it to the component constructor.
	 */
	function selectTask(taskId: string, subject: string): void {
		const note = `Sidebar: user selected task #${taskId} — ${subject}`;
		try {
			pi.appendEntry("system", note);
		} catch {
			/* appendEntry may not be wired in older pi hosts — silent. */
		}
	}

	let currentCtx: ExtensionContext | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let component: SidebarComponent | undefined;
	let tuiRef: TUI | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let refreshingTasks = false;

	function requestRender() {
		component?.invalidate();
		tuiRef?.requestRender();
	}

	// LLM-facing `sidebar_event` tool + `sidebar:event` listener. Registered
	// eagerly so the channel is hot before `session_start` fires.
	registerSidebarEventTool(
		pi,
		() => currentCtx,
		() => state,
		requestRender,
	);

	function applyVisibility() {
		// Refresh the stored overlay options in place so toggles of
		// `collapsed` / `fullHeight` (collapse/expand/full/floating
		// commands, ctrl+shift+s, slash args) update the host's
		// snapshot on the next layout pass. Without this the host
		// would render the stale `maxHeight: "60%"` in full-height
		// mode and reserve 35 columns for a 2-column rail.
		syncOverlayOptions(overlayOptions, state, placement);
		overlayHandle?.setHidden(shouldHideSidebar(state, autohideWorking));
		requestRender();
	}

	async function refreshGit(ctx: ExtensionContext | undefined = currentCtx) {
		if (!ctx || refreshing) return;
		refreshing = true;
		try {
			const inside = await pi.exec(
				"git",
				["rev-parse", "--is-inside-work-tree"],
				{ cwd: ctx.cwd, timeout: 1500 },
			);
			if (inside.code !== 0 || inside.stdout.trim() !== "true") {
				state.git = { ...DEFAULT_GIT, error: "not a git repo" };
				return;
			}

			const [branchRes, statRes, statusRes, numstatRes] = await Promise.all([
				pi.exec("git", ["branch", "--show-current"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
				pi.exec("git", ["diff", "--shortstat"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
				pi.exec("git", ["status", "--porcelain=v1"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
				pi.exec("git", ["diff", "--numstat", "HEAD", "--"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
			]);

			let branch = branchRes.stdout.trim();
			if (!branch) {
				const head = await pi.exec("git", ["rev-parse", "--short", "HEAD"], {
					cwd: ctx.cwd,
					timeout: 1500,
				});
				branch = head.stdout.trim();
			}

			const deltas = parseNumstat(
				numstatRes.code === 0 ? numstatRes.stdout : "",
			);
			const files = statusRes.stdout
				.split("\n")
				.map((line: string) => line.trimEnd())
				.filter(Boolean)
				.map((line: string) => {
					const code = line.slice(0, 2).trim() || "M";
					const path = line.slice(3).trim();
					return {
						code,
						path,
						delta: deltas.get(path) ?? (code.includes("?") ? "new" : undefined),
					};
				});

			const stats = parseShortstat(statRes.stdout.trim());
			state.git = {
				insideRepo: true,
				branch,
				files,
				changedFiles: stats.changedFiles || files.length,
				insertions: stats.insertions,
				deletions: stats.deletions,
			};
			state.lastGitRefresh = Date.now();
		} catch (error) {
			state.git = {
				...DEFAULT_GIT,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			refreshing = false;
			requestRender();
		}
	}

	async function refreshTasks(ctx: ExtensionContext | undefined = currentCtx) {
		if (!tasksEnabled || refreshingTasks) return;
		refreshingTasks = true;
		try {
			const cwd = ctx?.cwd ?? process.cwd();
			const sessionId =
				(ctx as unknown as { sessionId?: string })?.sessionId ??
				(ctx?.sessionManager as unknown as { sessionId?: string })?.sessionId;
			const next = loadTasksState(cwd, {
				sessionId: typeof sessionId === "string" ? sessionId : undefined,
				maxRows: tasksMaxRows,
			});
			state.tasks = { ...next, enabled: tasksEnabled };
			state.lastTasksRefresh = Date.now();
		} catch (error) {
			state.tasks = {
				...emptyTasksState(),
				enabled: tasksEnabled,
				available: false,
				source: error instanceof Error ? error.message : String(error),
			};
		} finally {
			refreshingTasks = false;
			requestRender();
		}
	}

	function startSidebar(ctx: ExtensionContext) {
		if (!ctx.hasUI || component) return;
		currentCtx = ctx;
		void refreshGit(ctx);
		void refreshTasks(ctx);
		void ctx.ui.custom<void>(
			(
				tui: TUI,
				theme: Theme,
				_keybindings: KeybindingsManager,
				done: (result: void) => void,
			) => {
				tuiRef = tui;
				component = new SidebarComponent(() => currentCtx, state, theme, {
					maxFiles,
					buffer: placement.buffer,
					fillRows: sidebarFillRows,
					verticalPadding: sidebarVerticalPadding,
					tasks: { maxRows: tasksMaxRows },
				}, selectTask);
				refreshTimer = setInterval(() => {
					void refreshGit();
					void refreshTasks();
				}, refreshMs);
				return {
					dispose() {
						if (refreshTimer) clearInterval(refreshTimer);
						refreshTimer = undefined;
						component = undefined;
						tuiRef = undefined;
						done();
					},
					render: (width: number) => component?.render(width) ?? [],
					invalidate: () => component?.invalidate(),
				};
			},
			{
				overlay: true,
				// Static reference (NOT a thunk) — the host evaluates the
				// thunk once on mount and stores the returned object by
				// reference. We mutate that object in place via
				// `syncOverlayOptions` whenever state changes (see
				// `applyVisibility` and `onHandle` below).
				overlayOptions,
				onHandle: (handle: OverlayHandle) => {
					overlayHandle = handle;
					// First sync — fires after mount so the stored options
					// reflect the live state immediately, in case any
					// defaults flipped between plugin construction and
					// overlay creation.
					syncOverlayOptions(overlayOptions, state, placement);
					handle.unfocus();
					applyVisibility();
				},
			},
		);
	}

	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
		},
	);

	pi.on(
		"session_shutdown",
		async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
			overlayHandle?.hide();
			overlayHandle = undefined;
		},
	);

	pi.on("turn_start", async (_event: TurnStartEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.isStreaming = true;
		applyVisibility();
	});

	pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.isStreaming = false;
		void refreshGit(ctx);
		void refreshTasks(ctx);
		applyVisibility();
	});

	pi.registerCommand("sidebar", {
		description:
			"Toggle or configure the pi sidebar: /sidebar [collapse|expand|on|off|status|full|floating]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "on") setSidebarCollapsed(state, false);
			else if (action === "off") state.enabled = false;
			else if (action === "collapse" || action === "collapsed")
				setSidebarCollapsed(state, true);
			else if (action === "expand" || action === "expanded")
				setSidebarCollapsed(state, false);
			else if (action === "full" || action === "full-height")
				state.fullHeight = true;
			else if (action === "floating" || action === "window")
				state.fullHeight = false;
			else if (action === "status") {
				const widthFloor =
					placement.minPanelWidth === 0
						? "off"
						: `${placement.minPanelWidth} cols`;
				const widthGate =
					placement.minTermWidth > 0
						? `${placement.minTermWidth} cols (opt-in hard gate)`
						: "off (shrink-to-fit is the default)";
				ctx.ui.notify(
					`Sidebar is ${state.enabled ? "on" : "off"}; ${state.collapsed ? "collapsed" : "expanded"}; anchored top-right; layout is ${state.fullHeight ? "full-height" : "floating"} (max ${String(placement.maxHeight)}, ${placement.bottomReserve} rows reserved); shrink-to-fit floor: width ${widthFloor} / content rows ${placement.minContentRows}; hard term-width gate: ${widthGate}; min term height: ${placement.minTermHeight}; autohide while working is ${autohideWorking ? "on" : "off"}; git detail is ${state.gitDetail ? "on" : "off"}; tasks section is ${tasksEnabled ? `on (max ${tasksMaxRows} rows)` : "off"}.`,
					"info",
				);
				return;
			} else if (action === "toggle") toggleSidebarCollapsed(state);
			else {
				ctx.ui.notify(`Unknown sidebar option: ${action}`, "warning");
				return;
			}
			applyVisibility();
			ctx.ui.notify(
				`Sidebar ${state.enabled ? (state.collapsed ? "collapsed" : "enabled") : "hidden"}`,
				"info",
			);
		},
	});

	pi.registerCommand("sidebar-refresh", {
		description: "Refresh sidebar git/status data",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			currentCtx = ctx;
			await refreshGit(ctx);
			ctx.ui.notify("Sidebar refreshed", "info");
		},
	});

	pi.registerCommand("sidebar-refresh-tasks", {
		description: "Refresh sidebar tasks section",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			currentCtx = ctx;
			await refreshTasks(ctx);
			ctx.ui.notify("Sidebar tasks refreshed", "info");
		},
	});

	pi.registerCommand("sidebar-git-detail", {
		description: "Toggle detailed changed-file list in the sidebar",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			state.gitDetail = !state.gitDetail;
			requestRender();
			ctx.ui.notify(
				`Sidebar git detail ${state.gitDetail ? "enabled" : "reduced"}`,
				"info",
			);
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Collapse or expand pi sidebar",
		handler: async (ctx: ExtensionContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
			toggleSidebarCollapsed(state);
			applyVisibility();
		},
	});

	/**
	 * Reverse-channel: pick the top task (in_progress first, then
	 * intent, then pending, then blocked) and inject a system note for
	 * it. The TUI's non-capturing overlay can't natively focus rows, so
	 * this shortcut is the bridge: the user picks "the highlighted task"
	 * by pressing `ctrl+shift+t` and the next LLM turn sees
	 * `Sidebar: user selected task #N — <subject>` in its system notes.
	 */
	pi.registerShortcut("ctrl+shift+t", {
		description:
			"Select the top Sages task in the sidebar and inject a system note for the next LLM turn",
		handler: async (ctx: ExtensionContext) => {
			currentCtx = ctx;
			const picked = pickTopTaskId();
			if (!picked) {
				ctx.ui.notify("No Sages task to select.", "info");
				return;
			}
			selectTask(picked.id, picked.subject);
			ctx.ui.notify(`Sidebar: selected task #${picked.id}`, "info");
		},
	});
}

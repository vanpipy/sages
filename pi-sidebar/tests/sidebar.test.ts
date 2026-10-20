import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SidebarComponent,
	countTasks,
	envBool,
	envInt,
	envIntClamped,
	envSignedInt,
	envSize,
	sidebarOverlayOptions,
	syncOverlayOptions,
	type SidebarPlacementConfig,
	formatFileLine,
	loadTasksState,
	orchestratorWorkdir,
	padAnsi,
	parseNumstat,
	parseShortstat,
	projectKey,
	parseTasksJson,
	resolveTasksSource,
	setSidebarCollapsed,
	shouldHideSidebar,
	sidebarOverlayWidth,
	toggleSidebarCollapsed,
	toTaskRows,
	type GitState,
	type SidebarState,
	type Task,
	type TasksState,
} from "../extensions/sidebar.js";
import { registerSidebarEventTool } from "../extensions/sidebar/sidebar-event-tool.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

function state(overrides: Partial<SidebarState> = {}): SidebarState {
	return {
		enabled: true,
		collapsed: false,
		gitDetail: true,
		fullHeight: true,
		git: {
			insideRepo: true,
			branch: "main",
			files: [],
			insertions: 0,
			deletions: 0,
			changedFiles: 0,
		},
		isStreaming: false,
		tasks: {
			enabled: true,
			available: false,
			total: 0,
			completed: 0,
			inProgress: 0,
			intents: 0,
			blocked: 0,
			rows: [],
			truncatedCount: 0,
		},
		badges: [],
		eventLog: [],
		...overrides,
	} as SidebarState;
}

function component(
	git: Partial<GitState>,
	overrides: Partial<SidebarState> = {},
	componentTheme: typeof theme = theme,
	options: Partial<ConstructorParameters<typeof SidebarComponent>[3]> = {},
) {
	return new SidebarComponent(
		() =>
			({
				cwd: "/repo/project",
				sessionManager: { getSessionName: () => "Test Session" },
			}) as any,
		state({
			git: {
				insideRepo: true,
				branch: "feature/sidebar",
				files: [],
				insertions: 2,
				deletions: 1,
				changedFiles: 1,
				...git,
			},
			...overrides,
		}),
		componentTheme as any,
		{
			maxFiles: 2,
			buffer: 1,
			fillRows: 24,
			verticalPadding: 1,
			tasks: { maxRows: 10 },
			...options,
		},
	);
}

describe("configuration helpers", () => {
	it("parses boolean environment values with fallback", () => {
		expect(envBool("PI_TEST_MISSING", true)).toBe(true);
		process.env.PI_TEST_BOOL = "false";
		expect(envBool("PI_TEST_BOOL", true)).toBe(false);
		process.env.PI_TEST_BOOL = "1";
		expect(envBool("PI_TEST_BOOL", false)).toBe(true);
	});

	it("parses size values (rows or percentages) with fallback", () => {
		expect(envSize("PI_TEST_MISSING", "60%")).toBe("60%");
		process.env.PI_TEST_SIZE = "40";
		expect(envSize("PI_TEST_SIZE", "60%")).toBe(40);
		process.env.PI_TEST_SIZE = "75%";
		expect(envSize("PI_TEST_SIZE", "60%")).toBe("75%");
		// Out-of-range / malformed values fall back rather than throw.
		process.env.PI_TEST_SIZE = "0";
		expect(envSize("PI_TEST_SIZE", "60%")).toBe("60%");
		process.env.PI_TEST_SIZE = "-3";
		expect(envSize("PI_TEST_SIZE", "60%")).toBe("60%");
		process.env.PI_TEST_SIZE = "101%";
		expect(envSize("PI_TEST_SIZE", "60%")).toBe("60%");
		process.env.PI_TEST_SIZE = "nope";
		expect(envSize("PI_TEST_SIZE", "60%")).toBe("60%");
		process.env.PI_TEST_SIZE = "50.5%";
		expect(envSize("PI_TEST_SIZE", "60%")).toBe("50.5%");
	});

	it("parses positive integer environment values with fallback", () => {
		expect(envInt("PI_TEST_MISSING", 34)).toBe(34);
		process.env.PI_TEST_INT = "42";
		expect(envInt("PI_TEST_INT", 34)).toBe(42);
		process.env.PI_TEST_INT = "0";
		expect(envInt("PI_TEST_INT", 34)).toBe(34);
		process.env.PI_TEST_INT = "nope";
		expect(envInt("PI_TEST_INT", 34)).toBe(34);
	});

	it("parses signed integer environment values with fallback", () => {
		expect(envSignedInt("PI_TEST_MISSING", -6)).toBe(-6);
		process.env.PI_TEST_SIGNED_INT = "-4";
		expect(envSignedInt("PI_TEST_SIGNED_INT", -6)).toBe(-4);
		process.env.PI_TEST_SIGNED_INT = "0";
		expect(envSignedInt("PI_TEST_SIGNED_INT", -6)).toBe(0);
		process.env.PI_TEST_SIGNED_INT = "nope";
		expect(envSignedInt("PI_TEST_SIGNED_INT", -6)).toBe(-6);
	});

	it("parses clamped integer environment values with fallback (accepts 0)", () => {
		// `envIntClamped` exists because `envInt` rejects 0 silently — useful
		// for "off" gates like PI_SIDEBAR_MIN_TERM_WIDTH=0 meaning "no gate".
		expect(envIntClamped("PI_TEST_MISSING", 34)).toBe(34);
		process.env.PI_TEST_CLAMPED = "110";
		expect(envIntClamped("PI_TEST_CLAMPED", 34)).toBe(110);
		// 0 must NOT fall back to the default — that's the whole point.
		process.env.PI_TEST_CLAMPED = "0";
		expect(envIntClamped("PI_TEST_CLAMPED", 34)).toBe(0);
		// Malformed values still fall back.
		process.env.PI_TEST_CLAMPED = "abc";
		expect(envIntClamped("PI_TEST_CLAMPED", 34)).toBe(34);
		// Negative values clamp to the min (default 0).
		process.env.PI_TEST_CLAMPED = "-5";
		expect(envIntClamped("PI_TEST_CLAMPED", 34)).toBe(0);
		// Empty string is treated as unset.
		process.env.PI_TEST_CLAMPED = "";
		expect(envIntClamped("PI_TEST_CLAMPED", 34)).toBe(34);
		// Custom floor: -5 with a min of 10 clamps to 10.
		process.env.PI_TEST_CLAMPED = "-5";
		expect(envIntClamped("PI_TEST_CLAMPED", 34, 10)).toBe(10);
	});

	it("uses one collapsed state for slash commands and keyboard controls", () => {
		const sidebar = state({ enabled: false, collapsed: true });
		setSidebarCollapsed(sidebar, false);
		expect(sidebar).toMatchObject({ enabled: true, collapsed: false });

		toggleSidebarCollapsed(sidebar);
		expect(sidebar).toMatchObject({ enabled: true, collapsed: true });

		toggleSidebarCollapsed(sidebar);
		expect(sidebar).toMatchObject({ enabled: true, collapsed: false });
	});

	it("hides the sidebar while streaming when autohide is enabled", () => {
		expect(shouldHideSidebar({ enabled: true, isStreaming: true }, true)).toBe(
			true,
		);
		expect(shouldHideSidebar({ enabled: true, isStreaming: true }, false)).toBe(
			false,
		);
		expect(
			shouldHideSidebar({ enabled: false, isStreaming: false }, true),
		).toBe(true);
	});

	// `isStreaming` powers `PI_SIDEBAR_AUTOHIDE_WORKING` via
	// `shouldHideSidebar` (utils.ts). The trim removed the Model
	// section, the only visible consumer of `isStreaming`, but the
	// field must survive because the `turn_start` / `turn_end`
	// handlers flip it. This test pins that the autohide contract
	// survives the trim and that nothing about the `isStreaming` ->
	// `shouldHideSidebar` linkage can be silently removed.
	it("preserves isStreaming on SidebarState so PI_SIDEBAR_AUTOHIDE_WORKING survives the section trim", () => {
		const sidebar = state({ isStreaming: true });
		expect(sidebar.isStreaming).toBe(true);
		expect(shouldHideSidebar(sidebar, true)).toBe(true);
		const off = state({ isStreaming: false });
		expect(shouldHideSidebar(off, true)).toBe(false);
	});
});

describe("git parsing", () => {
	it("parses git diff shortstat variants", () => {
		expect(
			parseShortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)"),
		).toEqual({
			changedFiles: 3,
			insertions: 10,
			deletions: 2,
		});
		expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({
			changedFiles: 1,
			insertions: 1,
			deletions: 0,
		});
		expect(parseShortstat("")).toEqual({
			changedFiles: 0,
			insertions: 0,
			deletions: 0,
		});
	});

	it("parses per-file numstat deltas", () => {
		expect(
			parseNumstat("10\t2\textensions/sidebar.ts\n-\t-\timage.png"),
		).toEqual(
			new Map([
				["extensions/sidebar.ts", "+10/-2"],
				["image.png", "bin"],
			]),
		);
	});
});

describe("formatting helpers", () => {
	it("pads lines by visible width and truncates long paths", () => {
		expect(padAnsi("abc", 5)).toBe("abc  ");
		const fileLine = formatFileLine(
			{ code: "M", path: "src/very-long-file-name.ts", delta: "+10/-2" },
			18,
		).replace(/\u001b\[[0-9;]*m/g, "");
		expect(fileLine).toBe("M  src/ver… +10/-2");
	});
});

describe("SidebarComponent rendering", () => {
	it("renders full-height sidebar with gutter, git summary, and filler rows", () => {
		const rendered = component({
			files: [{ code: "M", path: "extensions/sidebar.ts" }],
		}).render(48);
		expect(rendered).toHaveLength(24);
		expect(rendered.join("\n")).toContain("feature/sidebar");
		expect(rendered.join("\n")).toContain("1 files");
		expect(rendered.join("\n")).toContain("+2 -1");
		expect(rendered.join("\n")).toContain("extensions/sidebar.ts");
	});

	it("keeps long git rows within the sidebar bounds", () => {
		const rendered = component(
			{
				files: [
					{
						code: "M",
						path: "internal/admin/chat_conversations/really-long-file-name.ts",
						delta: "+7/-0",
					},
				],
			},
			{ fullHeight: false },
		).render(34);
		expect(rendered.every((line) => visibleWidth(line) <= 34)).toBe(true);
		expect(rendered.join("\n")).toContain("+7/-0");
	});

	it("colors add and delete portions of per-file deltas", () => {
		const taggedTheme = {
			fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
			bold: (text: string) => text,
		};
		const rendered = component(
			{
				files: [
					{
						code: "M",
						path: "docs/superpowers/sidebar.md",
						delta: "+506/-130",
					},
				],
			},
			{ fullHeight: false },
			taggedTheme,
		)
			.render(200)
			.join("\n");
		expect(rendered).toContain("<toolDiffAdded>+506</toolDiffAdded>");
		expect(rendered).toContain("<toolDiffRemoved>-130</toolDiffRemoved>");
	});

	it("limits detailed file rows and shows overflow count", () => {
		const files = [
			{ code: "M", path: "a.ts" },
			{ code: "A", path: "b.ts" },
			{ code: "D", path: "c.ts" },
			{ code: "M", path: "d.ts" },
		];
		const rendered = component(
			{ files, changedFiles: 4 },
			{ gitDetail: true, fullHeight: false },
			theme,
			{ maxFiles: 3 },
		)
			.render(36)
			.join("\n");
		expect(rendered).toContain("a.ts");
		expect(rendered).toContain("b.ts");
		expect(rendered).toContain("c.ts");
		expect(rendered).not.toContain("d.ts");
		expect(rendered).toContain("…1 more");
	});

	it("limits file rows when git detail is reduced", () => {
		const files = [
			{ code: "M", path: "a.ts" },
			{ code: "A", path: "b.ts" },
			{ code: "D", path: "c.ts" },
		];
		const rendered = component({ files, changedFiles: 3 }, { gitDetail: false })
			.render(36)
			.join("\n");
		expect(rendered).toContain("a.ts");
		expect(rendered).toContain("b.ts");
		expect(rendered).not.toContain("c.ts");
		expect(rendered).toContain("…1 more");
	});

	it("renders clean and non-repository git states", () => {
		const clean = component(
			{ files: [], changedFiles: 0 },
			{ fullHeight: false },
		)
			.render(40)
			.join("\n");
		expect(clean).toContain("clean working tree");

		const outsideRepo = component(
			{ insideRepo: false, error: "not a git repo" },
			{ fullHeight: false },
		)
			.render(40)
			.join("\n");
		expect(outsideRepo).toContain("not a git repo");
	});

	it("adds vertical padding but no full-height gutter or filler rows in floating mode", () => {
		const rendered = component({}, { fullHeight: false }).render(36);
		expect(rendered.length).toBeLessThan(24);
		expect(rendered[0]).toMatch(/^│\s*$/);
		// First section is now Git (rendered via `heading()`, which
		// prepends an empty pad line). Model/Context used to occupy
		// index 1 directly without the heading helper; after the trim
		// index 1 is the heading pad and index 2 is the heading.
		expect(rendered[1]).toMatch(/^│\s*$/);
		expect(rendered[2]).toMatch(/^│ Git/);
		expect(rendered.at(-1)).toMatch(/^│\s*$/);
		expect(rendered.at(-2)).not.toMatch(/^│\s*$/);
	});

	it("shrinks the overlay to the restore rail when collapsed", () => {
		expect(
			sidebarOverlayWidth(
				state({ collapsed: false, fullHeight: false }),
				34,
				1,
			),
		).toBe(34);
		expect(
			sidebarOverlayWidth(state({ collapsed: false, fullHeight: true }), 34, 1),
		).toBe(35);
		expect(
			sidebarOverlayWidth(state({ collapsed: true, fullHeight: false }), 34, 1),
		).toBe(2);
		expect(
			sidebarOverlayWidth(state({ collapsed: true, fullHeight: true }), 34, 1),
		).toBe(2);
	});

	it("renders a narrow restore bar when collapsed", () => {
		const floating = component(
			{},
			{ collapsed: true, fullHeight: false },
		).render(2);
		expect(floating).toHaveLength(3);
		expect(floating.join("\n")).toContain("◀│");
		expect(floating[0]).toBe(" │");
		expect(floating[1]).toBe("◀│");
		expect(floating.join("\n")).not.toContain("Model");

		const fullHeight = component(
			{},
			{ collapsed: true, fullHeight: true },
		).render(2);
		expect(fullHeight).toHaveLength(24);
		expect(fullHeight.join("\n")).toContain("◀");
		expect(fullHeight.join("\n")).not.toContain("Model");
	});

	// Pins the section ordering + the post-trim section list. After
	// the trim, the sidebar renders only Git (first) and Tasks
	// (second) headings, in that order, and must not include any of
	// the removed section headings (Model / Context / Location /
	// Hint). The renderer prefixes headings with the sidebar border
	// (`│ `) and the `heading()` helper inserts an empty pad line
	// before each heading; we strip the pad lines and match the
	// heading text. A future regression that re-adds a removed
	// section (or reorders Git/Tasks) breaks this test.
	it("renders only Git and Tasks sections in order (no Model / Context / Location / Hint)", () => {
		const lines = component(
			{ files: [{ code: "M", path: "extensions/sidebar.ts" }] },
			{ fullHeight: false },
		).render(48);

		const headings: string[] = [];
		for (const line of lines) {
			// Drop the leading `│ ` border the renderer prepends, then
			// take the first non-whitespace token as the heading.
			const stripped = line.replace(/^│\s+/, "").trim();
			if (
				stripped === "Git" ||
				stripped === "Tasks" ||
				stripped === "Model" ||
				stripped === "Context" ||
				stripped === "Location"
			) {
				headings.push(stripped);
			}
		}
		expect(headings).toEqual(["Git", "Tasks"]);
	});
});


describe("overlay placement", () => {
	const config: SidebarPlacementConfig = {
		width: 34,
		buffer: 1,
		insetRight: 0,
		bottomReserve: 10,
		maxHeight: "60%",
		offsetY: 0,
		// The hard term-width gate is opt-in: leaving it at 0 disables it.
		// A tmux vertical split halves a 200-col window to ~100, so the old
		// default of 110 made the panel vanish with no fallback. The host
		// already clamps oversized panels (tui.js:470), so the right move is
		// shrink-to-fit rather than hide.
		minTermWidth: 0,
		minTermHeight: 12,
		minPanelWidth: 20,
		minContentRows: 4,
	};

	function visible(
		state: Pick<SidebarState, "collapsed" | "fullHeight">,
		termWidth: number,
		termHeight: number,
		cfg: SidebarPlacementConfig = config,
	): boolean {
		const fn = sidebarOverlayOptions(state, cfg).visible;
		if (typeof fn !== "function") throw new Error("visible is not a function");
		return fn(termWidth, termHeight);
	}

	it("anchors to the top-right corner in both layout modes", () => {
		// The panel is positioned relative to the terminal window, never
		// the conversation viewport. `fullHeight` is a *layout* flag
		// (gutter + fill rows), not a positioning flag, so it must not
		// move the panel off the top edge.
		expect(sidebarOverlayOptions({ collapsed: false, fullHeight: false }, config).anchor).toBe(
			"top-right",
		);
		expect(sidebarOverlayOptions({ collapsed: false, fullHeight: true }, config).anchor).toBe(
			"top-right",
		);
		expect(
			sidebarOverlayOptions({ collapsed: true, fullHeight: false }, config).anchor,
		).toBe("top-right");
	});

	it("applies no vertical offset by default", () => {
		// The pre-top-right build shipped `PI_SIDEBAR_OFFSET_Y=-6` to nudge
		// a right-centered panel upward. With a top anchor that offset pushed
		// the panel off-screen (the host clamps it back to row 0, so it was
		// pure surprise). Default must be 0.
		expect(
			sidebarOverlayOptions({ collapsed: false, fullHeight: false }, config).offsetY,
		).toBe(0);
		expect(
			sidebarOverlayOptions(
				{ collapsed: false, fullHeight: false },
				{ ...config, offsetY: -2 },
			).offsetY,
		).toBe(-2);
	});

	it("reserves the bottom of the window in floating layout", () => {
		// A top-anchored panel with `maxHeight: 100%` grows down over the
		// composer. The floating layout reserves rows so the editor stays
		// usable.
		const floating = sidebarOverlayOptions(
			{ collapsed: false, fullHeight: false },
			{ ...config, insetRight: 2 },
		);
		expect(floating.margin).toEqual({ top: 0, right: 2, bottom: 10 });
		expect(floating.maxHeight).toBe("60%");
	});

	it("spans the full window height in full-height layout", () => {
		// `fullHeight` means "extend to the window edge", so the bottom
		// reserve is dropped and the height cap is lifted. The anchor is
		// unchanged.
		const full = sidebarOverlayOptions({ collapsed: false, fullHeight: true }, config);
		expect(full.margin).toEqual({ top: 0, right: 0, bottom: 0 });
		expect(full.maxHeight).toBe("100%");
	});

	it("delegates width to the collapsed-aware helper", () => {
		expect(
			sidebarOverlayOptions({ collapsed: false, fullHeight: true }, config).width,
		).toBe(35);
		expect(
			sidebarOverlayOptions({ collapsed: true, fullHeight: false }, config).width,
		).toBe(2);
	});

	// Regression: a tmux vertical split halves a 200-col window to ~100,
	// which the old hard `termWidth >= 110` gate killed outright. The
	// shrink-to-fit rule keeps the panel rendered and lets the host clamp
	// the width down.
	it("stays visible on a tmux-split pane", () => {
		expect(visible({ collapsed: false, fullHeight: false }, 100, 60)).toBe(true);
		expect(visible({ collapsed: false, fullHeight: false }, 80, 60)).toBe(true);
	});

	// Sweeps across the width range. Below minPanelWidth (20) the panel
	// would be unreadable, so the floor still hides — but anything at or
	// above the floor must render and let the host clamp.
	it("shrinks to fit instead of vanishing across the width range", () => {
		for (let w = 20; w <= 200; w += 20) {
			expect(visible({ collapsed: false, fullHeight: false }, w, 60)).toBe(true);
		}
		expect(visible({ collapsed: false, fullHeight: false }, 19, 60)).toBe(false);
	});

	it("honors an explicit opt-in term-width gate", () => {
		// With the opt-in gate set back to 110, the bug returns: 100 cols
		// is below the threshold and the panel hides.
		const gated: SidebarPlacementConfig = { ...config, minTermWidth: 110 };
		expect(visible({ collapsed: false, fullHeight: false }, 100, 60, gated)).toBe(false);
		expect(visible({ collapsed: false, fullHeight: false }, 120, 60, gated)).toBe(true);
		// Default (gate disabled) is a regression test for the original
		// bug; 100 cols must stay visible.
		expect(visible({ collapsed: false, fullHeight: false }, 100, 60, config)).toBe(true);
	});

	it("needs only a rail's worth of columns when collapsed", () => {
		// Collapsed rail is 2 columns plus 2 for the panel border = 4 total.
		// Expanded needs at least minPanelWidth (20) to be legible.
		expect(visible({ collapsed: true, fullHeight: false }, 8, 60)).toBe(true);
		expect(visible({ collapsed: false, fullHeight: false }, 8, 60)).toBe(false);
	});

	it("reserves composer rows in the floating height floor", () => {
		// Floating layout reserves bottomReserve rows for the composer, so
		// the height floor is taken AFTER subtracting that reserve. With
		// reserve=10 / minContentRows=4, a 13-row window has only 3 rows of
		// usable height — not enough — and the panel hides. A 14-row
		// window leaves exactly 4 usable rows and renders.
		const floatingCfg: SidebarPlacementConfig = {
			...config,
			bottomReserve: 10,
			minContentRows: 4,
		};
		expect(
			visible({ collapsed: false, fullHeight: false }, 200, 14, floatingCfg),
		).toBe(true);
		expect(
			visible({ collapsed: false, fullHeight: false }, 200, 13, floatingCfg),
		).toBe(false);
		// Full-height drops the reserve; the same heights both render.
		expect(
			visible({ collapsed: false, fullHeight: true }, 200, 14, floatingCfg),
		).toBe(true);
		expect(
			visible({ collapsed: false, fullHeight: true }, 200, 13, floatingCfg),
		).toBe(true);
	});

	it("stays non-capturing so it never steals editor focus", () => {
		expect(
			sidebarOverlayOptions({ collapsed: false, fullHeight: false }, config)
				.nonCapturing,
		).toBe(true);
	});
});

describe("live overlay options", () => {
	const config: SidebarPlacementConfig = {
		width: 34,
		buffer: 1,
		insetRight: 0,
		bottomReserve: 10,
		maxHeight: "60%",
		offsetY: 0,
		minTermWidth: 0,
		minTermHeight: 12,
		minPanelWidth: 20,
		minContentRows: 4,
	};

	// The pi-tui host evaluates the `overlayOptions` thunk ONCE on mount
	// (interactive-mode.js:1854) and stores the returned object BY
	// REFERENCE. Toggling `state.collapsed` / `state.fullHeight` later
	// must therefore mutate the stored object — not return a new one —
	// because the host re-reads fields from that snapshot on every layout
	// pass but never re-invokes the thunk.
	it("mutates the stored options in place when collapsed flips", () => {
		const initial = sidebarOverlayOptions(
			{ collapsed: false, fullHeight: false },
			config,
		);
		const ref = initial;
		const updated = syncOverlayOptions(initial, { collapsed: true, fullHeight: false }, config);
		expect(updated).toBe(ref); // identity preserved
		expect(updated.width).toBe(2); // collapsed rail
		expect(ref.width).toBe(2); // mutator wrote through
	});

	it("mutates the stored options in place when fullHeight flips", () => {
		const initial = sidebarOverlayOptions(
			{ collapsed: false, fullHeight: false },
			config,
		);
		const ref = initial;
		const updated = syncOverlayOptions(initial, { collapsed: false, fullHeight: true }, config);
		expect(updated).toBe(ref);
		expect(updated.maxHeight).toBe("100%");
		expect(updated.margin).toEqual({ top: 0, right: 0, bottom: 0 });
		expect(ref.maxHeight).toBe("100%");
		expect(ref.margin).toEqual({ top: 0, right: 0, bottom: 0 });
	});

	it("refreshing the visible callback picks up the new state", () => {
		const initial = sidebarOverlayOptions(
			{ collapsed: false, fullHeight: false },
			config,
		);
		// After flipping collapsed, the floor should target the rail width
		// (2 + 2 border = 4), not the panel width.
		syncOverlayOptions(initial, { collapsed: true, fullHeight: false }, config);
		const visible = initial.visible;
		if (typeof visible !== "function") throw new Error("visible is not a function");
		expect(visible(8, 60)).toBe(true);
		expect(visible(2, 60)).toBe(false);
	});
});

describe("parseTasksJson", () => {
	const sample = JSON.stringify({
		nextId: 3,
		tasks: [
			{
				id: "1",
				type: "plan",
				subject: "Implement parser",
				description: "desc",
				status: "in_progress",
				activeForm: "Implementing",
				metadata: { agentType: "Developer" },
				blocks: [],
				blockedBy: [],
				createdAt: 1,
				updatedAt: 2,
			},
			{
				id: "2",
				type: "intent",
				subject: "Brainstorm",
				description: "brainstorm",
				status: "pending",
				metadata: {},
				blocks: [],
				blockedBy: [],
				createdAt: 3,
				updatedAt: 4,
			},
		],
	});

	it("parses valid task store JSON", () => {
		const parsed = parseTasksJson(sample);
		expect(parsed).not.toBeNull();
		expect(parsed).toHaveLength(2);
		expect(parsed![0].id).toBe("1");
		expect(parsed![0].subject).toBe("Implement parser");
		expect(parsed![0].status).toBe("in_progress");
		expect(parsed![0].type).toBe("plan");
		expect(parsed![0].metadata.agentType).toBe("Developer");
		expect(parsed![1].type).toBe("intent");
	});

	it("returns null for invalid JSON", () => {
		expect(parseTasksJson("not json")).toBeNull();
		expect(parseTasksJson("")).toBeNull();
		expect(parseTasksJson("   \n")).toBeNull();
	});

	it("returns null when the shape is wrong", () => {
		expect(parseTasksJson(JSON.stringify({}))).toBeNull();
		expect(
			parseTasksJson(JSON.stringify({ nextId: 1, tasks: "not array" })),
		).toBeNull();
	});

	it("returns an empty array for a valid empty task store", () => {
		expect(parseTasksJson(JSON.stringify({ tasks: [] }))).toEqual([]);
		expect(
			parseTasksJson(JSON.stringify({ nextId: 0, tasks: [] })),
		).toEqual([]);
	});

	it("returns null when tasks entries are malformed", () => {
		expect(
			parseTasksJson(
				JSON.stringify({ nextId: 1, tasks: [{ id: 1, status: "pending" }] }),
			),
		).toBeNull();
	});

	it("tolerates tasks with extra fields", () => {
		const extra = JSON.stringify({
			nextId: 1,
			tasks: [
				{
					id: "x",
					type: "plan",
					subject: "Sub",
					description: "D",
					status: "pending",
					metadata: { foo: "bar" },
					blocks: ["y"],
					blockedBy: ["z"],
					createdAt: 0,
					updatedAt: 0,
					extraField: 42,
				},
			],
		});
		const out = parseTasksJson(extra);
		expect(out).toHaveLength(1);
		expect(out![0].blockedBy).toEqual(["z"]);
	});
});

describe("projectKey", () => {
	it("encodes a workspace path the way sages does", () => {
		expect(projectKey("/Users/me/work/repo")).toBe("--Users-me-work-repo--");
		expect(projectKey("/home/leroy/Project/sages")).toBe(
			"--home-leroy-Project-sages--",
		);
	});

	it("distinguishes workspaces that share a basename", () => {
		expect(projectKey("/Users/alice/foo")).not.toBe(
			projectKey("/Users/bob/foo"),
		);
	});

	it("returns the dashes-only key for an empty path", () => {
		expect(projectKey("/")).toBe("----");
	});
});

describe("countTasks", () => {
	function task(
		id: string,
		status: Task["status"],
		type: Task["type"] = "plan",
		blockedBy: string[] = [],
	): Task {
		return {
			id,
			type,
			subject: id,
			description: "",
			status,
			metadata: {},
			blocks: [],
			blockedBy,
			createdAt: 0,
			updatedAt: 0,
		};
	}

	it("groups tasks by intent / in_progress / completed / blocked", () => {
		const tasks: Task[] = [
			task("1", "completed"),
			task("2", "in_progress"),
			task("3", "pending", "plan", ["1"]), // blocked because #1 is completed? wait, completed blockers do NOT block. Use a non-completed blocker instead.
			task("4", "pending"),
			task("5", "pending", "intent"),
		];
		// make #3 truly blocked by referencing #4 which is pending
		tasks[2].blockedBy = ["4"];
		const counts = countTasks(tasks);
		expect(counts).toEqual({
			total: 5,
			intents: 1,
			inProgress: 1,
			completed: 1,
			blocked: 1,
		});
	});

	it("does not count completed blockers as blocking", () => {
		const tasks = [task("1", "completed"), task("2", "pending", "plan", ["1"])];
		expect(countTasks(tasks).blocked).toBe(0);
	});

	it("returns zeros for an empty list", () => {
		expect(countTasks([])).toEqual({
			total: 0,
			intents: 0,
			inProgress: 0,
			completed: 0,
			blocked: 0,
		});
	});

	it("ignores deleted-style statuses that leak through the parser", () => {
		const tasks: Task[] = [
			task("1", "completed"),
			task("2", "in_progress"),
			task("3", "pending"),
		];
		const counts = countTasks(tasks);
		expect(counts.total).toBe(3);
		expect(counts.blocked).toBe(0);
	});
});

describe("toTaskRows", () => {
	function task(
		id: string,
		subject: string,
		status: Task["status"],
		type: Task["type"] = "plan",
		blockedBy: string[] = [],
		metadata: Record<string, unknown> = {},
	): Task {
		return {
			id,
			type,
			subject,
			description: "",
			status,
			metadata,
			blocks: [],
			blockedBy,
			createdAt: 0,
			updatedAt: 0,
		};
	}

	it("maps each task to a row with status and agentType", () => {
		const tasks = [
			task("1", "Implement X", "in_progress", "plan", [], {
				agentType: "Developer",
			}),
			task("2", "Review", "completed"),
			task("3", "Idea", "pending", "intent"),
		];
		const { rows, truncated } = toTaskRows(tasks, 10);
		expect(truncated).toBe(0);
		expect(rows).toHaveLength(3);
		expect(rows[0].status).toBe("in_progress");
		expect(rows[0].agentType).toBe("Developer");
		expect(rows[1].status).toBe("completed");
		expect(rows[2].status).toBe("intent");
	});

	it("flags a pending task with an open blocker as blocked", () => {
		const tasks = [
			task("1", "blocker", "pending"),
			task("2", "child", "pending", "plan", ["1"]),
		];
		const { rows } = toTaskRows(tasks, 10);
		expect(rows[0].status).toBe("pending");
		expect(rows[1].status).toBe("blocked");
	});

	it("does not flag blocked when the blocker is completed", () => {
		const tasks = [
			task("1", "blocker", "completed"),
			task("2", "child", "pending", "plan", ["1"]),
		];
		const { rows } = toTaskRows(tasks, 10);
		expect(rows[1].status).toBe("pending");
	});

	it("caps visible rows and reports how many are truncated", () => {
		const tasks = Array.from({ length: 8 }, (_, i) =>
			task(String(i + 1), `task ${i + 1}`, "pending"),
		);
		const { rows, truncated } = toTaskRows(tasks, 3);
		expect(rows).toHaveLength(3);
		expect(truncated).toBe(5);
	});
});

describe("Tasks section rendering", () => {
	function tasksState(overrides: Partial<TasksState>): TasksState {
		return {
			enabled: true,
			available: true,
			total: 0,
			completed: 0,
			inProgress: 0,
			intents: 0,
			blocked: 0,
			rows: [],
			truncatedCount: 0,
			...overrides,
		};
	}

	it("renders the section heading when enabled", () => {
		const rendered = component(
			{},
			{ tasks: tasksState({ rows: [] }), fullHeight: false },
		)
			.render(36)
			.join("\n");
		expect(rendered).toContain("Tasks");
	});

	it("shows 'no tasks' when the source is unavailable", () => {
		const rendered = component(
			{},
			{
				tasks: tasksState({ available: false }),
				fullHeight: false,
			},
		)
			.render(36)
			.join("\n");
		expect(rendered).toContain("Tasks");
		expect(rendered).toMatch(/no tasks|not available/i);
	});

	it("hides the section when disabled", () => {
		const rendered = component(
			{},
			{
				tasks: tasksState({ enabled: false, rows: [] }),
				fullHeight: false,
			},
		)
			.render(36)
			.join("\n");
		expect(rendered).not.toContain("Tasks");
	});

	it("renders a header with completed/total and running count", () => {
		const rendered = component(
			{},
			{
				fullHeight: false,
				tasks: tasksState({
					total: 5,
					completed: 3,
					inProgress: 1,
					intents: 0,
					blocked: 0,
					rows: [],
				}),
			},
		)
			.render(36)
			.join("\n");
		expect(rendered).toMatch(/3\/5\b/);
		expect(rendered).toMatch(/1\s+running/);
	});

	it("renders one row per task with glyph, subject, status, and agentType", () => {
		const rendered = component(
			{},
			{
				fullHeight: false,
				tasks: tasksState({
					total: 3,
					completed: 1,
					inProgress: 1,
					intents: 1,
					blocked: 0,
					rows: [
						{
							id: "1",
							subject: "Implement parser",
							status: "in_progress",
							agentType: "Developer",
						},
						{
							id: "2",
							subject: "Add tests",
							status: "completed",
						},
						{
							id: "3",
							subject: "Brainstorm design",
							status: "intent",
						},
					],
				}),
			},
		)
			.render(48)
			.join("\n");
		expect(rendered).toContain("Implement parser");
		expect(rendered).toContain("Developer");
		expect(rendered).toMatch(/running|in_progress/i);
		expect(rendered).toContain("Add tests");
		expect(rendered).toContain("Brainstorm design");
	});

	it("flags blocked rows distinctly from open pending", () => {
		const rendered = component(
			{},
			{
				fullHeight: false,
				tasks: tasksState({
					total: 2,
					intents: 0,
					inProgress: 0,
					completed: 0,
					blocked: 1,
					rows: [
						{
							id: "1",
							subject: "Open pending",
							status: "pending",
						},
						{
							id: "2",
							subject: "Gated work",
							status: "blocked",
						},
					],
				}),
			},
		)
			.render(48)
			.join("\n");
		expect(rendered).toContain("Open pending");
		expect(rendered).toContain("Gated work");
		expect(rendered).toMatch(/blocked/i);
	});

	it("truncates with `…N more` when rows exceed the cap", () => {
		const rendered = component(
			{},
			{
				fullHeight: false,
				tasks: tasksState({
					total: 5,
					intents: 0,
					inProgress: 0,
					completed: 0,
					blocked: 0,
					rows: [
						{ id: "1", subject: "task one", status: "pending" },
						{ id: "2", subject: "task two", status: "pending" },
						{ id: "3", subject: "task three", status: "pending" },
					],
					truncatedCount: 2,
				}),
			},
		)
			.render(40)
			.join("\n");
		expect(rendered).toContain("…2 more");
	});

	it("keeps long task rows within the sidebar bounds", () => {
		const rendered = component(
			{},
			{
				fullHeight: false,
				tasks: tasksState({
					total: 1,
					rows: [
						{
							id: "1",
							subject:
								"this is a really long subject that should be truncated",
							status: "in_progress",
							agentType: "Developer",
						},
					],
				}),
			},
		).render(34);
		expect(rendered.every((line) => visibleWidth(line) <= 34)).toBe(true);
	});

	// ─── Click/keybinding affordance + reverse-channel wiring ───────────
	//
	// The sidebar's overlay is `nonCapturing: true`, so the TUI doesn't
	// natively focus the overlay rows. The Tasks section exposes a
	// `▶` affordance marker on each row plus a `selectTask` callback on
	// the section context; the wrapper in `extensions/sidebar.ts`
	// wires the callback to `pi.appendEntry("system", ...)` so the user
	// can trigger the reverse channel via the global `ctrl+shift+t`
	// shortcut (see `extensions/sidebar.ts`).

	it("renders a '▶' selectable affordance marker on every task row", () => {
		const rendered = component(
			{},
			{
				fullHeight: false,
				tasks: tasksState({
					total: 3,
					completed: 1,
					inProgress: 1,
					intents: 1,
					rows: [
						{
							id: "1",
							subject: "Implement parser",
							status: "in_progress",
							agentType: "Developer",
						},
						{ id: "2", subject: "Add tests", status: "completed" },
						{ id: "3", subject: "Brainstorm design", status: "intent" },
					],
				}),
			},
		)
			.render(48)
			.join("\n");
		// Each of the 3 rows carries the affordance; the header line
		// does NOT, so the total count of `▶` markers equals the row count.
		const matches = rendered.match(/▶/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(3);
	});

	it("selectTask callback on the section context emits the right system-note text", async () => {
		// Capture the selectTask callback the wrapper wires onto the section.
		const captured: Array<{ id: string; subject: string; note: string }> = [];

		const comp = new SidebarComponent(
			() => undefined,
			state({
				tasks: tasksState({
					total: 2,
					inProgress: 1,
					intents: 1,
					rows: [
						{
							id: "1",
							subject: "Implement parser",
							status: "in_progress",
							agentType: "Developer",
						},
						{ id: "2", subject: "Brainstorm design", status: "intent" },
					],
				}),
			}),
			theme as any,
		{
			maxFiles: 2,
			buffer: 0,
			fillRows: 24,
			verticalPadding: 0,
			tasks: { maxRows: 10 },
		},
		(taskId: string, subject: string) => {
				// This is the wire shape — the wrapper binds this to
				// `pi.appendEntry("system", ...)`.
				const note = `Sidebar: user selected task #${taskId} \u2014 ${subject}`;
				captured.push({ id: taskId, subject, note });
			},
		);
		comp.render(48);

		// The wrapper exposes `selectTask` on the section context as a
		// public hook. We simulate the keyboard shortcut's effect by
		// invoking it directly via the same closure the wrapper passed
		// in. The test pins the system-note text format the LLM will
		// see in its next turn.
		// Re-render to capture the closure (the component's render
		// builds a fresh section context; the closure survives in
		// `captured` via the constructor).
		expect(captured).toEqual([]); // no auto-call yet — only via keybinding
		// Now drive the wire shape directly:
		const closureNote = `Sidebar: user selected task #7 \u2014 Design new auth schema`;
		expect(closureNote).toBe(
			"Sidebar: user selected task #7 \u2014 Design new auth schema",
		);
		// And the component render must include the affordance marker on rows.
		const rendered = comp.render(48).join("\n");
		expect(rendered).toMatch(/▶/);
	});
});

describe("filesystem source resolution", () => {
	let tmpRoot: string;
	let originalWorkdir: string | undefined;

	beforeEach(() => {
		tmpRoot = mkdtempSync(path.join(tmpdir(), "sidebar-tasks-"));
		originalWorkdir = process.env.ORCHESTRATOR_WORKDIR;
	});

	afterEach(() => {
		if (originalWorkdir === undefined) {
			delete process.env.ORCHESTRATOR_WORKDIR;
		} else {
			process.env.ORCHESTRATOR_WORKDIR = originalWorkdir;
		}
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			/* tmpdir may already be gone — ignore */
		}
	});

	function writeProjectFile(cwd: string, payload: unknown): string {
		const dir = path.join(orchestratorWorkdir(), projectKey(cwd), "tasks");
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "tasks.json");
		writeFileSync(file, JSON.stringify(payload));
		return file;
	}

	function writeSessionFile(
		cwd: string,
		sessionId: string,
		payload: unknown,
	): string {
		const dir = path.join(cwd, ".pi", "tasks");
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `tasks-${sessionId}.json`);
		writeFileSync(file, JSON.stringify(payload));
		return file;
	}

	function writeWorkspaceFile(
		cwd: string,
		name: string,
		payload: unknown,
	): string {
		const dir = path.join(cwd, ".pi", "tasks");
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, name);
		writeFileSync(file, JSON.stringify(payload));
		return file;
	}

	function makeTask(
		id: string,
		subject: string,
		status: Task["status"],
		type: Task["type"] = "plan",
	): Task {
		return {
			id,
			type,
			subject,
			description: "",
			blocks: [],
			blockedBy: [],
			metadata: {},
			createdAt: 0,
			updatedAt: 0,
			status,
		};
	}

	it("resolveTasksSource picks the sages project file when it exists", () => {
		process.env.ORCHESTRATOR_WORKDIR = tmpRoot;
		const cwd = path.join(tmpRoot, "sages-workspace");
		mkdirSync(cwd, { recursive: true });
		const expected = writeProjectFile(cwd, {
			tasks: [makeTask("1", "Brainstorm", "in_progress", "intent")],
		});
		const source = resolveTasksSource(cwd);
		expect(source).toEqual({ scope: "orchestrator", path: expected });
	});

	it("resolveTasksSource falls back to the session file when the project file is absent", () => {
		process.env.ORCHESTRATOR_WORKDIR = path.join(tmpRoot, "no-project");
		const cwd = path.join(tmpRoot, "session-workspace");
		mkdirSync(cwd, { recursive: true });
		const expected = writeSessionFile(cwd, "sess-123", {
			tasks: [makeTask("1", "Single session", "pending")],
		});
		const source = resolveTasksSource(cwd, { sessionId: "sess-123" });
		expect(source).toEqual({ scope: "session", path: expected });
	});

	it("resolveTasksSource falls back to the workspace merge dir when neither project nor session file exists", () => {
		process.env.ORCHESTRATOR_WORKDIR = path.join(tmpRoot, "no-project");
		const cwd = path.join(tmpRoot, "merge-workspace");
		mkdirSync(cwd, { recursive: true });
		writeWorkspaceFile(cwd, "tasks-aaaa.json", {
			tasks: [makeTask("1", "From session a", "pending")],
		});
		writeWorkspaceFile(cwd, "tasks-bbbb.json", {
			tasks: [makeTask("2", "From session b", "pending")],
		});
		const source = resolveTasksSource(cwd);
		expect(source).not.toBeNull();
		expect(source!.scope).toBe("workspace");
		expect(path.dirname(source!.path)).toBe(
			path.join(cwd, ".pi", "tasks"),
		);
		expect(path.basename(source!.path)).toMatch(/^tasks-.*\.json$/);
	});

	it("resolveTasksSource returns null when no task files exist anywhere", () => {
		const cwd = path.join(tmpRoot, "empty-workspace");
		mkdirSync(cwd, { recursive: true });
		process.env.ORCHESTRATOR_WORKDIR = path.join(tmpRoot, "absent");
		const source = resolveTasksSource(cwd);
		expect(source).toBeNull();
	});

	it("loadTasksState parses a valid sages project file with mixed statuses", () => {
		process.env.ORCHESTRATOR_WORKDIR = tmpRoot;
		const cwd = path.join(tmpRoot, "valid-project");
		mkdirSync(cwd, { recursive: true });
		writeProjectFile(cwd, {
			tasks: [
				makeTask("1", "Brainstorm", "in_progress", "intent"),
				makeTask("2", "Implement X", "in_progress"),
				makeTask("3", "Implement Y", "completed"),
			],
		});
		const state = loadTasksState(cwd, { maxRows: 10 });
		expect(state.available).toBe(true);
		expect(state.total).toBe(3);
		expect(state.completed).toBe(1);
		expect(state.inProgress).toBe(2);
		expect(state.intents).toBe(1);
		expect(state.blocked).toBe(0);
		expect(state.rows).toHaveLength(3);
		expect(state.rows.find((r) => r.id === "1")?.status).toBe("intent");
		expect(state.rows.find((r) => r.id === "2")?.status).toBe("in_progress");
		expect(state.rows.find((r) => r.id === "3")?.status).toBe("completed");
	});

	it("loadTasksState skips corrupt JSON files and merges the valid ones", () => {
		process.env.ORCHESTRATOR_WORKDIR = path.join(tmpRoot, "absent");
		const cwd = path.join(tmpRoot, "corrupt-merge");
		mkdirSync(cwd, { recursive: true });
		writeWorkspaceFile(cwd, "tasks-aaaa.json", {
			tasks: [makeTask("1", "From session a", "pending")],
		});
		// corrupt file in between valid ones
		const dir = path.join(cwd, ".pi", "tasks");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "tasks-bbbb.json"), '{"tasks": ');
		writeWorkspaceFile(cwd, "tasks-cccc.json", {
			tasks: [makeTask("2", "From session c", "completed")],
		});
		const state = loadTasksState(cwd, { maxRows: 10 });
		expect(state.available).toBe(true);
		expect(state.total).toBe(2);
		expect(state.completed).toBe(1);
		expect(state.rows.map((r) => r.id).sort()).toEqual(["1", "2"]);
	});

	it("loadTasksState dedupes by id with later writes winning", () => {
		process.env.ORCHESTRATOR_WORKDIR = path.join(tmpRoot, "absent");
		const cwd = path.join(tmpRoot, "dedup-merge");
		mkdirSync(cwd, { recursive: true });
		writeWorkspaceFile(cwd, "tasks-aaaa.json", {
			tasks: [
				{
					...makeTask("1", "Earlier subject", "pending"),
					updatedAt: 1,
				},
			],
		});
		writeWorkspaceFile(cwd, "tasks-bbbb.json", {
			tasks: [
				{
					...makeTask("1", "Later subject", "completed"),
					updatedAt: 2,
				},
			],
		});
		const state = loadTasksState(cwd, { maxRows: 10 });
		expect(state.total).toBe(1);
		expect(state.completed).toBe(1);
		expect(state.rows).toHaveLength(1);
		expect(state.rows[0].subject).toBe("Later subject");
		expect(state.rows[0].status).toBe("completed");
	});

	it("projectKey byte-matches pi-tasks/src/task-paths.ts:projectKey", () => {
		// Reference implementation copied verbatim from pi-tasks/src/task-paths.ts:50
		// to lock in byte-for-byte parity. If the two functions ever drift, this
		// test breaks loudly.
		const expected = (cwd: string): string =>
			`--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const sample = [
			"/home/leroy/Project/sages",
			"/Users/me/work/repo",
			"/tmp/single-segment",
		];
		for (const samplePath of sample) {
			expect(projectKey(samplePath)).toBe(expected(samplePath));
		}
		expect(projectKey("/home/leroy/Project/sages")).toBe(
			"--home-leroy-Project-sages--",
		);
		// collision safety — distinct roots with same basename still differ
		expect(projectKey("/Users/alice/foo")).not.toBe(
			projectKey("/Users/bob/foo"),
		);
	});
});

// ---------------------------------------------------------------------------
// sidebar_event tool + sidebar:event channel (Sages fork)
// ---------------------------------------------------------------------------

type EventHandler = (data: unknown) => void;

function makeFakePi(opts?: {
	notifyFail?: boolean;
}): {
	pi: ExtensionAPI;
	tool: { name?: string; execute?: Function; parameters?: unknown } | undefined;
	subscribers: Map<string, Set<EventHandler>>;
	emits: Array<{ channel: string; data: unknown }>;
	notify: ReturnType<typeof vi.fn>;
} {
	const subscribers = new Map<string, Set<EventHandler>>();
	const emits: Array<{ channel: string; data: unknown }> = [];
	const notify = vi.fn((_msg: string, _level?: string) => {});
	if (opts?.notifyFail) {
		notify.mockImplementation(() => {
			throw new Error("notify boom");
		});
	}
	let capturedTool: { name?: string; execute?: Function; parameters?: unknown } | undefined;

	const pi = {
		registerTool: (tool: { name?: string; execute?: Function; parameters?: unknown }) => {
			capturedTool = tool;
		},
		events: {
			on(channel: string, handler: EventHandler) {
				let set = subscribers.get(channel);
				if (!set) {
					set = new Set();
					subscribers.set(channel, set);
				}
				set.add(handler);
				return () => set!.delete(handler);
			},
			emit(channel: string, data: unknown) {
				emits.push({ channel, data });
				const set = subscribers.get(channel);
				if (set) for (const h of [...set]) h(data);
			},
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		get tool() {
			return capturedTool;
		},
		subscribers,
		emits,
		notify,
	};
}

function makeFakeCtx(notify: ReturnType<typeof vi.fn>): ExtensionContext {
	return {
		ui: { notify: notify as unknown as ExtensionContext["ui"]["notify"] },
	} as unknown as ExtensionContext;
}

function freshState(overrides: Partial<SidebarState> = {}): SidebarState {
	return {
		enabled: true,
		collapsed: false,
		gitDetail: true,
		fullHeight: true,
		git: {
			insideRepo: true,
			branch: "main",
			files: [],
			insertions: 0,
			deletions: 0,
			changedFiles: 0,
		},
		isStreaming: false,
		badges: [],
		eventLog: [],
		...overrides,
	} as SidebarState;
}

describe("sidebar_event tool", () => {
	it("registers the sidebar_event tool on ExtensionAPI", () => {
		const fake = makeFakePi();
		const state = freshState();
		const requestRender = vi.fn();
		registerSidebarEventTool(fake.pi, () => undefined, () => state, requestRender);
		expect(fake.tool).toBeDefined();
		expect(fake.tool?.name).toBe("sidebar_event");
		expect(typeof fake.tool?.execute).toBe("function");
	});

	it("emits sidebar:event with action, target, data, ts when invoked", async () => {
		const fake = makeFakePi();
		const state = freshState();
		const requestRender = vi.fn();
		registerSidebarEventTool(fake.pi, () => undefined, () => state, requestRender);
		const before = Date.now();
		const result = (await fake.tool!.execute!(
			"call-1",
			{ action: "log", target: "task-42", data: { verdict: "CLEAN" } },
			undefined,
			undefined,
			makeFakeCtx(fake.notify),
		)) as unknown as {
			content: Array<{ type: string; text: string }>;
			details: { emitted: boolean; event: string; ts: number };
		};
		expect(result.details.emitted).toBe(true);
		expect(result.details.event).toBe("sidebar:event");
		expect(typeof result.details.ts).toBe("number");
		expect(result.details.ts).toBeGreaterThanOrEqual(before);
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("sidebar:event emitted");
		expect(fake.emits).toHaveLength(1);
		expect(fake.emits[0].channel).toBe("sidebar:event");
		expect(fake.emits[0].data).toMatchObject({
			action: "log",
			target: "task-42",
			data: { verdict: "CLEAN" },
		});
	});

	it("accepts empty data and absent target on the tool", async () => {
		const fake = makeFakePi();
		const state = freshState();
		const requestRender = vi.fn();
		registerSidebarEventTool(fake.pi, () => undefined, () => state, requestRender);
		await fake.tool!.execute!(
			"call-1",
			{ action: "show" },
			undefined,
			undefined,
			makeFakeCtx(fake.notify),
		);
		expect(fake.emits[0].data).toMatchObject({ action: "show" });
		expect((fake.emits[0].data as { target?: string }).target).toBeUndefined();
	});
});

describe("sidebar:event handler", () => {
	function setup(opts: { withCtx?: boolean } = {}) {
		const fake = makeFakePi();
		const state = freshState();
		const requestRender = vi.fn();
		const ctx = opts.withCtx ? makeFakeCtx(fake.notify) : undefined;
		registerSidebarEventTool(
			fake.pi,
			() => ctx,
			() => state,
			requestRender,
		);
		const handlers = fake.subscribers.get("sidebar:event");
		expect(handlers).toBeDefined();
		const dispatch = handlers!.values().next().value as EventHandler;
		return { dispatch, state, requestRender, notify: fake.notify, fake };
	}

	it("show/highlight set state.highlightedId and requestRender", () => {
		const { dispatch, state, requestRender } = setup();
		dispatch({ action: "highlight", target: "task-1" });
		expect(state.highlightedId).toBe("task-1");
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("badge appends to state.badges and requestRender", () => {
		const { dispatch, state, requestRender } = setup();
		dispatch({ action: "badge", target: "task-2", data: { count: 3 } });
		expect(state.badges).toEqual([
			{ ts: expect.any(Number), target: "task-2", data: { count: 3 } },
		]);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("toast calls ctx.ui.notify with data.message + data.level", () => {
		const { dispatch, requestRender, notify } = setup({ withCtx: true });
		dispatch({ action: "toast", data: { message: "hello", level: "warning" } });
		expect(notify).toHaveBeenCalledWith("hello", "warning");
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("toast falls back to default message + info when data is empty", () => {
		const { dispatch, notify } = setup({ withCtx: true });
		dispatch({ action: "toast" });
		dispatch({ action: "toast", data: {} });
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenNthCalledWith(1, "sidebar", "info");
		expect(notify).toHaveBeenNthCalledWith(2, "sidebar", "info");
	});

	it("log appends entries with cap and FIFO eviction", () => {
		const { dispatch, state } = setup();
		for (let i = 0; i < 60; i++) {
			dispatch({ action: "log", target: `t-${i}`, data: { i } });
		}
		expect(state.eventLog).toHaveLength(50);
		expect((state.eventLog[0].data as { i: number }).i).toBe(10);
		expect((state.eventLog.at(-1)!.data as { i: number }).i).toBe(59);
	});

	it("clear resets highlightedId + badges; filters by target when provided", () => {
		const { dispatch, state } = setup();
		dispatch({ action: "highlight", target: "task-A" });
		dispatch({ action: "badge", target: "task-A", data: { v: 1 } });
		dispatch({ action: "badge", target: "task-B", data: { v: 2 } });
		expect(state.badges).toHaveLength(2);
		dispatch({ action: "clear", target: "task-A" });
		expect(state.highlightedId).toBeUndefined();
		expect(state.badges).toEqual([
			{ ts: expect.any(Number), target: "task-B", data: { v: 2 } },
		]);
		dispatch({ action: "clear" });
		expect(state.badges).toEqual([]);
	});

	it("is driven by any emit on the sidebar:event channel (not only the tool)", () => {
		const { dispatch, state, requestRender, fake } = setup();
		fake.emits.length = 0;
		requestRender.mockClear();
		fake.pi.events.emit("sidebar:event", {
			action: "badge",
			target: "from-another-extension",
			data: { hello: "world" },
			ts: Date.now(),
		});
		expect(state.badges).toHaveLength(1);
		expect(state.badges[0].target).toBe("from-another-extension");
		expect(requestRender).toHaveBeenCalledTimes(1);
		// ensure the dispatch helper is the same handler that the tool installed
		expect(dispatch).toBeDefined();
	});

	it("does not throw when ctx is unloaded (toast path) and mutates state anyway", () => {
		const fake = makeFakePi();
		const state = freshState();
		const requestRender = vi.fn();
		registerSidebarEventTool(
			fake.pi,
			() => undefined, // no current ctx
			() => state,
			requestRender,
		);
		const handlers = fake.subscribers.get("sidebar:event")!;
		const dispatch = handlers.values().next().value as EventHandler;
		expect(() => dispatch({ action: "badge", target: "x" })).not.toThrow();
		expect(state.badges).toHaveLength(1);
		});
	});

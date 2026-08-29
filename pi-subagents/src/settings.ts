// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveRunConfig } from "./run-controller.js";
import type { JoinMode, WidgetMode } from "./types.js";

export interface SubagentsSettings {
	maxConcurrent?: number;
	/**
	 * Per-agent-type background concurrency overrides. Each entry sets the cap
	 * for one agent type (developer, auditor, Explore, Plan, merger, git-expert,
	 * or any user-defined name). The effective per-type cap at spawn time is
	 * resolved by AgentManager.effectiveMaxFor():
	 *   AgentConfig.maxConcurrent -> this map -> global maxConcurrent
	 * Entries must be positive integers; sanitize() drops bad values silently.
	 */
	maxConcurrentByType?: Record<string, number>;
	/**
	 * 0 = unlimited — the extension's single source of truth for that convention:
	 * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
	 * `/agents` → Settings input prompt explicitly says "0 = unlimited".
	 */
	defaultMaxTurns?: number;
	graceTurns?: number;
	defaultJoinMode?: JoinMode;
	/**
	 * Master switch for the schedule subagent feature. Defaults to `true`.
	 * When `false`: the `Agent` tool's `schedule` param + its guideline are
	 * stripped from the tool spec at registration (zero LLM-context cost), the
	 * scheduler doesn't bind to the session, and the `/agents → Scheduled jobs`
	 * menu entry is hidden. Schema-level removal applies at extension load
	 * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
	 */
	schedulingEnabled?: boolean;
	/**
	 * When true, the effective model of each subagent spawn is validated
	 * against `enabledModels` from pi's settings — both global
	 * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
	 * with project overriding global (mirrors pi's SettingsManager deep-merge).
	 *
	 * scopeModels guards against runtime LLM choices, not user-level config.
	 * Out-of-scope handling reflects this:
	 *   - Caller-supplied via `Agent({ model: "..." })` (only when frontmatter
	 *     has no `model:`, since frontmatter is authoritative): hard error
	 *     returned to the orchestrator, listing the allowed models. The LLM
	 *     made an explicit out-of-scope choice and gets explicit feedback.
	 *   - Frontmatter-pinned: warning toast + the pinned model runs. The
	 *     agent's author/installer chose this; trust it.
	 *   - Parent-inherited (neither caller nor frontmatter sets a model):
	 *     warning toast + parent's model runs. The user chose the parent's
	 *     model when starting the session; trust it.
	 *
	 * No-op when pi's `enabledModels` is empty or absent — nothing to validate
	 * against. Defaults to false: subagents may use any model.
	 */
	scopeModels?: boolean;
	/**
	 * When true, the four built-in default agents (developer, auditor, Explore, Plan)
	 * are not registered at startup. User-defined agents from project/global custom
	 * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
	 * Defaults to false.
	 */
	disableDefaultAgents?: boolean;
	/**
	 * Which Agent tool description the LLM sees. "full" (default) is the rich
	 * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
	 * agent type list, terse usage notes) for small/local models where tool-spec
	 * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
	 * (project, falling back to `<agentDir>/agent-tool-description.md`) with
	 * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
	 * The mode is read once at tool registration — changing it applies on the
	 * next pi session.
	 */
	toolDescriptionMode?: ToolDescriptionMode;
	/**
	 * Whether the Claude Code-style FleetView (the navigable main+subagents list
	 * rendered below the editor) is shown. Defaults to `true`. Pure-UI: when off,
	 * the list never registers and the global key handler never captures input.
	 */
	fleetView?: boolean;
	/**
	 * Display mode for the persistent above-editor agent widget:
	 *   - `all`: show every agent (foreground + background).
	 *   - `background`: hide foreground agents — they already render inline as the
	 *     Agent tool result, so the widget would otherwise double-render them
	 *     (#118); everything else (background, queued, scheduled, RPC) stays.
	 *   - `off`: hide the widget entirely.
	 * Defaults to `background`. Pure-UI and applied live (toggling refreshes the
	 * widget).
	 */
	widgetMode?: WidgetMode;
	/**
	 * Project/global default for writing each subagent's `.output` transcript
	 * (a JSON-lines copy of the run, stored under the OS temp dir).
	 * Defaults to `true`. Set `false` to make transcripts opt-in for the whole
	 * project (e.g. a repo that shouldn't leave run transcripts on disk for backup
	 * or DLP tooling to ingest). A custom agent's `output_transcript` frontmatter
	 * overrides this per agent. This governs only the transcript — it does NOT
	 * affect the persisted pi session (`persist_session`), worktree commits
	 * (`isolation: worktree`), or memory files.
	 */
	outputTranscript?: boolean;
	/**
	 * Per-type model override map. Keys are the canonical agent type names
	 * (`Developer`, `Auditor`, `Explore`, `Plan`, `Merger`) or their legacy
	 * lowercase spellings; the case-insensitive resolver maps both onto the
	 * same Model. Values are `provider/model` strings (e.g. `"anthropic/claude-opus-4"`).
	 *
	 * GC-2026-092: slots into the resolution chain between the hardcoded
	 * `AgentConfig.model` pin (e.g. developer/auditor → MiniMax/MiniMax-M3)
	 * and the global `settings.json#defaultProvider/defaultModel` fallback.
	 * Project subagents.json overrides global; absence means "use the
	 * hardcoded default" — never silently substitutes a different model.
	 */
	defaultModelsByType?: Record<string, string>;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
	setMaxConcurrent: (n: number) => void;
	/**
	 * Replace the per-type cap map. Passing `undefined` clears all overrides
	 * so every type falls through to AgentConfig / global. Passing `{}` is a
	 * no-op (no overrides to apply).
	 */
	setMaxConcurrentByType: (map: Record<string, number> | undefined) => void;
	setDefaultMaxTurns: (n: number) => void;
	setGraceTurns: (n: number) => void;
	setDefaultJoinMode: (mode: JoinMode) => void;
	setSchedulingEnabled: (b: boolean) => void;
	setScopeModels: (enabled: boolean) => void;
	setDisableDefaultAgents: (b: boolean) => void;
	setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
	setFleetView: (b: boolean) => void;
	setWidgetMode: (mode: WidgetMode) => void;
	setOutputTranscript: (b: boolean) => void;
	/**
	 * GC-2026-092: replace the per-type model override map. Passing `undefined`
	 * clears all overrides so every type falls through to AgentConfig.model
	 * (the hardcoded default) and then to settings.json#defaultProvider/defaultModel.
	 * Passing `{}` is a no-op (no overrides to apply).
	 */
	setDefaultModelsByType: (map: Record<string, string> | undefined) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>([
	"async",
	"group",
	"smart",
]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> =
	new Set<ToolDescriptionMode>(["full", "compact", "custom"]);
const VALID_WIDGET_MODES: ReadonlySet<string> = new Set<WidgetMode>([
	"all",
	"background",
	"off",
]);

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: SubagentsSettings = {};
	if (
		Number.isInteger(r.maxConcurrent) &&
		(r.maxConcurrent as number) >= 1 &&
		(r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
	) {
		out.maxConcurrent = r.maxConcurrent as number;
	}
	if (r.maxConcurrentByType && typeof r.maxConcurrentByType === "object") {
		const raw = r.maxConcurrentByType as Record<string, unknown>;
		const sanitized: Record<string, number> = {};
		let kept = 0;
		for (const [type, cap] of Object.entries(raw)) {
			// Use MAX_CONCURRENT_CEILING as the per-type ceiling — a per-type cap
			// larger than the global cap is meaningless, but we don't want to
			// silently drop high values a user might be migrating in.
			if (
				typeof type === "string" &&
				type.length > 0 &&
				Number.isInteger(cap) &&
				(cap as number) >= 1 &&
				(cap as number) <= MAX_CONCURRENT_CEILING
			) {
				sanitized[type] = cap as number;
				kept++;
			}
		}
		if (kept > 0) out.maxConcurrentByType = sanitized;
	}
	if (
		Number.isInteger(r.defaultMaxTurns) &&
		(r.defaultMaxTurns as number) >= 0 &&
		(r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
	) {
		out.defaultMaxTurns = r.defaultMaxTurns as number;
	}
	if (
		Number.isInteger(r.graceTurns) &&
		(r.graceTurns as number) >= 1 &&
		(r.graceTurns as number) <= GRACE_TURNS_CEILING
	) {
		out.graceTurns = r.graceTurns as number;
	}
	if (
		typeof r.defaultJoinMode === "string" &&
		VALID_JOIN_MODES.has(r.defaultJoinMode)
	) {
		out.defaultJoinMode = r.defaultJoinMode as JoinMode;
	}
	if (typeof r.schedulingEnabled === "boolean") {
		out.schedulingEnabled = r.schedulingEnabled;
	}
	if (typeof r.scopeModels === "boolean") {
		out.scopeModels = r.scopeModels;
	}
	if (typeof r.disableDefaultAgents === "boolean") {
		out.disableDefaultAgents = r.disableDefaultAgents;
	}
	if (
		typeof r.toolDescriptionMode === "string" &&
		VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)
	) {
		out.toolDescriptionMode = r.toolDescriptionMode as ToolDescriptionMode;
	}
	if (typeof r.fleetView === "boolean") {
		out.fleetView = r.fleetView;
	}
	if (
		typeof r.widgetMode === "string" &&
		VALID_WIDGET_MODES.has(r.widgetMode)
	) {
		out.widgetMode = r.widgetMode as WidgetMode;
	}
	if (typeof r.outputTranscript === "boolean") {
		out.outputTranscript = r.outputTranscript;
	}
	if (r.defaultModelsByType && typeof r.defaultModelsByType === "object") {
		const rawMap = r.defaultModelsByType as Record<string, unknown>;
		const sanitized: Record<string, string> = {};
		let kept = 0;
		for (const [type, value] of Object.entries(rawMap)) {
			// Drop empty keys, non-string values, and empty strings silently —
			// matches the maxConcurrentByType "drop bad values silently" contract.
			// The runtime helper applies the same sanitization in readField()
			// so persisted-and-read views are consistent.
			if (
				typeof type === "string" &&
				type.length > 0 &&
				typeof value === "string" &&
				value.length > 0
			) {
				sanitized[type] = value;
				kept++;
			}
		}
		if (kept > 0) out.defaultModelsByType = sanitized;
	}
	return out;
}

function globalPath(): string {
	return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
	return join(cwd, ".pi", "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
	if (!existsSync(path)) return {};
	try {
		return sanitize(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(
			`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`,
		);
		return {};
	}
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
	return {
		...readSettingsFile(globalPath()),
		...readSettingsFile(projectPath(cwd)),
	};
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(
	s: SubagentsSettings,
	cwd: string = process.cwd(),
): boolean {
	const path = projectPath(cwd);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(
	s: SubagentsSettings,
	appliers: SettingsAppliers,
): void {
	if (typeof s.maxConcurrent === "number")
		appliers.setMaxConcurrent(s.maxConcurrent);
	if (s.maxConcurrentByType)
		appliers.setMaxConcurrentByType(s.maxConcurrentByType);
	if (typeof s.defaultMaxTurns === "number")
		appliers.setDefaultMaxTurns(s.defaultMaxTurns);
	if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
	if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
	if (typeof s.schedulingEnabled === "boolean")
		appliers.setSchedulingEnabled(s.schedulingEnabled);
	if (typeof s.scopeModels === "boolean")
		appliers.setScopeModels(s.scopeModels);
	if (typeof s.disableDefaultAgents === "boolean")
		appliers.setDisableDefaultAgents(s.disableDefaultAgents);
	if (s.toolDescriptionMode)
		appliers.setToolDescriptionMode(s.toolDescriptionMode);
	if (typeof s.fleetView === "boolean") appliers.setFleetView(s.fleetView);
	if (s.widgetMode) appliers.setWidgetMode(s.widgetMode);
	if (typeof s.outputTranscript === "boolean")
		appliers.setOutputTranscript(s.outputTranscript);
	if (s.defaultModelsByType)
		appliers.setDefaultModelsByType(s.defaultModelsByType);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
	successMsg: string,
	persisted: boolean,
): { message: string; level: "info" | "warning" } {
	return persisted
		? { message: successMsg, level: "info" }
		: {
				message: `${successMsg} (session only; failed to persist)`,
				level: "warning",
			};
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
	appliers: SettingsAppliers,
	emit: SettingsEmit,
	cwd: string = process.cwd(),
): SubagentsSettings {
	const settings = loadSettings(cwd);
	applySettings(settings, appliers);
	emit("subagents:settings_loaded", { settings });
	return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
	snapshot: SubagentsSettings,
	successMsg: string,
	emit: SettingsEmit,
	cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
	const persisted = saveSettings(snapshot, cwd);
	emit("subagents:settings_changed", { settings: snapshot, persisted });
	return persistToastFor(successMsg, persisted);
}

// =============================================================================
// GC-2026-037: Wall-clock deadline (per-agent-type + per-dispatch override).
//
// The Agent tool executor merges the caller's AbortSignal with a deadline-driven
// AbortController via AbortSignal.any. The deadline default depends on the
// agent type (developer/auditor get 20min; Explore/Plan get 5min) and the
// caller may override via the `max_duration_minutes` Agent tool param.
//
// The functions in this block are module-level state, mirroring
// `setDefaultMaxTurns` / `getDefaultMaxTurns` in agent-runner.ts. They are
// NOT persisted across sessions — that comes later if needed. The
// orchestrator-facing API is:
//   - getSubagentDurationDefault(type) — read a default
//   - setSubagentDurationDefaults(d)   — override the table (mainly tests)
//   - resolveDeadlineMs(type, overrideMinutes) — priority chain
// =============================================================================

/** Hard floor: any unknown agent type or unconfigured default = 20min. */
const DEFAULT_DURATION_FLOOR_MS = 20 * 60 * 1000;

const DEFAULT_DURATIONS_MS: Record<string, number> = {
	developer: 20 * 60 * 1000,
	auditor: 20 * 60 * 1000,
	Explore: 5 * 60 * 1000,
	Plan: 5 * 60 * 1000,
};

let durationDefaultsMs: Record<string, number> = { ...DEFAULT_DURATIONS_MS };

export function getSubagentDurationDefault(type: string): number {
	return durationDefaultsMs[type] ?? DEFAULT_DURATION_FLOOR_MS;
}

export function setSubagentDurationDefaults(d: Record<string, number>): void {
	// Merge — preserve unspecified defaults so callers can override one
	// type without resetting the rest. The module-level `durationDefaultsMs`
	// is the source of truth between calls.
	durationDefaultsMs = { ...durationDefaultsMs, ...d };
}

/**
 * Resolve the wall-clock deadline for a subagent dispatch.
 *
 * Priority chain (GC-2026-043, delegates to `resolveRunConfig`):
 *   1. caller-supplied `overrideMinutes` (in minutes, fractional allowed;
 *      converted to ms here) — wins for ALL types including unknown.
 *   2. per-type default via `resolveRunConfig` for canonical types
 *      (developer / auditor / explorer / merger). `resolveRunConfig`
 *      reads `DEFAULT_PER_TYPE` and honors per-type / generic env vars.
 *   3. Legacy `Explore` / `Plan` capitalized names are NOT in
 *      `DEFAULT_PER_TYPE` — fall back to `getSubagentDurationDefault`
 *      (the GC-2026-037 table that knows their 5-minute defaults).
 *   4. Unknown types fall back to the developer default (20min) via
 *      `resolveRunConfig`'s fallback semantics.
 *
 * Signature kept stable for backward compat with existing callers
 * (index.ts executor). The body is intentionally short — the actual
 * resolution logic lives in `resolveRunConfig` / `getSubagentDurationDefault`.
 */
export function resolveDeadlineMs(
	type: string,
	overrideMinutes: number | undefined,
): number {
	if (overrideMinutes != null && overrideMinutes > 0) {
		return Math.round(overrideMinutes * 60 * 1000);
	}
	// Legacy capitalized names: not in DEFAULT_PER_TYPE, would resolve
	// to developer defaults (20min) under resolveRunConfig — too long
	// for these short-lived agents. Use the GC-2026-037 per-type table.
	if (type === "Explore" || type === "Plan") {
		return getSubagentDurationDefault(type);
	}
	// Canonical types delegate to resolveRunConfig — single source of truth.
	return resolveRunConfig(type, {}, process.env).deadlineMs;
}

// =============================================================================
// GC-2026-037 T3: Network gating (per-agent-type + per-dispatch override)
//
// `networkAllowed` controls whether subagent dispatches can issue network
// commands (git fetch / pull / clone, curl, wget, npm install, etc.). The
// default is `false` (offline-first) for all built-in agent types. The
// `git-expert` agent and the `merger` agent are NOT gated here — they have
// their own permission surfaces in default-agents.ts and are explicitly
// allowed network access at registration time.
//
// The agent tool executor reads these via `getNetworkAllowedDefault(type)`
// and applies them in `pi.exec()` gate logic. The orchestrator can
// override per-dispatch via `params.network_allowed` (future Agent tool
// parameter).
// =============================================================================

const DEFAULT_NETWORK_ALLOWED_BY_TYPE: Record<string, boolean> = {
	developer: false,
	auditor: false,
	Explore: false,
	Plan: false,
};

let networkAllowedByType: Record<string, boolean> = {
	...DEFAULT_NETWORK_ALLOWED_BY_TYPE,
};

export function getNetworkAllowedDefault(type: string): boolean {
	return networkAllowedByType[type] ?? false;
}

export function setNetworkAllowedDefault(type: string, allowed: boolean): void {
	networkAllowedByType = { ...networkAllowedByType, [type]: allowed };
}

export function setNetworkAllowedDefaults(d: Record<string, boolean>): void {
	networkAllowedByType = { ...networkAllowedByType, ...d };
}

// =============================================================================
// GC-2026-092: Per-type model override map (`subagents.json#defaultModelsByType`).
//
// Mirrors the `maxConcurrentByType` pattern: a project-overrides-global
// record keyed by agent type. Slot in the agent-runner.ts resolution chain:
//   1. Caller-supplied `Agent({ model: "..." })` (line 907 of task-dispatcher
//      at the time of this writing — agent-runner.ts's caller path)
//   2. **THIS** per-type override (highest config-layer priority)
//   3. `AgentConfig.model` hardcoded default (default-agents.ts)
//   4. `settings.json#defaultProvider/defaultModel` global fallback
//   5. Parent session model (inherited)
//
// Module-level state mirrors `networkAllowedByType`. Persistence lives in
// subagents.json (per the SubagentsSettings field), and the runtime read
// helper is `getSettingsDefaultModelsByType()` in
// settings-default-models-by-type.ts (with the mtime+size stat-cache).
// =============================================================================

let defaultModelsByType: Record<string, string> | undefined;

export function getDefaultModelByType(type: string): string | undefined {
	if (!defaultModelsByType) return undefined;
	// Case-insensitive lookup — the registry's resolveKey is case-insensitive
	// and persisted DAG YAMLs may carry the legacy lowercase spelling.
	const lower = type.toLowerCase();
	for (const [k, v] of Object.entries(defaultModelsByType)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

export function setDefaultModelsByType(
	map: Record<string, string> | undefined,
): void {
	// Pass undefined through as "no override" — every type falls through to
	// AgentConfig.model. Passing `{}` is treated identically: empty map,
	// no overrides.
	defaultModelsByType =
		map && Object.keys(map).length > 0 ? { ...map } : undefined;
}

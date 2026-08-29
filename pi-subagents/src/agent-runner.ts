/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getConfig,
	getMemoryToolNames,
	getReadOnlyMemoryToolNames,
	getToolNamesForType,
} from "./agent-types.js";
import {
	BudgetExceededError,
	BudgetTracker,
	loadBudgetFromEnv,
} from "./budget.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { diagnosticForRunResult, notifyOrchestrator, retryBudgetLeftFor, writeDiagnostic } from "./diagnostic.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { inc as profileInc, observe as profileObserve } from "./profile.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { ResourceMonitor, type ResourceSnapshot } from "./resource-monitor.js";
import type { RunController } from "./run-controller.js";
import { getDefaultModelByType, getNetworkAllowedDefault } from "./settings.js";
import { preloadSkills } from "./skill-loader.js";
import type { SubagentType, ThinkingLevel } from "./types.js";
import { toolDisplayName } from "./ui/agent-widget.js";

// =============================================================================
// GC-2026-064 T3 / GC-2026-066 T1 (PoC): pre-tool resource-monitor hook
// + LLM-visible delivery.
//
// `runAgent`'s tool-execution loop calls `ResourceMonitor.sample()` before
// each tool executes. If `shouldAdvis(snap)` returns true, the formatted
// advisory is captured into a per-run `pendingAdvisoryText` slot (see
// `captureToolStartAdvisory`), then delivered to the LLM via
// `session.steer(pendingText)` at `tool_execution_end` (see
// `deliverPendingAdvisory`). Per `@earendil-works/pi-coding-agent` docs,
// `session.steer` "queues a steering message while the agent is running;
// delivered after the current assistant turn finishes executing its tool
// calls, before the next LLM call" — exactly the seam between
// `tool_execution_end` and the next model call that the PoC needs.
//
// Chosen delivery path: **Path A** (`session.steer` — least invasive).
// `session.addMessage(...)` from the original GC-2026-066 SC1 sketch does
// not exist in `@earendil-works/pi-coding-agent@0.81.1`; `session.steer`
// is the closest real API and matches the same conceptual contract.
// Path B (`pi.appendEntry("system", ...)`) only persists session entries;
// entries do not reach the LLM. Path C (callback wrap) is heavier and
// adds an extra hook layer for no behavioral gain over steer.
//
// Threshold-gated allocation: when `shouldAdvis` returns false the capture
// helper returns `undefined` without calling `formatAdvisory`, and the
// delivery helper short-circuits without invoking `session.steer`. No
// string concat, no message construction on the calm path.
//
// Test seams:
//   - `_setResourceMonitorForTests` swaps the monitor for a deterministic
//     mock (production code never calls the setter).
//   - `captureToolStartAdvisory` and `deliverPendingAdvisory` are exported
//     as pure helpers so tests can pin capture / delivery polarity without
//     instantiating a real `AgentSession`. The subscribe callback in
//     `runAgent` calls them in order; nothing else.
let __resourceMonitorForTests: ResourceMonitor | undefined;

/**
 * Inject a ResourceMonitor for testing. Pass `undefined` to restore live
 * sampling. Production code paths never invoke this; the only caller is
 * the matching test file (verified by `git grep`).
 */
export function _setResourceMonitorForTests(
	m: ResourceMonitor | undefined,
): void {
	__resourceMonitorForTests = m;
}

/**
 * If `monitor.shouldAdvis(snap)` returns true, return
 * `monitor.formatAdvisory(snap) + "\n" + resultStr`. Otherwise return
 * `resultStr` unchanged — no string concatenation, no allocation in the
 * calm path. Extracted so the polarity contract is testable in isolation
 * (see `resource-injection-e2e.test.ts`, SC6).
 *
 * NOTE: GC-2026-066 T1 superseded the envelope-prepend intent of this
 * helper with `session.steer(...)` (Path A — least invasive). The helper
 * remains exported because `resource-injection-e2e.test.ts` still pins its
 * polarity contract; a future consumer that does get hold of the raw
 * tool-result envelope can still use it without code changes here.
 */
export function augmentToolResultWithAdvisory(
	resultStr: string,
	monitor: ResourceMonitor,
	snap: ResourceSnapshot,
): string {
	if (monitor.shouldAdvis(snap)) {
		return monitor.formatAdvisory(snap) + "\n" + resultStr;
	}
	return resultStr;
}

/**
 * Capture the resource advisory for the next tool execution. Returns the
 * formatted advisory string when `shouldAdvis(snap)` is true, or
 * `undefined` when pressure is low (no `formatAdvisory` call → no string
 * allocation on the calm path).
 *
 * Called from `runAgent`'s `tool_execution_start` handler. The returned
 * value is stored in the per-run `pendingAdvisoryText` slot and consumed
 * by `deliverPendingAdvisory` at `tool_execution_end`.
 */
export function captureToolStartAdvisory(
	monitor: ResourceMonitor,
): string | undefined {
	const snap = monitor.sample();
	return monitor.shouldAdvis(snap) ? monitor.formatAdvisory(snap) : undefined;
}

/**
 * Deliver a captured resource advisory to the LLM via `session.steer(...)`
 * (Path A — see comment block at top of file). Fire-and-forget: the
 * promise is intentionally not awaited from `runAgent`'s subscribe
 * callback because steer queues the message synchronously and we do not
 * want to block the tool-execution loop on queue acceptance.
 *
 * When `pendingText` is `undefined` (calm path) this is a no-op — no
 * `session.steer` call, no allocation. The polarity contract is pinned by
 * `resource-delivery-e2e.test.ts` (cases (c)/(d) and the (e)/(f)
 * round-trips).
 */
export function deliverPendingAdvisory(
	session: { steer: (text: string) => Promise<void> | void },
	pendingText: string | undefined,
): void {
	if (pendingText !== undefined) {
		void session.steer(pendingText);
	}
}

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
	AGENT: "Agent",
	GET_RESULT: "get_subagent_result",
	STEER: "steer_subagent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
	const base = basename(extPath);
	const name =
		base === "index.ts" || base === "index.js"
			? basename(dirname(extPath))
			: base.replace(/\.(ts|js)$/, "");
	return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `@tintinweb/pi-subagents`, so a looser rule would misattribute every
 * co-located file to `pi-subagents`.
 */
function extensionPackageName(extPath: string): string | undefined {
	const entry = resolve(extPath);
	let dir = dirname(extPath);
	for (;;) {
		// Climbing into node_modules means we've left the owning package's tree.
		if (basename(dir) === "node_modules") return undefined;
		let pkg: { name?: unknown; pi?: { extensions?: unknown } };
		try {
			pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
		} catch {
			const parent = dirname(dir);
			if (parent === dir) return undefined; // walked to the filesystem root
			dir = parent;
			continue;
		}
		// First package.json wins — it's the package root; decide here.
		const entries = pkg.pi?.extensions;
		if (
			typeof pkg.name === "string" &&
			Array.isArray(entries) &&
			entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
		) {
			const short = pkg.name.startsWith("@")
				? pkg.name.slice(pkg.name.indexOf("/") + 1)
				: pkg.name;
			return short.toLowerCase();
		}
		return undefined;
	}
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
	const canonical = extensionCanonicalName(extPath);
	const pkg = extensionPackageName(extPath);
	return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
	entries: string[],
	cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
	const names = new Set<string>();
	const paths: string[] = [];
	let wildcard = false;
	for (const entry of entries) {
		if (!entry) continue;
		if (entry === "*") {
			wildcard = true;
			continue;
		}
		const isPathEntry =
			entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
		if (!isPathEntry) {
			names.add(entry.toLowerCase());
			continue;
		}
		let p = entry;
		if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
			p = homedir() + p.slice(1);
		}
		const abs = isAbsolute(p) ? p : resolve(cwd, p);
		paths.push(abs);
		names.add(extensionCanonicalName(abs));
	}
	return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
	extNames: Set<string>;
	narrowing: Map<string, Set<string>>;
} {
	const extNames = new Set<string>();
	const narrowing = new Map<string, Set<string>>();
	for (const raw of entries) {
		if (!raw) continue;
		const body = raw.slice("ext:".length);
		const slash = body.indexOf("/");
		// Extension name matches case-insensitively (matches the loader-side canonical
		// name). Tool names are case-preserved — they're matched against pi-mono's
		// registered identifiers, which are case-sensitive.
		const name = (slash === -1 ? body : body.slice(0, slash))
			.trim()
			.toLowerCase();
		if (!name) continue;
		extNames.add(name);
		if (slash === -1) continue;
		const tool = body.slice(slash + 1).trim();
		if (!tool) continue;
		let set = narrowing.get(name);
		if (!set) {
			set = new Set();
			narrowing.set(name, set);
		}
		set.add(tool);
	}
	return { extNames, narrowing };
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
	if (n == null || n === 0) return undefined;
	return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined {
	return defaultMaxTurns;
}
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void {
	defaultMaxTurns = normalizeMaxTurns(n);
}

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number {
	return graceTurns;
}
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void {
	graceTurns = Math.max(1, n);
}

/**
 * Try to find the right model for an agent type.
 *
 * Priority (GC-2026-092 inserted a new layer):
 *   1. per-type override from `subagents.json#defaultModelsByType`
 *      (via `getDefaultModelByType(type)` — case-insensitive lookup)
 *   2. explicit `config.model` (from AgentConfig.model hardcoded default)
 *   3. parent session's model
 *
 * The caller-supplied `Agent({ model: "..." })` path lives one level up
 * (at the call site, line 909 area) and remains the highest priority —
 * this function is only consulted when the caller did NOT pass a model.
 */
function resolveDefaultModel(
	parentModel: Model<any> | undefined,
	registry: {
		find(provider: string, modelId: string): Model<any> | undefined;
		getAvailable?(): Model<any>[];
	},
	type: string,
	configModel?: string,
): Model<any> | undefined {
	// Helper: parse a "provider/model" string + check the registry. Returns
	// the Model if found, undefined otherwise. Logs a warning and returns
	// undefined if the registry doesn't have the model (don't crash — the
	// user may have a stale or typo'd override).
	const tryProviderModel = (value: string): Model<any> | undefined => {
		const slashIdx = value.indexOf("/");
		if (slashIdx === -1) return undefined;
		const provider = value.slice(0, slashIdx);
		const modelId = value.slice(slashIdx + 1);

		// Build a set of available model keys for fast lookup
		const available = registry.getAvailable?.();
		const availableKeys = available
			? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
			: undefined;
		const isAvailable = (p: string, id: string) =>
			!availableKeys || availableKeys.has(`${p}/${id}`);

		const found = registry.find(provider, modelId);
		if (found && isAvailable(provider, modelId)) return found;
		return undefined;
	};

	// GC-2026-092: per-type override from subagents.json#defaultModelsByType.
	// Case-insensitive lookup (handles PascalCase canonical + legacy lowercase).
	const perTypeOverride = getDefaultModelByType(type);
	if (perTypeOverride) {
		const fromOverride = tryProviderModel(perTypeOverride);
		if (fromOverride) return fromOverride;
		// Registry didn't have the override's model — log a warning and fall
		// through to configModel. The dispatcher shouldn't silently pick a
		// different model when the user explicitly configured one.
		console.warn(
			`[pi-subagents] defaultModelsByType override for "${type}" = "${perTypeOverride}" not found in registry; falling through to configModel.`,
		);
	}

	if (configModel) {
		const fromConfig = tryProviderModel(configModel);
		if (fromConfig) return fromConfig;
	}

	return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
	type: "start" | "end";
	toolName: string;
}

export interface RunOptions {
	/** ExtensionAPI instance — used for pi.exec() instead of execSync. */
	pi: ExtensionAPI;
	/** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
	agentId?: string;
	model?: Model<any>;
	maxTurns?: number;
	signal?: AbortSignal;
	/**
	 * GC-2026-043: when the caller passes a `RunController`, the runner
	 * uses `runController.signal` (the composed signal — parent abort OR
	 * own deadline OR per-tool bucket timer) for session abort forwarding
	 * and exposes it via the `signal` field below for any downstream
	 * listener. Optional for backward compat — callers without a
	 * runController still pass `signal` directly.
	 */
	runController?: RunController;
	isolated?: boolean;
	inheritContext?: boolean;
	thinkingLevel?: ThinkingLevel;
	/**
	 * GC-2026-037 T3: when false, runAgent wraps `pi.exec()` to reject
	 * network-bearing commands (git fetch, git pull, git clone, git
	 * ls-remote, curl, wget, npm install, bun install, etc.) with a
	 * `NetworkNotAllowedError`. Default behavior (when undefined) is
	 * read from per-type settings via `getNetworkAllowedDefault(type)`.
	 */
	network_allowed?: boolean;
	/** Override working directory (e.g. for worktree isolation). */
	cwd?: string;
	/**
	 * Where .pi config is discovered (project extensions, skills, pi settings,
	 * agent memory). Default: same as the working directory. The manager sets
	 * this to the parent session's cwd when `SpawnOptions.cwd` points the
	 * working directory elsewhere — the agent works *there* but carries the
	 * parent project's config (the target's `.pi` extensions never execute).
	 *
	 * WARNING for future callers: if you pass `cwd` pointing at a directory the
	 * user didn't open, you almost certainly must pass `configCwd` too —
	 * omitting it makes the target's `.pi` extensions execute in this process.
	 * (Worktree isolation is the one intentional exception: its copy IS the
	 * parent's repo, so config resolving inside it is correct.)
	 */
	configCwd?: string;
	/** Called on tool start/end with activity info. */
	onToolActivity?: (activity: ToolActivity) => void;
	/** Called on streaming text deltas from the assistant response. */
	onTextDelta?: (delta: string, fullText: string) => void;
	onSessionCreated?: (session: AgentSession) => void;
	/** Called at the end of each agentic turn with the cumulative count. */
	onTurnEnd?: (turnCount: number) => void;
	/**
	 * Called once per assistant message_end with that message's usage delta.
	 * Lets callers maintain a lifetime accumulator that survives compaction
	 * (which replaces session.state.messages and resets stats-derived sums).
	 */
	onAssistantUsage?: (usage: {
		input: number;
		output: number;
		cacheWrite: number;
	}) => void;
	/**
	 * Called when the session successfully compacts. `tokensBefore` is upstream's
	 * pre-compaction context size estimate. Aborted compactions don't fire.
	 */
	onCompaction?: (info: {
		reason: "manual" | "threshold" | "overflow";
		tokensBefore: number;
	}) => void;
}

export interface RunResult {
	responseText: string;
	session: AgentSession;
	/** True if the agent was hard-aborted (max_turns + grace exceeded). */
	aborted: boolean;
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered: boolean;
	/**
	 * A failure message for the run's FINAL assistant turn, when that turn failed:
	 * a provider error (stopReason "error"), or a "length" stop that produced no
	 * text (a silent max-token death). pi resolves an exhausted-retries failure
	 * normally instead of rejecting, so without this the manager would report such
	 * a run as completed — with an empty result, or worse, an earlier turn's text
	 * presented as the answer (#144). Undefined for a clean stop, or a "length"
	 * stop that produced text (a legitimate truncated answer).
	 */
	failure?: string;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
	let text = "";
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		// message_start also fires for user and toolResult messages — resetting on
		// those would wipe assistant text already collected. Reset only when a new
		// ASSISTANT message begins, so getText() is the last assistant message's text.
		if (event.type === "message_start" && event.message.role === "assistant") {
			text = "";
		}
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
		}
	});
	return { getText: () => text, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: AgentSession, startIndex = 0): string {
	for (let i = session.messages.length - 1; i >= startIndex; i--) {
		const msg = session.messages[i];
		if (msg.role !== "assistant") continue;
		const text = extractText(msg.content).trim();
		if (text) return text;
	}
	return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
function finalTurnError(
	session: AgentSession,
	startIndex = 0,
): string | undefined {
	for (let i = session.messages.length - 1; i >= startIndex; i--) {
		const msg = session.messages[i];
		if (msg.role !== "assistant") continue;
		if (msg.stopReason === "error") {
			return (
				(msg as { errorMessage?: string }).errorMessage?.trim() ||
				"provider error with no output"
			);
		}
		if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
			return "run hit the output token limit before producing any text";
		}
		return undefined;
	}
	return undefined;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(
	session: AgentSession,
	signal?: AbortSignal,
): () => void {
	if (!signal) return () => {};
	const onAbort = () => session.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

function resolveConfiguredSessionDir(
	sessionDir: string | undefined,
	cwd: string,
): string | undefined {
	if (!sessionDir) return undefined;
	if (sessionDir === "~" || sessionDir.startsWith("~/"))
		return resolve(homedir(), sessionDir.slice(2));
	if (isAbsolute(sessionDir)) return sessionDir;
	return resolve(cwd, sessionDir);
}

export async function runAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	const config = getConfig(type);
	const agentConfig = getAgentConfig(type);

	// GC-2026-043: when the caller passes a `runController`, prefer its
	// composed signal (parent abort + own deadline + bucket timer) over
	// any bare `signal`. The composed signal is what propagates "this
	// run's time is up" to the session. Downstream forwardAbortSignal
	// uses this local `effectiveSignal` (not `options.signal` directly)
	// so the wiring is explicit.
	const effectiveSignal =
		options.runController !== undefined
			? options.runController.signal
			: options.signal;

	// Resolve working directory: worktree override > parent cwd
	const effectiveCwd = options.cwd ?? ctx.cwd;
	// Filesystem work happens in effectiveCwd; config discovery in configCwd.
	// They differ only for SpawnOptions.cwd spawns (config stays with the parent).
	const configCwd = options.configCwd ?? effectiveCwd;

	// GC-2026-037 T3: gate pi.exec() against network commands. Per-type
	// default is read from settings; the caller can override via
	// `options.network_allowed`. The wrapped pi is then passed downstream
	// to createAgentSession (which captures it for the LLM loop) and to
	// detectEnv (which also calls pi.exec for the environment probe).
	const networkAllowed =
		options.network_allowed ?? getNetworkAllowedDefault(type);
	const pi = wrapPiForNetworkGate(options.pi, networkAllowed);

	const env = await detectEnv(pi, effectiveCwd);

	// Get parent system prompt only for append-mode agents.
	// Replace-mode agents get a completely fresh prompt and must not inherit
	// the parent identity (even though buildAgentPrompt already ignores the value
	// in replace mode, reading it here would be unnecessary context leakage).
	const parentSystemPrompt =
		agentConfig?.promptMode === "append" ? ctx.getSystemPrompt() : undefined;

	// Build prompt extras (memory, skill preloading)
	const extras: PromptExtras = {};

	// Resolve extensions/skills: isolated overrides to false
	const extensions = options.isolated ? false : config.extensions;
	// Nulling excludes under isolated also suppresses the orphaned-exclude warning —
	// isolation is an intentional override, not a misconfiguration.
	const excludeExtensions = options.isolated
		? undefined
		: config.excludeExtensions;
	const skills = options.isolated ? false : config.skills;

	// Skill preloading: when skills is string[], preload their content into prompt
	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, configCwd);
		if (loaded.length > 0) {
			extras.skillBlocks = loaded;
		}
	}

	let toolNames = getToolNamesForType(type);

	// Persistent memory: detect write capability and branch accordingly.
	// Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
	if (agentConfig?.memory) {
		const existingNames = new Set(toolNames);
		const denied = agentConfig.disallowedTools
			? new Set(agentConfig.disallowedTools)
			: undefined;
		const effectivelyHas = (name: string) =>
			existingNames.has(name) && !denied?.has(name);
		const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

		if (hasWriteTools) {
			// Read-write memory: add any missing memory tool names (read/write/edit)
			const extraNames = getMemoryToolNames(existingNames);
			if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
			extras.memoryBlock = buildMemoryBlock(
				agentConfig.name,
				agentConfig.memory,
				configCwd,
			);
		} else {
			// Read-only memory: only add read tool name, use read-only prompt
			const extraNames = getReadOnlyMemoryToolNames(existingNames);
			if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
			extras.memoryBlock = buildReadOnlyMemoryBlock(
				agentConfig.name,
				agentConfig.memory,
				configCwd,
			);
		}
	}

	// Build system prompt from agent config
	let systemPrompt: string;
	if (agentConfig) {
		// agentConfig.promptMode is always "replace" for all built-in types;
		// parentSystemPrompt is already undefined above, but pass it explicitly
		// so the intent is unmistakable to future readers.
		systemPrompt = buildAgentPrompt(
			agentConfig,
			effectiveCwd,
			env,
			parentSystemPrompt,
			extras,
		);
	} else {
		// `agentConfig` is undefined when `getAgentConfig(type)` returned no
		// match. In practice `index.ts` resolves unknown types BEFORE calling
		// `runAgent` (via `resolveType` + `getConfig` — both throw). The
		// remaining defensive throw here is a belt-and-suspenders signal
		// that the resolver was bypassed. The `general-purpose` fallback was
		// removed with the agent itself (DAG-2026-011 Phase C), and the
		// `software-developer` / `software-auditor` legacy aliases were
		// removed in GC-2026-014 — there is no implicit "any unknown name →
		// general-purpose" or alias mapping any more.
		throw new Error(
			`runAgent called with unknown agent type "${type}" (no config). ` +
				`The caller must resolve the type via resolveType() / getConfig() before reaching here.`,
		);
	}

	// When skills is string[], we've already preloaded them into the prompt.
	// Still pass noSkills: true since we don't need the skill loader to load them again.
	const noSkills = skills === false || Array.isArray(skills);

	const agentDir = getAgentDir();

	// Extension loading:
	// - true  → all default-discovered extensions
	// - false → none (noExtensions)
	// - string[] → loader-level allowlist. Bare names keep the matching
	//   default-discovered extension; path entries load that extension fresh;
	//   "*" keeps all default-discovered extensions. Excluded extensions never
	//   bind handlers or register tools (their factory still runs once).
	//
	// Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
	// buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
	// would defeat prompt_mode: replace and isolated: true. Parent context, if
	// wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
	// is embedded in systemPromptOverride) or inherit_context (conversation).
	// `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
	// the LLM. They do NOT control loading — `extensions:` is the sole authority for
	// which extensions load. `ext:foo` against an extension that `extensions:` excluded
	// is an orphan and warns after reload. `isolated` means no extension tools at all.
	const { extNames, narrowing } = parseExtSelectors(
		options.isolated ? [] : (agentConfig?.extSelectors ?? []),
	);
	const noExtensions = extensions === false;

	const extensionsSpec = Array.isArray(extensions)
		? parseExtensionsSpec(extensions, configCwd)
		: undefined;
	const keepNames = extensionsSpec?.names ?? new Set<string>();
	// `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
	// Plain canonical names only (case-insensitive). Note: excluded extensions'
	// factories still run once during reload() (see comment above) — exclusion
	// suppresses handler binding and tool registration; it is not a sandbox.
	const excludeNames = new Set(
		(excludeExtensions ?? []).map((n) => n.toLowerCase()),
	);
	const hasExcludes = excludeNames.size > 0;
	// The override filters loaded extensions down to `keepNames` minus `excludeNames`.
	// It's only needed when we're neither loading everything without excludes
	// (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
	const loadAll = extensions === true || extensionsSpec?.wildcard === true;
	const additionalExtensionPaths = extensionsSpec?.paths.length
		? extensionsSpec.paths
		: undefined;
	// Pre-filter discovered set, captured by the override — the exclude-typo warning
	// must compare against this, not the surviving set (absence from survivors is
	// an exclude *succeeding*).
	let discoveredNames: Set<string> | undefined;
	const extensionsOverride:
		| ((base: LoadExtensionsResult) => LoadExtensionsResult)
		| undefined =
		noExtensions || (loadAll && !hasExcludes)
			? undefined
			: (base) => {
					discoveredNames = new Set(
						base.extensions.flatMap((e) => extensionCanonicalNames(e.path)),
					);
					return {
						...base,
						extensions: base.extensions.filter((e) => {
							const canons = extensionCanonicalNames(e.path);
							if (canons.some((n) => excludeNames.has(n))) return false; // exclude wins
							return loadAll || canons.some((n) => keepNames.has(n));
						}),
					};
				};

	const loader = new DefaultResourceLoader({
		cwd: configCwd,
		agentDir,
		noExtensions,
		additionalExtensionPaths,
		extensionsOverride,
		noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	// GC-2026-020 instrumentation: every `runAgent` call does a full
	// resource reload (the loader is per-agent, not cached). This is
	// per-design: agents must not share mutable state. We capture the
	// reload wall time + extension count so SC5 can spot a fan-out
	// regression (every Explore spawn re-loading every extension).
	const reloadStart = Date.now();
	await loader.reload();
	profileObserve("explore_spawn_ms", Date.now() - reloadStart);
	if (type === "Explore") {
		// GC-2026-020: Explore is the multiplicative CPU culprit because
		// it inherits all default extensions (extensions: true) and is
		// spawned most often. Counting + p50'd separately keeps the
		// instrumentation distinguishable from developer/auditor reloads.
		profileInc("explore_spawn_count");
		// Best-effort count of extensions loaded. DefaultResourceLoader
		// doesn't expose a public getter, but the discovered set
		// captured by the override (`discoveredNames`) gives us the
		// post-filter truth. When loadAll && !hasExcludes we skip the
		// override entirely — fall back to "unknown" sentinel (0) and
		// rely on the spawn ms + per-process extension discovery cost.
		const loadedNames =
			discoveredNames ??
			(loadAll && !hasExcludes ? undefined : new Set<string>());
		if (loadedNames) {
			profileInc("default_agent_extensions_loaded", loadedNames.size);
		}
	}

	// Plain entries in `tools:` are expected to be built-in names (extension tools
	// go through `ext:`), so an unknown name there is unambiguously a typo. Previously
	// this produced a silently broken agent (#75) — pi-mono accepted the bogus name
	// into the allowlist, then dropped it at registration with no signal back.
	if (agentConfig?.builtinToolNames?.length) {
		const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
		for (const name of agentConfig.builtinToolNames) {
			if (!knownBuiltins.has(name)) {
				options.onToolActivity?.({
					type: "end",
					toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
				});
			}
		}
	}

	// A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
	// than aborts. Two distinct misconfigurations to catch:
	//   - `extensions: [foo]` but no extension named foo was discovered (typo or
	//     path that failed to load — path entries fold their canonical name into
	//     `keepNames`, so this covers them too).
	//   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
	//     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
	//     loading is `extensions:`-authoritative.
	// An exclude_extensions: alongside extensions: false is contradictory — nothing
	// loads, so there is nothing to exclude.
	if (hasExcludes && noExtensions) {
		options.onToolActivity?.({
			type: "end",
			toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
		});
	}
	// Exclude typo check: compares against the PRE-filter discovered set (an excluded
	// name absent from the surviving set is the exclude working as intended). Also
	// flags path-like and "*" entries — excludes are plain names only.
	if (hasExcludes && discoveredNames) {
		for (const name of excludeNames) {
			if (!discoveredNames.has(name)) {
				options.onToolActivity?.({
					type: "end",
					toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
				});
			}
		}
	}
	if (keepNames.size > 0 || extNames.size > 0) {
		const survivingNames = new Set(
			loader
				.getExtensions()
				.extensions.flatMap((e) => extensionCanonicalNames(e.path)),
		);
		for (const name of keepNames) {
			if (!survivingNames.has(name)) {
				options.onToolActivity?.({
					type: "end",
					toolName: excludeNames.has(name)
						? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
						: `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
				});
			}
		}
		for (const name of extNames) {
			if (!survivingNames.has(name)) {
				options.onToolActivity?.({
					type: "end",
					toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
				});
			}
		}
	}

	// Resolve model: explicit option > per-type override (subagents.json) > config.model > parent model
	const model =
		options.model ??
		resolveDefaultModel(ctx.model, ctx.modelRegistry, type, agentConfig?.model);

	// Resolve thinking level: explicit option > agent config > undefined (inherit)
	const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

	const disallowedSet = agentConfig?.disallowedTools
		? new Set(agentConfig.disallowedTools)
		: undefined;

	// Enumerate extension-registered tool names from the loaded resource loader.
	// Extensions populate `extension.tools` during `loader.reload()` and the set
	// is stable afterwards — `bindExtensions` does not register new tools.
	//
	// Opt-in flip: when any `ext:` selector is present, extension tools become an
	// explicit allowlist — a loaded extension not named by a selector contributes
	// no tools (its handlers still ran), and `ext:foo/bar` narrows `foo` to `bar`.
	const extensionToolNames: string[] = [];
	if (!noExtensions) {
		const optInActive = extNames.size > 0;
		for (const extension of loader.getExtensions().extensions) {
			const canons = extensionCanonicalNames(extension.path);
			if (optInActive && !canons.some((c) => extNames.has(c))) continue;
			// First alias that carries a narrowing set — a user won't narrow one
			// extension under two different names, so first-match is correct.
			const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
			for (const toolName of extension.tools.keys()) {
				if (narrowed && !narrowed.has(toolName)) continue;
				extensionToolNames.push(toolName);
			}
		}
	}

	// Build the master tool allowlist applied at session construction.
	// pi-mono's `allowedToolNames` gates BOTH registration and the initial active
	// set, so listing the exact final set here means the session is correctly
	// scoped from the first instant — no post-construction narrowing required.
	const builtinToolNameSet = new Set(toolNames);
	const allowedTools = [...toolNames, ...extensionToolNames].filter((t) => {
		if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
		if (disallowedSet?.has(t)) return false;
		if (builtinToolNameSet.has(t)) return true;
		// Reached only for extension tools. The extension set was already filtered
		// at the loader (extensionsOverride / noExtensions) and at enumeration
		// (`ext:` opt-in flip), so any extension tool in `extensionToolNames` is allowed.
		return !noExtensions;
	});

	const settingsManager = SettingsManager.create(configCwd, agentDir);
	const configuredSessionDir = resolveConfiguredSessionDir(
		agentConfig?.sessionDir,
		effectiveCwd,
	);
	const defaultSessionDir =
		process.env.PI_CODING_AGENT_SESSION_DIR ??
		settingsManager.getSessionDir?.();
	const sessionManager = agentConfig?.persistSession
		? SessionManager.create(
				effectiveCwd,
				configuredSessionDir ?? defaultSessionDir,
			)
		: SessionManager.inMemory(effectiveCwd);

	// Pi 0.80.8 replaced createAgentSession's modelRegistry option with
	// modelRuntime, but ExtensionContext still exposes only the registry facade.
	// Pass both so the full supported Pi range retains the parent's providers.
	// The conditional-spread idiom (`...(x !== undefined && { ... })`) widens
	// `modelRuntime` to `{} | null | undefined` in TypeScript's inferred literal
	// type; cast directly to the receiving field type instead — `unknown`
	// satisfies the `modelRuntime?: unknown` intersection member but is not
	// itself assignable to `ModelRuntime | undefined`, so the literal must
	// declare the narrowed type. `undefined` is equivalent to omitting the key.
	const parentModelRuntime = (
		ctx.modelRegistry as unknown as { runtime?: unknown }
	).runtime;
	const sessionOpts: Parameters<typeof createAgentSession>[0] & {
		modelRegistry: ExtensionContext["modelRegistry"];
		modelRuntime?: unknown;
		signal?: AbortSignal;
	} = {
		cwd: effectiveCwd,
		agentDir,
		sessionManager,
		settingsManager,
		modelRegistry: ctx.modelRegistry,
		modelRuntime: parentModelRuntime as NonNullable<
			Parameters<typeof createAgentSession>[0]
		>["modelRuntime"],
		model,
		tools: allowedTools,
		resourceLoader: loader,
	};
	// GC-2026-065: thread the composed abort signal (parent abort + own
	// deadline) into the agent session so the LLM loop can honour it. The
	// session may or may not inspect this — it's a forward-compat hook. The
	// real enforcement is the entry/exit abort checks below the prompt
	// block (effectiveSignal is always consulted by runAgent itself).
	if (effectiveSignal !== undefined) {
		sessionOpts.signal = effectiveSignal;
	}
	if (thinkingLevel) {
		sessionOpts.thinkingLevel = thinkingLevel;
	}

	const { session } = await createAgentSession(sessionOpts);

	const baseSessionName = agentConfig?.name ?? type;
	session.setSessionName(
		options.agentId
			? `${baseSessionName}#${options.agentId.slice(0, 8)}`
			: baseSessionName,
	);

	// Bind extensions so that session_start fires and extensions can initialize
	// (e.g. loading credentials, setting up state). Tool gating already happened
	// at session construction via the `tools:` allowlist above — no separate
	// post-bind filter is needed. All ExtensionBindings fields are optional.
	await session.bindExtensions({
		onError: (err) => {
			options.onToolActivity?.({
				type: "end",
				toolName: `extension-error:${err.extensionPath}`,
			});
		},
	});

	options.onSessionCreated?.(session);

	// Track turns for graceful max_turns enforcement
	let turnCount = 0;
	const maxTurns = normalizeMaxTurns(
		options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns,
	);
	let softLimitReached = false;
	let aborted = false;

	// GC-2026-022: per-run budget tracker. The four built-in types each
	// have a tuned default; custom (user-defined) types fall back to the
	// developer budget. The tracker writes its own handoff on snapshot
	// / partial / final events; the rich handoff overwrite is the
	// orchestrator's job (it knows the gc_id, task_id, and any SC state).
	const agentTypeForBudget: "developer" | "auditor" | "explorer" | "merger" =
		type === "developer" ||
		type === "auditor" ||
		type === "explorer" ||
		type === "merger"
			? type
			: "developer";
	const budgetTracker = new BudgetTracker(
		loadBudgetFromEnv(agentTypeForBudget),
		undefined, // default path under .pi/orchestrator/handoff/_budget/
		{
			agentType: agentTypeForBudget,
			taskId: options.agentId ?? type,
			gcId: "_budget",
		},
	);
	let budgetFailure: string | undefined;

	let currentMessageText = "";
	// GC-2026-064 T3 (PoC): pre-tool resource-monitor hook. Captured here
	// so the `tool_execution_end` branch can reference the snapshot taken at
	// `tool_execution_start` without re-sampling. Reset to undefined in the
	// calm path so the alloc-free promise holds (no string concat when
	// advis is false).
	let pendingAdvisoryText: string | undefined;
	const monitor = __resourceMonitorForTests ?? new ResourceMonitor();
	const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "turn_end") {
			turnCount++;
			options.onTurnEnd?.(turnCount);
			// GC-2026-022: budget tick. On 80% a partial handoff lands; on
			// 100% the tracker writes the final handoff and throws
			// BudgetExceededError. We catch it here and call session.abort()
			// so pi-mono's prompt loop unwinds cleanly — whether the
			// subscribe callback's throw propagates up or not, the abort
			// guarantees the run ends within one turn. The outer
			// `try { await session.prompt(...) }` also catches and converts
			// the error into `aborted=true` so the SDK caller sees a clean
			// exit.
			try {
				budgetTracker.tick();
			} catch (err) {
				if (err instanceof BudgetExceededError) {
					aborted = true;
					budgetFailure = `budget exceeded: ${err.message}`;
					session.abort();
				} else {
					throw err;
				}
			}
			if (maxTurns != null) {
				if (!softLimitReached && turnCount >= maxTurns) {
					softLimitReached = true;
					session.steer(
						"You have reached your turn limit. Wrap up immediately — provide your final answer now.",
					);
				} else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
					aborted = true;
					session.abort();
				}
			}
		}
		if (event.type === "message_start") {
			currentMessageText = "";
		}
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			currentMessageText += event.assistantMessageEvent.delta;
			options.onTextDelta?.(
				event.assistantMessageEvent.delta,
				currentMessageText,
			);
		}
		if (event.type === "tool_execution_start") {
			// GC-2026-066 T1 (PoC): pre-tool resource-monitor hook. Delegate
			// capture to `captureToolStartAdvisory` so the polarity contract
			// (calm path stays alloc-free) is testable in isolation. When
			// shouldAdvis passes, the helper builds the advisory string and
			// returns it; otherwise it returns undefined without touching
			// formatAdvisory.
			pendingAdvisoryText = captureToolStartAdvisory(monitor);
			options.onToolActivity?.({ type: "start", toolName: event.toolName });
		}
		if (event.type === "tool_execution_end") {
			// GC-2026-066 T1 (PoC): deliver the captured advisory to the LLM
			// via `session.steer(...)` (Path A — see top-of-file block).
			// The agent-session API queues the message and surfaces it on the
			// next model call ("Delivered after the current assistant turn
			// finishes executing its tool calls, before the next LLM call").
			// Fire-and-forget — steer is queue-synchronous, so we don't need
			// to await. Calm path stays alloc-free: pendingAdvisoryText is
			// undefined, the helper is a no-op, no steer call happens.
			deliverPendingAdvisory(session, pendingAdvisoryText);
			pendingAdvisoryText = undefined;
			options.onToolActivity?.({ type: "end", toolName: event.toolName });
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = (event.message as any).usage;
			if (u)
				options.onAssistantUsage?.({
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
				});
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({
				reason: event.reason,
				tokensBefore: event.result.tokensBefore,
			});
		}
	});

	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	// Build the effective prompt: optionally prepend parent context
	let effectivePrompt = prompt;
	if (options.inheritContext) {
		const parentContext = buildParentContext(ctx);
		if (parentContext) {
			effectivePrompt = parentContext + prompt;
		}
	}

	// Boundary for the history fallback: only assistant text produced from here
	// on counts as this run's output (a fresh session, so usually 0).
	const startLen = session.messages.length;

	// GC-2026-042: Per-dispatch advisory state. We track which rules have
	// already been advised and how many advisories we've sent, so the
	// advisoryFor helper can dedup and cap per-dispatch.
	const advisoryCtx: AdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesSent: 0,
	};

	// GC-2026-065: deadline abort propagation. The deadline timer in
	// RunController fires the abort signal at `deadlineMs`; the existing
	// path just sets `runController.signal.aborted = true` but nothing in
	// the LLM loop honours it (session.prompt() runs to natural completion
	// even with an aborted signal). This block:
	//   1. Pre-check: skip session.prompt entirely if the signal was
	//      already aborted before we started (deadline fired before the
	//      run was dispatched, parent signal cancelled us mid-prompt, etc).
	//   2. Post-check: after session.prompt resolves, if the signal became
	//      aborted during the run, mark `aborted=true` so the agent
	//      record surfaces the deadline breach instead of looking complete.
	if (options.runController?.signal.aborted) {
		aborted = true;
		budgetFailure = `agent aborted before run start: ${String(
			options.runController.signal.reason ?? "deadline exceeded",
		)}`;
	} else {
		try {
			await session.prompt(effectivePrompt);
		} catch (err) {
			// GC-2026-022: a budget-throw from the subscriber means the run
			// exceeded its hard turn / wall budget. Convert it to a graceful
			// `aborted=true` exit so the SDK cleans up the session without
			// re-entering pi-mono's prompt loop. The handoff file the tracker
			// already wrote is what the orchestrator reads to resume.
			if (err instanceof BudgetExceededError) {
				aborted = true;
				budgetFailure = `budget exceeded: ${err.message}`;
			} else {
				throw err;
			}
		} finally {
			unsubTurns();
			collector.unsubscribe();
			cleanupAbort();
		}
		// GC-2026-065: post-prompt abort check. If the deadline fired DURING
		// session.prompt and the LLM loop ignored the signal, mark the
		// agent as aborted so the orchestrator records it correctly rather
		// than treating a deadline breach as a clean completion.
		if (options.runController?.signal.aborted && !aborted) {
			aborted = true;
			budgetFailure = `agent aborted during run: ${String(
				options.runController.signal.reason ?? "deadline exceeded",
			)}`;
		}
	}

	// GC-2026-042: Inject governance advisories after the first prompt
	// response. We check the assistant's last text for governance
	// violations; if any major/critical findings would surface in the
	// audit gate, we send an advisory as a follow-up user message and
	// let the agent correct. Per-dispatch cap of 2 advisories; dedup by
	// rule name (no rule is advised twice).
	if (!aborted) {
		const firstText =
			collector.getText().trim() || getLastAssistantText(session, startLen);
		const advisories = advisoryFor(firstText, advisoryCtx);
		for (const advisory of advisories) {
			try {
				await session.prompt(advisory);
				advisoryCtx.advisoriesSent += 1;
				advisoryCtx.alreadyAdvisedRules; // (read marker; dedup is via AdvisoryContext)
				const emittedRule = extractAdvisoryRule(advisory);
				if (emittedRule) advisoryCtx.alreadyAdvisedRules.add(emittedRule);
			} catch {
				// best-effort; if the second prompt fails, the audit gate
				// catches the violation regardless.
				break;
			}
		}
	}

	const responseText =
		collector.getText().trim() || getLastAssistantText(session, startLen);
	const failure = budgetFailure ?? finalTurnError(session, startLen);

	// GC-2026-044 mechanism 1.4 (design §6.4.1): a non-clean exit leaves a typed
	// record on disk. Today the only trace of an abort is a string in a tool
	// result, which is gone as soon as the orchestrator's context is compacted.
	// Clean runs write nothing — `diagnosticForRunResult` returns null for those.
	emitRunDiagnostic(
		{ aborted, steered: softLimitReached, failure },
		type,
		options,
		effectiveCwd,
		options.pi,
	);

	return { responseText, session, aborted, steered: softLimitReached, failure };
}

/**
 * Write the mechanism-1.4 diagnostic for a finished run. Best-effort by
 * construction: `writeDiagnostic` already swallows I/O failures, and the extra
 * try/catch here covers a malformed-payload throw so that a bug in the
 * diagnostic path can never turn a completed run into a failed one.
 *
 * Off switch: `SAGES_DIAGNOSTIC_WRITE=off` (design §2.5 defaults this ON —
 * the record is worth more than the microseconds it costs).
 */
function emitRunDiagnostic(
	result: { aborted: boolean; steered: boolean; failure?: string },
	type: SubagentType,
	options: RunOptions,
	cwd: string,
	pi: { appendEntry: (channel: string, data: unknown) => void },
): void {
	if (process.env.SAGES_DIAGNOSTIC_WRITE === "off") return;
	try {
		const classified = diagnosticForRunResult(result, cwd);
		if (!classified) return;
		// GC-2026-070: compute and persist retryBudgetLeft. The catalog declares
		// handler.retryBudget for retry-subagent modes; we record the budget
		// REMAINING after this attempt so the orchestrator's retry helper can
		// decide whether one more dispatch is allowed without re-loading the
		// catalog. Returns undefined (and writeDiagnostic then omits the field)
		// when the cause has no actionable retry handler.
		const retryBudgetLeft = retryBudgetLeftFor(classified.cause, cwd);
		const written = writeDiagnostic({
			dispatchId: options.agentId ?? `${type}-${Date.now()}`,
			context: { taskId: options.agentId },
			subagentType: type,
			outcome: classified.outcome,
			cause: classified.cause,
			detail: classified.detail,
			evidence: result.failure ? { stderrDigest: result.failure } : undefined,
			...(retryBudgetLeft !== undefined ? { retryBudgetLeft } : {}),
			cwd,
			catalogCwd: cwd,
		});
		// GC-2026-070: push-notify the orchestrator session. The diagnostic is
		// on disk (writeDiagnostic returned a path or null on I/O failure), and
		// a single `system` line into the main session is enough for the
		// orchestrator's next decision to see the cause + remaining budget
		// without needing to re-poll `.pi/diagnostics/`.
		if (written !== null) {
			notifyOrchestrator(pi, {
				schemaVersion: "v1",
				emittedAt: new Date().toISOString(),
				dispatchId: options.agentId ?? `${type}-${Date.now()}`,
				context: { taskId: options.agentId },
				subagentType: type,
				outcome: classified.outcome,
				cause: classified.cause,
				detail: classified.detail,
				evidence: result.failure ? { stderrDigest: result.failure } : undefined,
				...(retryBudgetLeft !== undefined ? { retryBudgetLeft } : {}),
			});
		}
	} catch {
		/* never let post-mortem bookkeeping fail the run */
	}
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
	session: AgentSession,
	prompt: string,
	options: {
		onToolActivity?: (activity: ToolActivity) => void;
		onAssistantUsage?: (usage: {
			input: number;
			output: number;
			cacheWrite: number;
		}) => void;
		onCompaction?: (info: {
			reason: "manual" | "threshold" | "overflow";
			tokensBefore: number;
		}) => void;
		signal?: AbortSignal;
	} = {},
): Promise<{ text: string; failure?: string }> {
	// Boundary for the history fallback: the session already holds prior turns,
	// so only assistant text produced by THIS resume prompt counts as its output
	// — a failed resume must not surface the previous turn's answer (#144).
	const startLen = session.messages.length;
	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	const unsubEvents =
		options.onToolActivity || options.onAssistantUsage || options.onCompaction
			? session.subscribe((event: AgentSessionEvent) => {
					if (event.type === "tool_execution_start")
						options.onToolActivity?.({
							type: "start",
							toolName: event.toolName,
						});
					if (event.type === "tool_execution_end")
						options.onToolActivity?.({ type: "end", toolName: event.toolName });
					if (
						event.type === "message_end" &&
						event.message.role === "assistant"
					) {
						const u = (event.message as any).usage;
						if (u)
							options.onAssistantUsage?.({
								input: u.input ?? 0,
								output: u.output ?? 0,
								cacheWrite: u.cacheWrite ?? 0,
							});
					}
					if (
						event.type === "compaction_end" &&
						!event.aborted &&
						event.result
					) {
						options.onCompaction?.({
							reason: event.reason,
							tokensBefore: event.result.tokensBefore,
						});
					}
				})
			: () => {};

	try {
		await session.prompt(prompt);
	} finally {
		collector.unsubscribe();
		unsubEvents();
		cleanupAbort();
	}

	return {
		text: collector.getText().trim() || getLastAssistantText(session, startLen),
		failure: finalTurnError(session, startLen),
	};
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
	session: AgentSession,
	message: string,
): Promise<void> {
	await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
	const parts: string[] = [];

	for (const msg of session.messages) {
		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: extractText(msg.content);
			if (text.trim()) parts.push(`[User]: ${text.trim()}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const toolCalls: string[] = [];
			for (const c of msg.content) {
				if (c.type === "text" && c.text) textParts.push(c.text);
				else if (c.type === "toolCall")
					toolCalls.push(
						`  Tool: ${toolDisplayName((c as any).name ?? (c as any).toolName ?? "unknown")}`,
					);
			}
			if (textParts.length > 0)
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			if (toolCalls.length > 0)
				parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
		} else if (msg.role === "toolResult") {
			const text = extractText(msg.content);
			const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
			parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
		}
	}

	return parts.join("\n\n");
}

// =============================================================================
// GC-2026-037: structured YAML output (T2)
//
// Every subagent dispatch (developer / auditor / Explore / Plan) MUST
// produce a final message containing a YAML block in the schema below.
// `extractStructuredOutput` parses that block into a typed object the
// orchestrator (and the audit gate) can consume mechanically. Missing or
// malformed blocks return `null` — the orchestrator then treats the
// dispatch as "structured output missing" (a separate fail-closed check,
// future phase).
// =============================================================================

export type SubagentOutputStatus = "completed" | "blocked" | "partial";

export interface SubagentOutputFailDetail {
	file?: string;
	test?: string;
	message?: string;
}

export interface SubagentOutputOpenQuestion {
	question: string;
	whyBlocking?: boolean;
	suggestion?: string;
}

export interface SubagentOutputHandoff {
	readFirst: string;
	context?: string;
}

export interface SubagentOutput {
	status: SubagentOutputStatus;
	deliverables: {
		filesChanged: string[];
		commits: string[];
		testsAdded: string[];
	};
	testResults: {
		pass: number;
		fail: number;
		failDetails: SubagentOutputFailDetail[];
	};
	openQuestions: SubagentOutputOpenQuestion[];
	handoffForNextTask: SubagentOutputHandoff[];
}

/**
 * Internal shape of the parsed YAML before the camelCase rename. The YAML
 * uses snake_case (`files_changed`, `test_results`, `handoff_for_next_task`)
 * for human readability; the public `SubagentOutput` type exposes
 * camelCase fields (`filesChanged`, `testResults`, `handoffForNextTask`).
 */
interface RawSubagentOutput {
	status: SubagentOutputStatus;
	deliverables: {
		files_changed?: unknown;
		commits?: unknown;
		tests_added?: unknown;
		[key: string]: unknown;
	};
	test_results: {
		pass?: unknown;
		fail?: unknown;
		fail_details?: unknown;
		[key: string]: unknown;
	};
	open_questions?: unknown;
	handoff_for_next_task?: unknown;
}

const REQUIRED_FIELDS = [
	"status",
	"deliverables",
	"test_results",
	"open_questions",
] as const;

const STATUSES: ReadonlySet<SubagentOutputStatus> =
	new Set<SubagentOutputStatus>(["completed", "blocked", "partial"]);

/**
 * Parse a structured YAML block out of an agent's final message.
 *
 * Recognizes three fence variants:
 *   - ```yaml ... ```
 *   - ```yaml ... ``` (possibly indented)
 *   - --- ... --- (YAML front-matter style)
 *
 * Returns the parsed shape on success, or `null` if the message has no
 * YAML block, the block is malformed, or required fields are missing.
 * The helper is intentionally permissive about extra fields (e.g. custom
 * agent types can extend the schema) but strict about required fields
 * (status/deliverables/test_results/open_questions/handoff_for_next_task).
 */
export function extractStructuredOutput(text: string): SubagentOutput | null {
	const block = extractYamlBlock(text);
	if (block === null) return null;

	let parsed: unknown;
	try {
		// The agent-runner bundle does not include a YAML parser; the YAML
		// surface here is intentionally narrow (see REQUIRED_FIELDS) so a
		// minimal-purpose parser suffices. We hand-roll a tolerant parser
		// for the subset the agents emit — see parseYamlSubset below.
		parsed = parseYamlSubset(block);
	} catch {
		// Public contract: `null` on malformed input. Production callers
		// gate on this; tests verify it explicitly.
		return null;
	}
	if (!isPlainObject(parsed)) return null;

	for (const f of REQUIRED_FIELDS) {
		if (!(f in parsed)) return null;
	}

	const raw = parsed as unknown as RawSubagentOutput;
	if (
		typeof raw.status !== "string" ||
		!STATUSES.has(raw.status as SubagentOutputStatus)
	) {
		return null;
	}
	if (!isPlainObject(raw.deliverables)) return null;
	if (!isPlainObject(raw.test_results)) return null;
	if (!Array.isArray(raw.open_questions)) return null;

	return {
		status: raw.status as SubagentOutputStatus,
		deliverables: {
			filesChanged: asStringArray(raw.deliverables.files_changed),
			commits: asStringArray(raw.deliverables.commits),
			testsAdded: asStringArray(raw.deliverables.tests_added),
		},
		testResults: {
			pass: asNumber(raw.test_results.pass, 0),
			fail: asNumber(raw.test_results.fail, 0),
			failDetails: asFailDetails(raw.test_results.fail_details),
		},
		openQuestions: asOpenQuestions(raw.open_questions),
		handoffForNextTask: asHandoffs(raw.handoff_for_next_task),
	};
}

/**
 * Extract a YAML block from a message. Recognizes:
 *   - ```yaml ... ```
 *   - indented ```yaml ... ``` (preserved with leading indent stripped)
 *   - --- ... --- front-matter style
 *
 * Returns the inner content with each line's leading indent stripped, or
 * `null` if no recognizable block is present.
 */
function extractYamlBlock(text: string): string | null {
	const fenceRe = /^[ \t]*```yaml[ \t]*\n([\s\S]*?)\n?[ \t]*```[ \t]*$/m;
	const fenceMatch = text.match(fenceRe);
	if (fenceMatch && typeof fenceMatch[1] === "string") {
		// Detect a uniform leading indent (e.g. the block is itself inside
		// an indented list item) and strip ONLY that common prefix. Preserve
		// per-line relative indentation so the parser can read the structure.
		const raw = fenceMatch[1];
		const indents = raw
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => l.length - l.trimStart().length);
		const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
		if (minIndent > 0) {
			return raw
				.split("\n")
				.map((l) => (l.length >= minIndent ? l.slice(minIndent) : l))
				.join("\n");
		}
		return raw;
	}
	const dashRe = /(?:^|\n)---\n([\s\S]*?)\n---\n?/;
	const dashMatch = text.match(dashRe);
	if (dashMatch && typeof dashMatch[1] === "string") {
		return dashMatch[1];
	}
	return null;
}

/**
 * Indent-based YAML subset parser. Recursive descent on indentation:
 * - Each line carries an `indent` (column of first non-whitespace) and
 *   `content` (the line with leading whitespace stripped).
 * - A "frame stack" tracks whether we're inside a mapping or list.
 * - New key: value at higher indent than current frame pushes a new
 *   frame; lower indent pops frames.
 * - Inline arrays `[a, b, c]` and inline objects `{k: v}` are JSON-parsed.
 *
 * Returns the parsed shape on success, throws on malformed input.
 */
function parseYamlSubset(input: string): unknown {
	const raw = input.replace(/\r\n?/g, "\n");
	const tokens: Array<{ indent: number; content: string }> = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		tokens.push({ indent, content: line.trim() });
	}
	if (tokens.length === 0) {
		throw new Error("parseYamlSubset: empty input");
	}
	const ctx: ParseContext = {
		tokens,
		pos: 0,
	};
	return parseNode(ctx, 0, /* inList */ false);
}

interface ParseContext {
	tokens: Array<{ indent: number; content: string }>;
	pos: number;
}

/**
 * Parse one node (mapping or list) at the given indent.
 * `inList` distinguishes: a top-level mapping (no list anchor) vs. a
 * mapping that is itself a list item.
 */
function parseNode(
	ctx: ParseContext,
	minIndent: number,
	inList: boolean,
): unknown {
	const first = ctx.tokens[ctx.pos];
	if (!first) {
		throw new Error("parseNode: unexpected end of input");
	}
	if (first.indent < minIndent) {
		throw new Error(`parseNode: indent ${first.indent} below min ${minIndent}`);
	}

	// Lookahead: is the first non-empty line a list item (`- ...`)?
	const isListStart = /^-(\s|$)/.test(first.content);

	if (isListStart && !inList) {
		return parseList(ctx, first.indent);
	}
	return parseMapping(ctx, first.indent, inList);
}

function parseMapping(
	ctx: ParseContext,
	indent: number,
	childIsList: boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	while (ctx.pos < ctx.tokens.length) {
		const t = ctx.tokens[ctx.pos];
		if (!t || t.indent < indent) break;
		if (t.indent > indent) {
			throw new Error(
				`parseMapping: unexpected indent ${t.indent} (expected ${indent}) at "${t.content}"`,
			);
		}
		// Top-level key.
		const kv = t.content.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
		if (!kv || kv[1] === undefined) {
			throw new Error(`parseMapping: not a key-value line: "${t.content}"`);
		}
		const key = kv[1];
		const rest = (kv[2] ?? "").trim();
		ctx.pos++;

		if (rest === "" || rest === "|") {
			// Look ahead: next line's indent must be > current.
			const next = ctx.tokens[ctx.pos];
			if (!next || next.indent <= indent) {
				out[key] = rest === "|" ? null : null;
				continue;
			}
			// Decide whether the next block is a list or a mapping based on
			// its first non-empty line. The first line either starts with
			// `-` (list) or with a key:value (nested mapping).
			const childIsListValue = /^-(\s|$)/.test(next.content);
			if (childIsListValue) {
				out[key] = parseList(ctx, next.indent);
			} else {
				out[key] = parseMapping(ctx, next.indent, /* childIsList */ false);
			}
		} else {
			out[key] = parseScalar(rest);
		}
	}
	return out;
}

function parseList(ctx: ParseContext, indent: number): unknown[] {
	const out: unknown[] = [];
	while (ctx.pos < ctx.tokens.length) {
		const t = ctx.tokens[ctx.pos];
		if (!t || t.indent < indent) break;
		if (t.indent > indent) {
			throw new Error(
				`parseList: unexpected indent ${t.indent} (expected ${indent}) at "${t.content}"`,
			);
		}
		const itemMatch = t.content.match(/^-(\s+(.*))?$/);
		if (!itemMatch) {
			throw new Error(`parseList: expected list item, got "${t.content}"`);
		}
		const after = (itemMatch[2] ?? "").trim();
		ctx.pos++;

		if (after === "") {
			// `-` alone: next block is the list item's content (mapping).
			const next = ctx.tokens[ctx.pos];
			if (!next || next.indent <= indent) {
				out.push(null);
				continue;
			}
			const childIsListValue = /^-(\s|$)/.test(next.content);
			if (childIsListValue) {
				out.push(parseList(ctx, next.indent));
			} else {
				out.push(parseMapping(ctx, next.indent, /* childIsList */ true));
			}
		} else {
			// `- key: value` one-liner.
			const kv = after.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
			if (kv && kv[1] !== undefined) {
				const key = kv[1];
				const rest = (kv[2] ?? "").trim();
				const obj: Record<string, unknown> = {};
				if (rest === "" || rest === "|") {
					const next = ctx.tokens[ctx.pos];
					if (next && next.indent > indent + 2) {
						const childIsListValue = /^-(\s|$)/.test(next.content);
						if (childIsListValue) {
							obj[key] = parseList(ctx, next.indent);
						} else {
							obj[key] = parseMapping(ctx, next.indent, false);
						}
					} else {
						obj[key] = null;
					}
				} else {
					obj[key] = parseScalar(rest);
				}
				// Consume any continuation indented under this list item.
				// A continuation has `next.indent > indent` (deeper than the
				// list's own indent; the dash prefix at `indent + 2` doesn't
				// count as a "deeper" sibling because it's the same item).
				while (ctx.pos < ctx.tokens.length) {
					const next = ctx.tokens[ctx.pos];
					if (!next || next.indent <= indent) break;
					const cont = next.content.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
					if (!cont || cont[1] === undefined) break;
					obj[cont[1]] = cont[2] === undefined ? null : parseScalar(cont[2]);
					ctx.pos++;
				}
				out.push(obj);
			} else {
				out.push(parseScalar(after));
			}
		}
	}
	return out;
}

function parseScalar(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "~" || trimmed === "null") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	// Inline JSON-style array.
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			return JSON.parse(trimmed.replace(/'/g, '"'));
		} catch {
			// Fall through — treat as plain string.
		}
	}
	// Inline JSON-style object.
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			return JSON.parse(trimmed.replace(/'/g, '"'));
		} catch {
			// Fall through.
		}
	}
	// Quoted strings.
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	// Strip inline comments.
	const commentIdx = trimmed.indexOf(" #");
	if (commentIdx > 0) return trimmed.slice(0, commentIdx).trim();
	return trimmed;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

function asNumber(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asFailDetails(v: unknown): SubagentOutputFailDetail[] {
	if (!Array.isArray(v)) return [];
	return v.filter(isPlainObject).map((d) => ({
		file: typeof d.file === "string" ? d.file : undefined,
		test: typeof d.test === "string" ? d.test : undefined,
		message: typeof d.message === "string" ? d.message : undefined,
	}));
}

function asOpenQuestions(v: unknown): SubagentOutputOpenQuestion[] {
	if (!Array.isArray(v)) return [];
	return v
		.filter(isPlainObject)
		.map((q) => ({
			question: typeof q.question === "string" ? q.question : "",
			whyBlocking:
				typeof q.why_blocking === "boolean" ? q.why_blocking : undefined,
			suggestion: typeof q.suggestion === "string" ? q.suggestion : undefined,
		}))
		.filter((q) => q.question !== "");
}

function asHandoffs(v: unknown): SubagentOutputHandoff[] {
	if (!Array.isArray(v)) return [];
	return v
		.filter(isPlainObject)
		.map((h) => ({
			readFirst: typeof h.read_first === "string" ? h.read_first : "",
			context: typeof h.context === "string" ? h.context : undefined,
		}))
		.filter((h) => h.readFirst !== "");
}

// =============================================================================
// GC-2026-037 T3: Network gating
//
// `NetworkNotAllowedError` is thrown by the network gate when an agent
// dispatches a network-bearing command (git fetch, curl, etc.) while
// `network_allowed` is false. The orchestrator audit gate distinguishes this
// failure mode (governance violation) from a generic execution error
// and reports it separately in the task report.
//
// `isNetworkCommand(command, args)` returns true for known-network
// commands. The list is intentionally narrow — only commands that hit
// the network are gated. Local git operations (status, diff, commit,
// branch) are NEVER gated.
//
// `wrapPiForNetworkGate(pi, allowed)` returns a Proxy that intercepts
// `pi.exec()` calls and throws NetworkNotAllowedError for network
// commands when allowed=false. All other pi methods pass through.
// =============================================================================

export class NetworkNotAllowedError extends Error {
	readonly command: string;
	readonly args: readonly string[];
	constructor(command: string, args: readonly string[]) {
		super(
			`network access disabled: \`${command}${args.length > 0 ? " " + args.join(" ") : ""}\` is a network-bearing command. ` +
				`Pass network_allowed: true to override per-dispatch.`,
		);
		this.name = "NetworkNotAllowedError";
		this.command = command;
		this.args = args;
	}
}

/**
 * Detect known network-bearing commands. Conservative list: only mark
 * commands that demonstrably hit the network. Local git operations
 * (status, diff, log, commit, branch, checkout, add, reset, revert,
 * merge, rebase) are NOT in this list.
 */
export function isNetworkCommand(
	command: string,
	args: readonly string[],
): boolean {
	const c = command.toLowerCase();
	if (c === "git") {
		// `git <subcommand>` — only specific subcommands are network.
		const sub = (args[0] ?? "").toLowerCase();
		const NETWORK_SUBCMDS = new Set([
			"fetch",
			"pull",
			"clone",
			"ls-remote",
			"push",
			"remote",
			"request-pull",
		]);
		return NETWORK_SUBCMDS.has(sub);
	}
	// Direct network tools.
	if (
		c === "curl" ||
		c === "wget" ||
		c === "nc" ||
		c === "ncat" ||
		c === "telnet" ||
		c === "ssh" ||
		c === "scp" ||
		c === "rsync" ||
		c === "ftp" ||
		c === "sftp"
	) {
		return true;
	}
	// Package managers — `install`, `add`, `publish`, `login` etc. all
	// touch the network. `npm ls`, `bun pm ls` etc. don't. The flag
	// `-h/--help/-v/--version` is a fast local-only path.
	if (
		c === "npm" ||
		c === "bun" ||
		c === "pnpm" ||
		c === "yarn" ||
		c === "pip" ||
		c === "pip3" ||
		c === "uv" ||
		c === "poetry"
	) {
		const sub = (args[0] ?? "").toLowerCase();
		// First-arg subcommands that are network. Anything else
		// (including ls, list, config, doctor, etc.) is local and
		// passes through.
		const NETWORK_SUB = new Set([
			"install",
			"add",
			"i",
			"update",
			"upgrade",
			"publish",
			"login",
			"logout",
			"uninstall",
			"remove",
			"rm",
			"search",
			"view",
			"info",
			"outdated",
		]);
		return NETWORK_SUB.has(sub);
	}
	return false;
}

export function enforceNetworkGate(
	command: string,
	args: readonly string[],
	allowed: boolean,
): void {
	if (allowed) return;
	if (isNetworkCommand(command, args)) {
		throw new NetworkNotAllowedError(command, args);
	}
}

/**
 * Wrap an `ExtensionAPI` so that `pi.exec()` calls are intercepted and
 * gated against network commands. The Proxy delegates every other
 * property access to the original `pi`. When `allowed` is true, the
 * wrapper is a no-op pass-through (no Proxy overhead in the common
 * case — callers should skip the wrap when allowed).
 */
export function wrapPiForNetworkGate<T extends object>(
	pi: T,
	allowed: boolean,
): T {
	if (allowed) return pi;
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "exec") {
				return (command: string, args: string[], options?: unknown) => {
					enforceNetworkGate(command, args, allowed);
					// @ts-expect-error — generic Proxy delegation
					return Reflect.get(target, prop, receiver).call(
						target,
						command,
						args,
						options,
					);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as T;
}

// =============================================================================
// GC-2026-038 T3: parseCheckpoint helper
//
// Agent prompts instruct the LLM to emit a checkpoint line every 5 turns:
//   [checkpoint N/200 turns, Xm] <work summary>. <commit count>. blocker: <state>.
//
// `parseCheckpoint(text)` extracts the most recent checkpoint line, returning
// { turnNumber, timeMinutes, workSummary, commitCount, blocker } | null.
// The orchestrator can read this to track progress; future phases may
// use it to enforce "2 consecutive no-progress checkpoints -> BLOCKED".
// =============================================================================

export interface SubagentCheckpoint {
	turnNumber: number;
	timeMinutes: number;
	workSummary: string;
	commitCount: number;
	blocker: string;
}

const CHECKPOINT_LINE_RE =
	/\[checkpoint\s+(\d+)\/(\d+)\s+turns,\s+([\d.mhs]+)\]\s+([^.]+)\.\s+(\d+)\s+commits?\.\s+blocker:\s*([^.]+?)\.?$/i;

/**
 * Parse the time field of a checkpoint line. Accepts:
 *   - "5m" -> 5
 *   - "1.5m" -> 1.5
 *   - "1m32s" -> 1.533... (1 minute 32 seconds = 1 + 32/60)
 *   - "2m0s" -> 2
 * Returns NaN for unparseable input.
 */
function parseCheckpointTime(s: string): number {
	const minMatch = s.match(/(\d+(?:\.\d+)?)\s*m/);
	const secMatch = s.match(/(\d+(?:\.\d+)?)\s*s/);
	const minutes = minMatch ? Number.parseFloat(minMatch[1] ?? "0") : 0;
	const seconds = secMatch ? Number.parseFloat(secMatch[1] ?? "0") : 0;
	return minutes + seconds / 60;
}

export function parseCheckpoint(text: string): SubagentCheckpoint | null {
	// Find the LAST checkpoint line in the text (most recent wins).
	// Time format: "1m32s" / "5m" / "1.5m" / etc. The `[\d.mhs]+` class accepts all
	// of these. We capture groups: 1=turn, 2=maxTurns, 3=time, 4=workSummary,
	// 5=commitCount, 6=blocker.
	const matches = [
		...text.matchAll(
			/\[checkpoint\s+(\d+)\/(\d+)\s+turns,\s+([\d.mhs]+)\]\s+([\s\S]+?)\s+(\d+)\s+commits?\.\s+blocker:\s*([^.\n]+?)\.?\s*(?:\n|$)/gi,
		),
	];
	if (matches.length === 0) return null;
	const last = matches[matches.length - 1];
	if (!last) return null;
	return {
		turnNumber: Number.parseInt(last[1] ?? "0", 10),
		// last[2] is the max turns (e.g. 200) — we don't currently use it,
		// but it's part of the schema so extract it for future use.
		// (Stored in turnNumber-only for now.)
		timeMinutes: parseCheckpointTime(last[3] ?? "0"),
		workSummary: (last[4] ?? "").trim(),
		commitCount: Number.parseInt(last[5] ?? "0", 10),
		blocker: (last[6] ?? "").trim(),
	};
}

// =============================================================================
// GC-2026-038 T4: extractAsk helper
//
// Agent prompts instruct the LLM to emit <ASK>question</ASK> when stuck.
// `extractAsk(text)` parses all <ASK>...</ASK> blocks and returns the
// trimmed questions. The orchestrator (or a future dashboard) reads
// these to surface blockers to the user.
// =============================================================================

export function extractAsk(text: string): string[] {
	const matches = [...text.matchAll(/<ASK>([\s\S]+?)<\/ASK>/gi)];
	return matches.map((m) => (m[1] ?? "").trim()).filter((q) => q.length > 0);
}

// =============================================================================
// GC-2026-039: Runtime enforcement of prompt-layer governance.
//
// `extractAuditFindings(agentMessage, taskReport)` is the closed-loop on
// GC-2026-038's prompt-layer commitments. The agent is told to:
//   - emit a YAML block (commit count, file changes, open_questions, etc.)
//   - emit [checkpoint N/200 turns, Xm] lines every 5 turns
//   - emit <ASK>question</ASK> when stuck
//   - commit per RED/GREEN test
//   - declare BLOCKED with a reason if it can't proceed
//
// The audit gate cannot enforce these in real-time (the agent is the
// enforcer for the in-task behavior), but it CAN detect violations
// post-hoc. The 5 rules below are what the orchestrator_audit tool
// looks for in the agent's last message and the task report.
// =============================================================================

export type AuditFindingSeverity = "minor" | "major" | "critical";
export type AuditFindingCategory =
	| "ink"
	| "nose"
	| "foot"
	| "castration"
	| "death";

export interface AuditFinding {
	/** Stable id like "AF-001". */
	id: string;
	/** Rule that produced this finding. */
	rule:
		| "missing_yaml_block"
		| "completed_no_commits"
		| "checkpoint_stuck_pattern"
		| "ask_unanswered"
		| "blocked_without_reason";
	/** Severity (minor / major / critical). */
	severity: AuditFindingSeverity;
	/** Short category (castration / death / ink / nose / foot). */
	category: AuditFindingCategory;
	/** Human-readable issue description. */
	issue: string;
	/** Concrete evidence (path:line, regex match, etc.). */
	evidence: string;
	/** Recommended fix. */
	recommendation: string;
}

const FINDING_IDS_USED = new Set<string>();
function nextFindingId(): string {
	for (let n = 1; n < 1000; n++) {
		const id = `AF-${String(n).padStart(3, "0")}`;
		if (!FINDING_IDS_USED.has(id)) {
			FINDING_IDS_USED.add(id);
			return id;
		}
	}
	return "AF-999"; // fallback (unreachable in practice)
}

/**
 * Extract audit findings from the agent's last message and the task
 * report. Combines:
 *   - extractStructuredOutput (YAML block parse)
 *   - parseCheckpoint (checkpoint line parse)
 *   - extractAsk (<ASK> block parse)
 *   - 5 rule-based checks (the governance compliance checks below)
 *
 * Returns an array of AuditFinding, sorted by severity (critical > major
 * > minor). Returns an empty array when the message is well-formed.
 */
export function extractAuditFindings(
	agentMessage: string,
	taskReport: string = "",
): AuditFinding[] {
	FINDING_IDS_USED.clear();
	const findings: AuditFinding[] = [];

	// 1. Parse the structured output (YAML block).
	const structured = extractStructuredOutput(agentMessage);

	// 2. Parse the checkpoints (multi-line scan).
	const checkpointMatches = [
		...agentMessage.matchAll(
			/\[checkpoint\s+(\d+)\/(\d+)\s+turns,\s+([\d.mhs]+)\]\s+([\s\S]+?)\s+(\d+)\s+commits?\.\s+blocker:\s*([^.\n]+?)\.?\s*(?:\n|$)/gi,
		),
	];
	const checkpoints = checkpointMatches
		.map((m) => ({
			turnNumber: Number.parseInt(m[1] ?? "0", 10),
			timeMinutes: parseCheckpointTime(m[3] ?? "0"),
			workSummary: (m[4] ?? "").trim(),
			commitCount: Number.parseInt(m[5] ?? "0", 10),
			blocker: (m[6] ?? "").trim(),
		}))
		.filter((c) => Number.isFinite(c.turnNumber) && c.turnNumber > 0);

	// 3. Parse the <ASK> blocks.
	const askQuestions = extractAsk(agentMessage);

	// Rule 1: missing_yaml_block
	if (structured === null) {
		findings.push({
			id: nextFindingId(),
			rule: "missing_yaml_block",
			severity: "major",
			category: "ink",
			issue:
				"agent message has no parseable YAML block; orchestrator cannot verify deliverables mechanically",
			evidence: "extractStructuredOutput returned null",
			recommendation:
				"agent must emit ```yaml ... ``` block with status / deliverables / test_results / open_questions / handoff_for_next_task",
		});
	}

	// Only the following rules need the structured block.
	if (structured !== null) {
		// Rule 2: completed_no_commits
		if (
			structured.status === "completed" &&
			structured.deliverables.commits.length === 0
		) {
			findings.push({
				id: nextFindingId(),
				rule: "completed_no_commits",
				severity: "major",
				category: "ink",
				issue:
					"status=completed but the YAML block lists zero commits; commit-discipline (GC-2026-038 T1) was not followed",
				evidence: "deliverables.commits is empty",
				recommendation:
					"agent must commit RED/GREEN test work; status=completed requires >=1 commit",
			});
		}

		// Rule 3: checkpoint_stuck_pattern
		if (checkpoints.length >= 2) {
			const lastTwo = checkpoints.slice(-2);
			if (
				lastTwo[0] &&
				lastTwo[1] &&
				lastTwo[0].commitCount === lastTwo[1].commitCount &&
				lastTwo[0].turnNumber !== lastTwo[1].turnNumber
			) {
				findings.push({
					id: nextFindingId(),
					rule: "checkpoint_stuck_pattern",
					severity: "major",
					category: "castration",
					issue: `2 consecutive checkpoints with same commit count (${lastTwo[0].commitCount}); agent is stuck on exploration`,
					evidence: `checkpoints: turn ${lastTwo[0].turnNumber} (${lastTwo[0].commitCount} commits) and turn ${lastTwo[1].turnNumber} (${lastTwo[1].commitCount} commits)`,
					recommendation:
						"agent should declare BLOCKED with open_questions; the orchestrator will re-dispatch with narrower scope",
				});
			}
		}

		// Rule 4: ask_unanswered
		if (askQuestions.length > 0) {
			// The orchestrator should have surfaced these in task report's open_questions
			// or in a separate questions list. Detect if the task report does
			// NOT mention the asks.
			const asksNotInReport = askQuestions.filter(
				(q) => !taskReport.toLowerCase().includes(q.toLowerCase().slice(0, 30)),
			);
			if (asksNotInReport.length > 0) {
				findings.push({
					id: nextFindingId(),
					rule: "ask_unanswered",
					severity: "major",
					category: "ink",
					issue: `${asksNotInReport.length} <ASK> question(s) not surfaced in task report`,
					evidence: asksNotInReport.map((q) => q.slice(0, 60)).join(" | "),
					recommendation:
						"the orchestrator should surface <ASK> questions to the user; the task report must include them in open_questions",
				});
			}
		}

		// Rule 5: blocked_without_reason
		if (
			structured.status === "blocked" &&
			structured.openQuestions.length === 0
		) {
			findings.push({
				id: nextFindingId(),
				rule: "blocked_without_reason",
				severity: "minor",
				category: "ink",
				issue:
					"status=blocked but open_questions is empty; the orchestrator cannot unblock without a reason",
				evidence:
					"deliverables.commits may be empty AND open_questions is empty",
				recommendation:
					"agent must describe what's missing in open_questions when declaring BLOCKED",
			});
		}
	}

	// Sort by severity (critical > major > minor).
	const severityOrder: Record<AuditFindingSeverity, number> = {
		critical: 0,
		major: 1,
		minor: 2,
	};
	findings.sort(
		(a, b) => severityOrder[a.severity] - severityOrder[b.severity],
	);

	return findings;
}

// =============================================================================
// GC-2026-042: Advisory mechanism — pre-message governance warnings.
//
// The agent only learns about governance violations AFTER the final
// message (via the audit gate). This is too late to correct. The
// advisory mechanism injects warnings into the agent's context DURING
// the run, so the agent can fix the violation in the next turn.
//
// The advisory is gated by:
//   - Severity filter: only major + critical findings produce advisories.
//     Minor findings (e.g. "you forgot a comma") are noise.
//   - Dedup: same rule name does not produce 2 advisories in the same
//     dispatch. The dispatcher tracks a Set<string> of advised rules.
//   - Per-dispatch cap: max 2 advisories per dispatch. Beyond that, the
//     audit gate catches the rest (no need to spam the agent).
//   - Per-advisory token cap: 200 tokens. We approximate tokens as
//     text.length / 4 (close enough for advisory text; not a precise
//     tokenizer). The advisory is truncated if it would exceed the cap.
//
// The advisory is text-only and is appended as a synthetic user message
// between the agent's tool call and the next turn. The agent reads it
// and decides whether to act on it (commit, add YAML, etc.).
// =============================================================================

/** Approximate tokens: text.length / 4. */
function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Truncate a string to fit within the token cap. Adds "..." when truncated. */
function truncateToTokens(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return text.slice(0, Math.max(0, maxChars - 3)) + "...";
}

export interface AdvisoryContext {
	/** Rules already advised in this dispatch. Used to suppress duplicates. */
	alreadyAdvisedRules: Set<string>;
	/** Number of advisories already sent in this dispatch. */
	advisoriesSent: number;
}

export const ADVISORY_MAX_TOKENS = 200;
export const ADVISORY_MAX_TOKENS_WITH_SCHEMA = 400;
export const ADVISORY_MAX_PER_DISPATCH = 2;
export const ADVISORY_MIN_SEVERITY: "major" | "critical" = "major";

/** The YAML schema the agent is expected to emit. Used in advisory when
 *  includeSchemaTemplate is enabled AND the finding is missing_yaml_block.
 *  Compact (~150 tokens) but complete enough to satisfy the audit parser.
 *  Note: the value of `status` is plain text + a comment to avoid the
 *  YAML pipe (`|`) character, which the audit's parseYamlSubset does
 *  not handle. The agent should replace `completed` with `blocked` or
 *  `partial` as appropriate. */
export const ADVISORY_YAML_SCHEMA = `\`\`\`yaml
status: completed  # one of: completed, blocked, partial
deliverables:
  files_changed: ["path/to/file.ts"]
  commits: ["abc1234"]
  tests_added: ["path/to/test.ts::test name"]
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;

/**
 * Per-rule actionable fix text. Generic recommendations in extractAuditFindings
 * describe the problem in general terms; this map tells the LLM exactly what
 * to do (shell command, YAML fragment). Compact (30-100 tokens per rule).
 */
export const RULE_FIX_DIRECTIVES: Record<string, string> = {
	missing_yaml_block:
		"emit a ```yaml ... ``` block at the end of your message (schema below)",
	completed_no_commits:
		'run `git log --oneline -5 --format=%H` and put the SHAs in YAML as: commits: ["sha1", "sha2", ...]',
	checkpoint_stuck_pattern:
		'either (a) commit work now: `git add -A && git commit -m "wip: <task>"`, or (b) change YAML status to "blocked" and explain in open_questions',
	ask_unanswered:
		'add the <ASK> question to YAML open_questions as: open_questions: [{question: "...", why_blocking: true}]',
	blocked_without_reason:
		'add a non-empty open_questions array describing what\'s missing (e.g. `open_questions: [{question: "what API?", why_blocking: true}]`)',
};

/**
 * Build advisory strings for the agent. Returns 0-2 advisory strings,
 * each capped at ADVISORY_MAX_TOKENS tokens (or ADVISORY_MAX_TOKENS_WITH_SCHEMA
 * when the schema template is included). Filters:
 *   - severity: only major+critical
 *   - dedup: skip rules already in ctx.alreadyAdvisedRules
 *   - cap: at most ADVISORY_MAX_PER_DISPATCH advisories per call
 *   - token cap: per-advisory text is truncated to ADVISORY_MAX_TOKENS
 *   - schema template (optional): when enabled AND finding is
 *     missing_yaml_block, the YAML schema is appended to the advisory so
 *     the agent knows what to emit.
 *   - per-rule fix directive (always): the fix text in the advisory is
 *     pulled from RULE_FIX_DIRECTIVES (actionable shell command) instead
 *     of the generic f.recommendation.
 *
 * Format: [orchestrator audit advisory — N/M] <rule>: <issue>. Fix: <directive>.
 * Optional schema appended after the issue/fix line.
 */
export interface AdvisoryOptions {
	/** When true (default) and the finding is missing_yaml_block, append
	 *  the YAML schema template to the advisory so the agent knows what
	 *  to emit. Other findings don't get the schema (token savings). */
	includeSchemaTemplate?: boolean;
}

export function advisoryFor(
	agentMessage: string,
	ctx: AdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesSent: 0,
	},
	options: AdvisoryOptions = {},
): string[] {
	if (ctx.advisoriesSent >= ADVISORY_MAX_PER_DISPATCH) return [];

	const includeSchema = options.includeSchemaTemplate !== false;
	const findings = extractAuditFindings(agentMessage, "");
	// Filter: severity ≥ major AND not already advised AND not at cap.
	const eligible = findings.filter(
		(f) =>
			(f.severity === "major" || f.severity === "critical") &&
			!ctx.alreadyAdvisedRules.has(f.rule) &&
			ctx.advisoriesSent < ADVISORY_MAX_PER_DISPATCH,
	);

	const out: string[] = [];
	for (const f of eligible) {
		if (ctx.advisoriesSent + out.length >= ADVISORY_MAX_PER_DISPATCH) break;
		const n = ctx.advisoriesSent + out.length + 1;
		const total = Math.min(eligible.length, ADVISORY_MAX_PER_DISPATCH);
		// Per-rule actionable fix directive (replaces the generic f.recommendation).
		// Falls back to f.recommendation if the rule is not in the map.
		const fixText = RULE_FIX_DIRECTIVES[f.rule] ?? f.recommendation;
		let advisory = `[orchestrator audit advisory — ${n}/${total}] ${f.rule}: ${f.issue}. Fix: ${fixText}`;
		// Schema template only for missing_yaml_block (LLM needs the format)
		if (includeSchema && f.rule === "missing_yaml_block") {
			advisory += `\n\nRequired YAML schema (copy this verbatim):\n${ADVISORY_YAML_SCHEMA}`;
		}
		const maxTokens =
			includeSchema && f.rule === "missing_yaml_block"
				? ADVISORY_MAX_TOKENS_WITH_SCHEMA
				: ADVISORY_MAX_TOKENS;
		const capped = truncateToTokens(advisory, maxTokens);
		out.push(capped);
	}

	return out;
}

// Helper: parse the rule name out of an advisory string for dedup.
// Format: "[orchestrator audit advisory — N/M] <rule>: <issue>. Fix: <recommendation>"
function extractAdvisoryRule(advisory: string): string | null {
	const m = advisory.match(
		/^\[orchestrator audit advisory — \d+\/\d+\] ([a-z_]+):/,
	);
	return m ? (m[1] ?? null) : null;
}

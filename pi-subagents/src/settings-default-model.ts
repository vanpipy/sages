/**
 * settings-default-model.ts — Read pi's `defaultProvider` + `defaultModel`
 * from settings.json at runtime.
 *
 * GC-2026-014 follow-up: the Agent dispatcher's "model not found" path used
 * to hard-error when the LLM passed an unresolvable model — most commonly
 * provider-specific fuzzy nicknames on a non-matching registry. The new
 * policy is to fall back to the user's configured default. This module is
 * the runtime read of that default.
 *
 * **Project overrides global**, mirroring `enabled-models.ts` (which does
 * the same for `enabledModels`) and `settings.ts` (for `subagents.json`).
 * If project has the field, project wins; otherwise global. If neither has
 * it (or it is malformed/missing), the helper returns `undefined` and the
 * dispatcher silently inherits from the parent session's model — that's the
 * right semantics for "the user has no configured default" and keeps the
 * fallback chain a pure progression (settings > parent > inherit).
 *
 * **Stat-cached invalidation** (mtime + size of BOTH files keyed together)
 * matches the `enabled-models.ts` pattern exactly, so the two read paths
 * share a cache strategy and invalidation behavior. Re-reads are O(1) when
 * neither file has changed.
 *
 * **No hardcoded model strings in production.** The fallback target is
 * always whatever the user has configured — never a built-in constant. The
 * tests use temp files with throwaway provider/model strings to assert
 * that, but the production helper itself never references any specific
 * model id.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Pair returned from {@link getSettingsDefaultModel}. */
export interface SettingsDefaultModel {
	provider: string;
	model: string;
}

/** Paths to pi's settings.json: [project, global] (project wins). */
function settingsPaths(cwd: string): [project: string, global: string] {
	return [
		join(cwd, ".pi", "settings.json"),
		join(getAgentDir(), "settings.json"),
	];
}

/**
 * Read `{ defaultProvider, defaultModel }` from a single settings.json file.
 * Returns `undefined` when either field is missing/empty/malformed — the
 * dispatcher treats both fields as required (a half-configured default is
 * indistinguishable from a missing one for the fallback path).
 */
function readField(path: string): SettingsDefaultModel | undefined {
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// Corrupt file: silent — mirror `enabled-models.ts:readField` and the
		// project's wider "missing file is silent, corrupt file emits a stderr
		// warning" convention used in `settings.ts`. Caller logs if needed.
		return undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const provider = r.defaultProvider;
	const model = r.defaultModel;
	if (typeof provider !== "string" || provider.length === 0) return undefined;
	if (typeof model !== "string" || model.length === 0) return undefined;
	return { provider, model };
}

// Module-level cache — keyed on (cwd, project-file mtime+size, global-file mtime+size).
// `undefined` cached value is legitimate (no configured default); the cache is
// also keyed on `cwd` so concurrent Agent spawns in different projects see the
// right precedence without cross-talk.
let cachedValue: SettingsDefaultModel | undefined;
let cachedHash = "";
let cachedCwd = "";

/** mtime+size hash of one file, or "missing" if absent. */
function hashOf(path: string): string {
	try {
		const s = statSync(path);
		return `${s.mtimeMs}-${s.size}`;
	} catch {
		return "missing";
	}
}

/**
 * Read pi's defaultProvider + defaultModel — project (<cwd>/.pi/settings.json)
 * overrides global (<agentDir>/settings.json), both files joined by mtime+size
 * cache key. Returns `undefined` when neither file has both fields.
 *
 * The caller decides what to do with `undefined`:
 *   - In the dispatcher fallback path: fall through to the parent session's
 *     model — silent fallback, no warning, no toast.
 *   - In other contexts (e.g. bootstrap defaults): pass `undefined` along
 *     so the same code reads whatever's available without inventing a value.
 *
 * `cwd` defaults to `process.cwd()` for parity with the rest of the
 * subagents codebase (`enabled-models.ts`, `settings.ts`). The dispatcher
 * passes its `ctx.cwd` explicitly so it always reads the same workspace
 * the agent is spawning into — important when project and global have
 * differing values.
 */
export function getSettingsDefaultModel(
	cwd: string = process.cwd(),
): SettingsDefaultModel | undefined {
	const [project, global] = settingsPaths(cwd);
	const cwdKey = cwd || "";
	const fileHash = `${hashOf(project)};${hashOf(global)}`;

	// Fast path: identical cache key + cwd → return cached value.
	if (fileHash === cachedHash && cwdKey === cachedCwd) {
		return cachedValue;
	}

	// Cache miss (first call OR either file changed OR cwd changed). Re-read.
	const value = readField(project) ?? readField(global);
	cachedHash = fileHash;
	cachedCwd = cwdKey;
	cachedValue = value;
	return value;
}

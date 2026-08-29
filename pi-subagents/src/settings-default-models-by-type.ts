/**
 * settings-default-models-by-type.ts — Read pi-subagents' `defaultModelsByType`
 * per-type model override map from subagents.json at runtime.
 *
 * GC-2026-092: gives users a project-local + global way to override the
 * hardcoded `AgentConfig.model` pin (e.g. switch `Developer` from
 * `MiniMax/MiniMax-M3` to `anthropic/claude-opus-4`) without forking the
 * package. The override slots into the resolution chain between the
 * `AgentConfig.model` hardcoded default and the global
 * `settings.json#defaultProvider/defaultModel` fallback.
 *
 * **Project overrides global**, mirroring the convention used by
 * `settings-default-model.ts` and `settings.ts:loadSettings()`. If project
 * has the field, project wins; otherwise global. If neither has it (or it
 * is malformed), the helper returns `undefined` and the dispatcher
 * silently falls through to the next layer in the resolution chain.
 *
 * **Stat-cached invalidation** (mtime + size of BOTH files keyed together)
 * matches `settings-default-model.ts` exactly so the two read paths share
 * a cache strategy and invalidation behavior.
 *
 * **No hardcoded model strings in production.** The runtime reads whatever
 * the user has configured. Tests use temp files with throwaway
 * provider/model strings.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Paths to pi's subagents.json: [project, global] (project wins). */
function subagentsPaths(cwd: string): [project: string, global: string] {
	return [
		join(cwd, ".pi", "subagents.json"),
		join(getAgentDir(), "subagents.json"),
	];
}

/**
 * Read the `defaultModelsByType` field from a single subagents.json file.
 * Returns `undefined` when the field is missing/empty/malformed — the
 * caller falls through to the next layer in the resolution chain.
 *
 * Validation: each entry must be a non-empty string (`"provider/model"`).
 * Entries with non-string values, empty strings, or empty keys are dropped
 * silently — matches the sanitize() contract in settings.ts so the
 * persisted-and-read views are consistent.
 */
function readField(path: string): Record<string, string> | undefined {
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// Corrupt file: silent — mirror settings-default-model.ts:readField.
		// Caller logs if needed.
		return undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const field = r.defaultModelsByType;
	if (!field || typeof field !== "object") return undefined;
	const inMap = field as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const [type, value] of Object.entries(inMap)) {
		if (typeof type !== "string" || type.length === 0) continue;
		if (typeof value !== "string" || value.length === 0) continue;
		out[type] = value;
	}
	// Empty after sanitization → no usable entries; treat as absent.
	return Object.keys(out).length > 0 ? out : undefined;
}

// Module-level cache — keyed on (cwd, project-file mtime+size, global-file mtime+size).
let cachedValue: Record<string, string> | undefined;
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
 * Read subagents.json#defaultModelsByType — project (<cwd>/.pi/subagents.json)
 * overrides global (<agentDir>/subagents.json), both files joined by mtime+size
 * cache key. Returns `undefined` when neither file has a usable map.
 *
 * The caller decides what to do with `undefined`:
 *   - In the agent-runner resolution chain: fall through to the next layer
 *     (AgentConfig.model hardcoded default → settings.json#defaultProvider/defaultModel
 *     global fallback → parent session model). Silent fallback, no warning.
 *   - In other contexts: pass `undefined` along so the same code reads
 *     whatever's available without inventing a value.
 *
 * `cwd` defaults to `process.cwd()` for parity with the rest of the
 * subagents codebase. Callers should pass `ctx.cwd` explicitly so they
 * always read the same workspace the agent is spawning into — important
 * when project and global have differing values.
 */
export function getSettingsDefaultModelsByType(
	cwd: string = process.cwd(),
): Record<string, string> | undefined {
	const [project, global] = subagentsPaths(cwd);
	const cwdKey = cwd || "";
	const fileHash = `${hashOf(project)};${hashOf(global)}`;

	// Fast path: identical cache key + cwd → return cached value.
	if (fileHash === cachedHash && cwdKey === cachedCwd) {
		return cachedValue;
	}

	// Cache miss (first call OR either file changed OR cwd changed). Re-read.
	// Merge with project-overrides-global: spread global first, then project,
	// so per-key project values win while global-only keys survive. Mirrors
	// `loadSettings()`'s `{...global, ...project}` spread.
	const projectMap = readField(project);
	const globalMap = readField(global);
	let value: Record<string, string> | undefined;
	if (projectMap && globalMap) {
		value = { ...globalMap, ...projectMap };
	} else {
		value = projectMap ?? globalMap;
	}
	cachedHash = fileHash;
	cachedCwd = cwdKey;
	cachedValue = value;
	return value;
}

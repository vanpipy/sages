/**
 * Hoist mode — re-register wrap implementations under pi's built-in tool names.
 *
 * When `hoist_builtin_tools: true` is in the AFT config (user or project),
 * the wrap layer registers `read`, `write`, `edit`, `grep` as the canonical
 * tools for the model. pi's runtime allows tool name overrides via
 * `pi.registerTool({name: "read", ...})` — the last registration wins.
 *
 * Config source precedence (highest → lowest):
 *   1. `<projectRoot>/.cortexkit/aft.jsonc`
 *   2. `~/.config/cortexkit/aft.jsonc` (or $XDG_CONFIG_HOME/cortexkit/aft.jsonc)
 *   3. Default: false (no hoisting, only `sages_*` names register)
 *
 * JSONC tolerance: strips `// line` and `/* block *\/` comments before parse.
 * Trailing commas are tolerated by attempting a parse, retrying without
 * trailing commas on SyntaxError.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { bridgeFor, ensureReady } from "../aft/index.js";
import { snapshot } from "../aft/safety.js";

export interface HoistConfig {
	hoist_builtin_tools: boolean;
}

const DEFAULT_CONFIG: HoistConfig = { hoist_builtin_tools: false };

/**
 * Tiny jsonc parser — strips comments, retries without trailing commas.
 * Not a full jsonc implementation (no nested trailing-comma handling), but
 * the AFT config we control uses these patterns only.
 */
function parseJsonc(text: string): unknown {
	// Strip // line comments and /* block */ comments (naive — doesn't handle
	// comments inside strings, but AFT config values are simple).
	const stripped = text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");

	try {
		return JSON.parse(stripped);
	} catch (e) {
		// Retry: remove trailing commas before } or ]
		const retry = stripped.replace(/,(\s*[}\]])/g, "$1");
		return JSON.parse(retry);
	}
}

function readConfigFile(path: string): Partial<HoistConfig> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const text = readFileSync(path, "utf-8");
		const parsed = parseJsonc(text) as Record<string, unknown>;
		return {
			hoist_builtin_tools:
				typeof parsed.hoist_builtin_tools === "boolean"
					? parsed.hoist_builtin_tools
					: DEFAULT_CONFIG.hoist_builtin_tools,
		};
	} catch {
		return undefined;
	}
}

function userConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) return join(xdg, "cortexkit", "aft.jsonc");
	const home = process.env.HOME ?? "~";
	return join(home, ".config", "cortexkit", "aft.jsonc");
}

function projectConfigPath(projectRoot: string): string {
	return join(projectRoot, ".cortexkit", "aft.jsonc");
}

let configCache: { projectRoot: string; config: HoistConfig } | undefined;

/**
 * Load hoist config for the given project root. Project overrides user.
 * Result is cached per projectRoot — call `__resetHoistConfigCache()` from
 * tests to force a re-read.
 */
export function loadHoistConfig(projectRoot: string): HoistConfig {
	if (configCache && configCache.projectRoot === projectRoot) {
		return configCache.config;
	}

	const user = readConfigFile(userConfigPath()) ?? {};
	const project = statSync(projectRoot, { throwIfNoEntry: false })?.isDirectory()
		? (readConfigFile(projectConfigPath(projectRoot)) ?? {})
		: {};

	const config: HoistConfig = {
		hoist_builtin_tools:
			project.hoist_builtin_tools ?? user.hoist_builtin_tools ?? false,
	};

	configCache = { projectRoot, config };
	return config;
}

/** Test-only: clear the cached config so the next load re-reads files. */
export function __resetHoistConfigCache(): void {
	configCache = undefined;
}

/**
 * Register the wrap implementations under pi's built-in tool names.
 *
 * No-op when `config.hoist_builtin_tools === false`. When true, registers
 * `read`, `write`, `edit`, `grep` — these OVERRIDE pi's built-ins of the
 * same name. The `sages_*` aliases stay registered (registered by
 * `registerAllWrappers`) for backward compat.
 *
 * Each hoisted tool awaits `ensureReady` so the daemon is configured for
 * the current project_root before the first request.
 */
export function registerHoistedTools(pi: ExtensionAPI, config: HoistConfig): void {
	if (!config.hoist_builtin_tools) return;

	// ── read ────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read file contents with line numbers. AFT-backed (faster than pi's built-in read on large repos). Supports offset/limit for large files.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute or project-relative file path" }),
			offset: Type.Optional(Type.Number({ description: "1-based start line (inclusive)" })),
			limit: Type.Optional(Type.Number({ description: "Max lines to return" })),
		}),
		async execute(_id, params) {
			try {
				await ensureReady(process.cwd());
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `[AFT] not ready: ${(err as Error).message}`,
					}],
					isError: true,
					details: {},
				};
			}
			const bridge = bridgeFor();
			const result = await bridge.read(params.path, {
				offset: params.offset,
				limit: params.limit,
			});
			return {
				content: [{ type: "text", text: result.content }],
				details: {},
			};
		},
	});

	// ── write ───────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "write",
		label: "write",
		description:
			"Write file contents. AFT-backed with per-file backup (can be undone). Atomic write with syntax validation.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to write" }),
			content: Type.String({ description: "New file contents" }),
		}),
		async execute(_id, params) {
			try {
				await ensureReady(process.cwd());
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `[AFT] not ready: ${(err as Error).message}`,
					}],
					isError: true,
					details: {},
				};
			}
			const projectRoot = process.cwd();
			const snap = snapshot(projectRoot, params.path);
			const bridge = bridgeFor();
			const result = await bridge.write(params.path, params.content);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							path: params.path,
							created: result.created,
							syntax_valid: result.syntax_valid,
							snapshot_path: snap.snapshot_path,
							aft_backup_id: result.backup_id,
							undo_hint: `cp ${snap.snapshot_path} ${params.path}`,
						}),
					},
				],
				details: {},
			};
		},
	});

	// ── edit ────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Find/replace edit with progressive fuzzy match. AFT-backed — tolerates whitespace/Unicode drift better than pi's built-in edit.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to edit" }),
			find: Type.String({ description: "Text to find" }),
			replace: Type.String({ description: "Replacement text" }),
		}),
		async execute(_id, params) {
			try {
				await ensureReady(process.cwd());
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `[AFT] not ready: ${(err as Error).message}`,
					}],
					isError: true,
					details: {},
				};
			}
			const projectRoot = process.cwd();
			const snap = snapshot(projectRoot, params.path);
			const bridge = bridgeFor();
			const result = await bridge.edit(params.path, params.find, params.replace);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							path: params.path,
							syntax_valid: result.syntax_valid,
							snapshot_path: snap.snapshot_path,
							aft_backup_id: result.backup_id,
						}),
					},
				],
				details: {},
			};
		},
	});

	// ── grep ────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Trigram-indexed regex search across the project. AFT-backed — faster than ripgrep shell-out on large repos.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex pattern" }),
			path: Type.Optional(Type.String({ description: "Restrict to this path (default: project root)" })),
			max: Type.Optional(Type.Number({ description: "Max matches to return" })),
		}),
		async execute(_id, params) {
			try {
				await ensureReady(process.cwd());
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `[AFT] not ready: ${(err as Error).message}`,
					}],
					isError: true,
					details: {},
				};
			}
			const bridge = bridgeFor();
			const result = await bridge.grep(params.pattern, params.path ?? ".", {
				max: params.max,
			});
			return {
				content: [{ type: "text", text: result.text || "(no matches)" }],
				details: {},
			};
		},
	});
}
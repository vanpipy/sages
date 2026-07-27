/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md, .agents/agents/*.md, and global agents.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import {
	createCodingTools,
	createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
	...new Set(
		[...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name),
	),
];

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/** When true, DEFAULT_AGENTS are skipped during registration. */
let disableDefaults = false;

/** Check whether default agents are disabled. */
export function isDefaultsDisabled(): boolean {
	return disableDefaults;
}

/** Set whether default agents are disabled. */
export function setDefaultsDisabled(b: boolean): void {
	disableDefaults = b;
}

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
	agents.clear();

	// Start with defaults (unless disabled via settings)
	if (!disableDefaults) {
		for (const [name, config] of DEFAULT_AGENTS) {
			agents.set(name, config);
		}
	}

	// Overlay user agents (overrides defaults with same name)
	for (const [name, config] of userAgents) {
		agents.set(name, config);
	}
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
	if (agents.has(name)) return name;
	const lower = name.toLowerCase();
	for (const key of agents.keys()) {
		if (key.toLowerCase() === lower) return key;
	}
	return undefined;
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
	return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
	const key = resolveKey(name);
	return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
	return [...agents.entries()]
		.filter(([_, config]) => config.enabled !== false)
		.map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
	return [...agents.keys()];
}

/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames(): string[] {
	return [...agents.entries()]
		.filter(([_, config]) => config.isDefault === true)
		.map(([name]) => name);
}

/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
	return [...agents.entries()]
		.filter(([_, config]) => config.isDefault !== true)
		.map(([name]) => name);
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
	const key = resolveKey(type);
	if (!key) return false;
	return agents.get(key)?.enabled !== false;
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
	return MEMORY_TOOL_NAMES.filter((n) => !existingToolNames.has(n));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(
	existingToolNames: Set<string>,
): string[] {
	return READONLY_MEMORY_TOOL_NAMES.filter((n) => !existingToolNames.has(n));
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
	const key = resolveKey(type);
	const raw = key ? agents.get(key) : undefined;
	const config = raw?.enabled !== false ? raw : undefined;
	// `undefined` (definition omitted the field) → all built-ins; an explicit `[]`
	// (`tools: none` or a `tools:` with only `ext:` entries) → zero built-ins.
	return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object).
 *
 * Throws on unknown / disabled types — the caller MUST resolve a known
 * agent name before reaching this function (see `resolveAgentType` which
 * surfaces alias / deprecated metadata for the LLM-facing error
 * message). The previous "fall back to general-purpose config" path
 * was removed with the `general-purpose` agent; an explicit
 * `subagent_type` of `general-purpose` (or any other unknown name)
 * now hard-fails so the LLM sees the error instead of silently running
 * with a non-role-specific default. */
export function getConfig(type: string): {
	displayName: string;
	description: string;
	builtinToolNames: string[];
	extensions: true | string[] | false;
	excludeExtensions?: string[];
	skills: true | string[] | false;
	promptMode: "replace" | "append";
} {
	const key = resolveKey(type);
	const config = key ? agents.get(key) : undefined;
	if (config && config.enabled !== false) {
		return {
			displayName: config.displayName ?? config.name,
			description: config.description,
			builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
			extensions: config.extensions,
			excludeExtensions: config.excludeExtensions,
			skills: config.skills,
			promptMode: config.promptMode,
		};
	}
	throw new Error(
		`Unknown or disabled agent type "${type}". ` +
			`Built-in agents: ${[...agents.keys()].filter((k) => agents.get(k)?.enabled !== false).join(", ")}. ` +
			`If "general-purpose" is needed, ask the user to type the \`escape-window\` trigger ` +
			`to unlock the main agent's direct write tools.`,
	);
}

/**
 * Phase A P1 (DAG-2026-011): surface the resolved agent identity with
 * explicit `requested` / `canonical` / `alias` / `deprecated` fields so
 * callers (audit, telemetry, migration tooling) can warn when a legacy
 * alias is used without needing a separate roster entry.
 *
 * Lookup precedence (mirrors `registerAgents`):
 *   1. Direct registry hit (case-insensitive). User-defined agents
 *      shadow the canonical default — a user-registered
 *      `software-developer` is treated as canonical, NOT as the
 *      alias of `developer`.
 *   2. Alias hit (case-insensitive across all `AgentConfig.aliases`).
 *      Only registered alias strings resolve; arbitrary names return
 *      `undefined`.
 *
 * `deprecated: true` is set whenever the lookup went through the alias
 * path — the canonical roster entry is unchanged, but the caller used
 * a legacy name. Direct hits are never deprecated.
 */
export interface ResolvedAgentType {
	/** Name the caller asked for, verbatim (including case). */
	requested: string;
	/** Resolved canonical name (case preserved from the registry key). */
	canonical: string;
	/** True iff resolution went through the `aliases` field of a roster entry. */
	alias: boolean;
	/** True iff the resolution surfaces a legacy / deprecated spelling. */
	deprecated: boolean;
}

/**
 * Resolve an agent type name against the unified registry, returning
 * `{ requested, canonical, alias, deprecated }` or `undefined` when no
 * canonical match AND no alias match exists.
 *
 * Case-insensitive on both the registry keys AND the alias strings.
 * User-defined agents always win over the canonical default (and over
 * the alias) because `registerAgents` overlays user entries on top.
 */
export function resolveAgentType(
	name: string | undefined,
): ResolvedAgentType | undefined {
	if (typeof name !== "string" || name.length === 0) return undefined;

	const requested = name;

	// Step 1 — direct registry hit, case-insensitive. User-registered
	// entries shadow defaults and aliases alike.
	const direct = resolveKey(name);
	if (direct) {
		return {
			requested,
			canonical: direct,
			alias: false,
			deprecated: false,
		};
	}

	// Step 2 — alias hit. Walk every roster entry's `aliases` list,
	// comparing case-insensitively. First match wins.
	const lower = name.toLowerCase();
	for (const [canonical, config] of agents) {
		if (!config.aliases || config.aliases.length === 0) continue;
		for (const alias of config.aliases) {
			if (typeof alias !== "string") continue;
			if (alias.toLowerCase() === lower) {
				return {
					requested,
					canonical,
					alias: true,
					deprecated: true,
				};
			}
		}
	}

	return undefined;
}

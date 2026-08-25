/**
 * Profile applier — translates a Profile into three pi standard hooks.
 *
 * This is the conductor's only behavior. It does NOT register tools,
 * does NOT write state, does NOT install files. It only configures
 * how the LLM interacts with the existing tool surface + system prompt.
 *
 * Three hooks:
 *   1. installCapabilityFilter  — `pi.on("tool_call")` → block tools not in profile.tools
 *   2. installPromptComposer    — `pi.on("before_agent_start")` → prepend profile-driven system prompt
 *   3. installReminderInjector  — `pi.on("tool_call")` → fire soft-mode reminder once on first bash
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { Profile } from "./types.js";

/** Templates are bundled with the sages package — installed by `install.sh` to `~/.pi/agent/sages/templates/prompts/`. */
const TEMPLATES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"templates",
	"prompts",
);

/** Baseline tools always allowed regardless of ` profile.tools (LLM needs read/write/bash to do anything). */
const BASELINE_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

/** Apply a profile to the pi extension API. The conductor's only job. */
export function applyProfile(pi: ExtensionAPI, profile: Profile): void {
	installCapabilityFilter(pi, profile);
	installPromptComposer(pi, profile);
	if (profile.policies?.soft_mode_reminder) {
		installReminderInjector(pi, profile.policies.soft_mode_reminder);
	}
}

/** Hook 1: block tools not in ` profile.tools`. Baseline tools always allowed. */
function installCapabilityFilter(pi: ExtensionAPI, profile: Profile): void {
	const allowSet = new Set<string>();
	for (const [name, cfg] of Object.entries(profile.tools ?? {})) {
		if (cfg.enabled !== false) allowSet.add(name);
	}

	pi.on("tool_call", (event: any) => {
		const toolName: string | undefined = event?.toolName;
		if (typeof toolName !== "string") return undefined;
		if (!allowSet.has(toolName) && !BASELINE_TOOLS.has(toolName)) {
			return {
				block: true,
				reason: `[sages] tool '${toolName}' disabled by profile=${profile.id}`,
			};
		}
		return undefined;
	});
}

/** Hook 2: pick a preset template per profile.prompts.template (or "auto"), render `{{var}}` and `{{#if path}}` blocks. */
function installPromptComposer(pi: ExtensionAPI, profile: Profile): void {
	const templateName = resolveTemplate(profile);

	pi.on("before_agent_start", (event: any) => {
		const basePath = join(TEMPLATES_DIR, `${templateName}.md`);
		if (!existsSync(basePath)) return;
		const base = readFileSync(basePath, "utf-8");
		const rendered = renderTemplate(base, {
			profile,
			loaded: loadedMap(profile),
		});

		const overlays = (profile.prompts?.custom_overlays ?? [])
			.filter((p: string) => existsSync(p))
			.map((p: string) => readFileSync(p, "utf-8"));

		const composed = [rendered, ...overlays].join("\n\n---\n\n");
		event.systemPrompt =
			composed + "\n\n---\n\n" + (event.systemPrompt ?? "");
	});
}

/** Hook 3: fire reminder once on first bash tool_call. No-op if reminder is empty. */
function installReminderInjector(pi: ExtensionAPI, reminder: string): void {
	if (!reminder) return;
	let fired = false;
	pi.on("tool_call", (event: any) => {
		if (fired) return undefined;
		if (event?.toolName !== "bash") return undefined;
		fired = true;
		pi.appendEntry("system", reminder);
		return undefined;
	});
}

/** Resolve preset name. "auto" picks based on `extensions.installed`. */
function resolveTemplate(profile: Profile): string {
	const explicit = profile.prompts?.template;
	if (explicit && explicit !== "auto") return explicit;

	const installed = new Set(profile.extensions.installed);
	const hasAft = installed.has("@cortexkit/aft-pi");
	const hasMc = installed.has("@cortexkit/pi-magic-context");
	if (hasAft && hasMc) return "with-both";
	if (hasAft) return "with-aft";
	if (hasMc) return "with-magic-context";
	return "standard";
}

/** `{{#if loaded.X}}` → set of installed extensions. */
function loadedMap(profile: Profile): Record<string, boolean> {
	const m: Record<string, boolean> = {};
	for (const ext of profile.extensions.installed) m[ext] = true;
	return m;
}

/**
 * Tiny template renderer. Supports:
 *   `{{var}}`           → JSON.stringify(vars.var)
 *   `{{#if path.to.x}}` → keep body if path resolves truthy, else strip
 *
 * NOT a full Handlebars. Intentionally minimal.
 */
function renderTemplate(
	tmpl: string,
	vars: { profile: Profile; loaded: Record<string, boolean> },
): string {
	let out = tmpl;
	for (const [k, v] of Object.entries(vars)) {
		out = out.replaceAll(`{{${k}}}`, JSON.stringify(v));
	}
	out = out.replace(
		/\{\{#if\s+([^\s}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
		(_match, path: string, body: string) => {
			const value = resolvePath(vars, path);
			return value ? body : "";
		},
	);
	return out;
}

function resolvePath(
	vars: Record<string, unknown>,
	path: string,
): unknown {
	// Template paths may include quoted names (e.g. `loaded."@sages/pi-orchestrator"`).
	// Strip surrounding quotes from each segment before lookup.
	const parts = path.split(".").map((p) => {
		const m = p.match(/^["'](.*)["']$/);
		return m ? m[1] : p;
	});
	let cur: unknown = vars;
	for (const part of parts) {
		if (
			cur &&
			typeof cur === "object" &&
			part in (cur as Record<string, unknown>)
		) {
			cur = (cur as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	return cur;
}
/**
 * Profile validator — enforces 4-segment schema + cross-field semantic checks.
 *
 * Uses typebox/value for shape validation (the same TypeBox runtime the
 * orchestrator tools use — see
 * `pi-orchestrator/src/goal-contract.ts`).
 */

import { Value } from "typebox/value";

import { loadToolOwnership, resolvePiRoot } from "./ownership.js";
import { ProfileSchema, type Profile } from "./types.js";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export function validateProfile(input: unknown): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. TypeBox shape check
	if (!Value.Check(ProfileSchema, input)) {
		const paths = [...Value.Errors(ProfileSchema, input)].map(
			(e) => (e as { instancePath?: string }).instancePath || "(root)",
		);
		errors.push(`schema mismatch at ${paths.join(", ")}`);
		return { valid: false, errors, warnings };
	}

	const p = input as Profile;

	// 2. Cross-field semantic warnings (non-blocking)
	if (p.extensions.installed.length === 0) {
		warnings.push("extensions.installed is empty — no extensions will be activated");
	}

	const enabledCount = Object.values(p.tools).filter(
		(t) => t.enabled !== false,
	).length;
	if (enabledCount === 0) {
		warnings.push(
			"tools has 0 enabled entries — all non-baseline tool calls will be blocked",
		);
	}

	// 3. tools ↔ extensions.installed cross-check.
	// For each enabled tool in profile.tools, the owning extension
	// must be in extensions.installed; for each extension in
	// extensions.installed, we warn when none of its tools are
	// enabled (the user might have meant to enable something).
	//
	// This catches two silent-failure modes:
	//   (a) `tools: { foo: enabled: true }` where `foo` belongs to
	//       an extension not declared in extensions.installed →
	//       `installCapabilityFilter` will pass the call (foo is in
	//       allowSet), but pi has no `foo` tool registered → visible
	//       error at call time. The warning moves the error from
	//       runtime to load-time.
	//   (b) `extensions.installed: [X]` where X provides tools but
	//       the profile doesn't enable any → the LLM sees X's tools
	//       in pi's tool list but every call gets silently blocked by
	//       `installCapabilityFilter`. This is the silent failure mode
	//       described in the GC-2026-069 cross-validation TODO.
	const ownership = loadToolOwnership(resolvePiRoot());
	const installed = new Set(p.extensions.installed);

	// (a) enabled tools with no owner in extensions.installed.
	const enabledTools = Object.entries(p.tools)
		.filter(([, cfg]) => cfg.enabled !== false)
		.map(([name]) => name);

	const ownerByTool = new Map<string, string>();
	for (const pkg of installed) {
		const entry = ownership.get(pkg);
		if (!entry) continue;
		for (const tool of entry.tools) ownerByTool.set(tool, pkg);
	}

	const orphanTools: string[] = [];
	for (const tool of enabledTools) {
		if (!ownerByTool.has(tool)) {
			orphanTools.push(tool);
		}
	}
	if (orphanTools.length > 0) {
		warnings.push(
			`tools listed but no installed extension provides them: ${orphanTools.join(", ")} (add the owning extension to extensions.installed or remove from tools)`,
		);
	}

	// (b) installed extensions with no enabled tool in this profile.
	const usedPackages = new Set<string>();
	for (const tool of enabledTools) {
		const pkg = ownerByTool.get(tool);
		if (pkg) usedPackages.add(pkg);
	}
	const unused: string[] = [];
	for (const pkg of p.extensions.installed) {
		if (!usedPackages.has(pkg)) unused.push(pkg);
	}
	if (unused.length > 0) {
		warnings.push(
			`extensions installed but no tools from them are enabled: ${unused.join(", ")} (the LLM will see those tools in pi's tool list but every call gets blocked by installCapabilityFilter)`,
		);
	}

	return { valid: errors.length === 0, errors, warnings };
}
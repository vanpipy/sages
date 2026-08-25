/**
 * Profile validator — enforces 4-segment schema + cross-field semantic checks.
 *
 * Uses typebox/value for shape validation (the same TypeBox runtime the
 * orchestrator tools use — see `pi/src/tools/orchestrator/goal-contract.ts`).
 */

import { Value } from "typebox/value";

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

	return { valid: errors.length === 0, errors, warnings };
}
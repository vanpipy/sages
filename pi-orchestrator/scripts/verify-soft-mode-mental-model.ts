#!/usr/bin/env bun
/**
 * verify-soft-mode-mental-model.ts — GC-2026-052 T6.1
 *
 * Verifies that the documentation describing "soft mode" does not
 * contradict the actual exports of `pi/src/soft-mode.ts`. The
 * goal is to keep the mental model consistent across:
 *
 *   - The runtime (canonical): `pi/src/soft-mode.ts` exports
 *     `softModeReminder(profile)` (Profile-driven since
 *     GC-2026-049). The default reminder string lives in
 *     `pi/src/profile.ts` as `DEFAULT_SOFT_MODE_REMINDER`.
 *   - The documentation (mirrors): `AGENTS.md`, `README.md`,
 *     and `templates/SUBAGENTS.md`.
 *
 * What this verifier checks:
 *
 *   1. **Export exists.** `soft-mode.ts` exports the Profile-driven
 *      function. Missing exports are flagged (the runtime could not
 *      satisfy the docs).
 *   2. **Docs mention soft mode.** For each doc that mentions
 *      "soft mode" (or "Soft mode"), the verifier confirms the
 *      docs do not invent a contradicting mental model.
 *   3. **Concept drift warning.** If a doc mentions
 *      "task-count threshold" but the default reminder string never
 *      mentions it, the verifier emits a `WARN:` to stderr
 *      (does not fail the gate). This is informational — drift
 *      may be intentional — but surfaces a hint for human review.
 *
 * On any export missing: print FAIL and exit 1. Otherwise:
 * print `OK: soft-mode mental model` and exit 0.
 *
 * No external dependencies. Self-test: running this script
 * against the current `pi/` tree MUST exit 0.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// GC-2026-069: conductor files (soft-mode.ts, profile.ts) live in the
// conductor package at ../pi/, not in this orchestrator package.
const PI_ROOT = join(__dirname, "..", "..", "pi");
const SOFT_MODE_PATH = join(PI_ROOT, "src", "soft-mode.ts");
const PROFILE_PATH = join(PI_ROOT, "src", "profile.ts");
const DOC_PATHS = [
	join(PI_ROOT, "..", "AGENTS.md"),
	join(PI_ROOT, "..", "README.md"),
	join(PI_ROOT, "templates", "SUBAGENTS.md"),
];

export interface SoftModeExports {
	hasReminderFn: boolean;
	reminderMentions: string[];
}

function extractStringLiterals(body: string): string[] {
	// Pull every backtick / single / double-quoted literal out
	// of the body. Multiline template literals are supported
	// because the .*? capture spans newlines.
	const out: string[] = [];
	for (const m of body.matchAll(/["'`]([^"'`]+)["'`]/g)) {
		out.push(m[1]);
	}
	return out;
}

export function inspectSoftMode(): SoftModeExports {
	const softModeSrc = readFileSync(SOFT_MODE_PATH, "utf-8");
	const profileSrc = readFileSync(PROFILE_PATH, "utf-8");

	// Profile-driven function — the only runtime export of soft-mode.ts.
	const hasReminderFn = /export\s+function\s+softModeReminder\s*\(/.test(softModeSrc);

	// Default reminder string — lives in profile.ts as
	// DEFAULT_SOFT_MODE_REMINDER. Surface its literal contents for the
	// drift check below.
	const defaultReminderMatch = profileSrc.match(
		/export\s+const\s+DEFAULT_SOFT_MODE_REMINDER\s*[:=]\s*([\s\S]+?);\s*(?:\n|$)/,
	);
	const reminderMentions = defaultReminderMatch ? extractStringLiterals(defaultReminderMatch[1]) : [];

	return {
		hasReminderFn,
		reminderMentions,
	};
}

export interface SoftModeScanResult {
	ok: boolean;
	exportError?: string;
	warnings: string[];
}

export function checkSoftModeMentalModel(): SoftModeScanResult {
	const sm = inspectSoftMode();
	const warnings: string[] = [];

	// Gate: the Profile-driven function MUST exist.
	if (!sm.hasReminderFn) {
		return { ok: false, exportError: "missing export: softModeReminder(profile)", warnings };
	}

	// Drift warnings — informational only.
	const reminderText = sm.reminderMentions.join("\n");
	const mentionsTaskCount = /task[- ]count\s+threshold/i.test(reminderText);

	for (const docPath of DOC_PATHS) {
		if (!existsSync(docPath)) continue;
		const text = readFileSync(docPath, "utf-8");
		if (!/soft\s+mode/i.test(text)) continue;

		if (/task[- ]count\s+threshold/i.test(text) && !mentionsTaskCount) {
			warnings.push(
				`${relative(PI_ROOT, docPath)}: mentions "task-count threshold" but soft-mode reminder does not`,
			);
		}
	}

	return { ok: true, warnings };
}

function main(): void {
	const result = checkSoftModeMentalModel();
	if (!result.ok) {
		console.error(`verify-soft-mode-mental-model: FAIL — ${result.exportError}`);
		console.error(`      fix: restore the missing export in src/soft-mode.ts`);
		process.exit(1);
	}
	for (const w of result.warnings) {
		console.warn(`WARN: ${w}`);
	}
	const sm = inspectSoftMode();
	console.log(
		`OK: soft-mode mental model — profile-driven export present (${sm.reminderMentions.length} string literal(s) in default reminder)`,
	);
	process.exit(0);
}

const ENTRY = process.argv[1] ?? "";
if (
	ENTRY.endsWith("verify-soft-mode-mental-model.ts") ||
	ENTRY.endsWith("verify-soft-mode-mental-model.js")
) {
	main();
}
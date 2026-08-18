#!/usr/bin/env bun
/**
 * verify-soft-mode-mental-model.ts — GC-2026-052 T6.1
 *
 * Verifies that the documentation describing "soft mode" does not
 * contradict the actual exports of `pi/src/soft-mode.ts`. The
 * goal is to keep the mental model consistent across:
 *
 *   - The runtime (canonical): `pi/src/soft-mode.ts` exports
 *     `softModeReminder(profile)` and `softModeSystemPromptSuffix(profile)`
 *     (Profile-driven since GC-2026-049). Backward-compat shims
 *     `SOFT_MODE_REMINDER` and `SOFT_MODE_SYSTEM_PROMPT_SUFFIX`
 *     are also exported as deprecated constants.
 *   - The documentation (mirrors): `AGENTS.md`, `README.md`,
 *     and `templates/SUBAGENTS.md`.
 *
 * What this verifier checks:
 *
 *   1. **Exports exist.** `soft-mode.ts` exports both the
 *      Profile-driven functions AND the backward-compat shims.
 *      Missing exports are flagged (the runtime could not
 *      satisfy the docs).
 *   2. **Docs mention soft mode.** For each doc that mentions
 *      "soft mode" (or "Soft mode"), the verifier confirms the
 *      docs do not invent a contradicting mental model.
 *   3. **Concept drift warning.** If a doc mentions
 *      "task-count threshold" but the reminder/suffix strings
 *      never mention it, the verifier emits a `WARN:` to stderr
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
const PI_ROOT = join(__dirname, "..");

const SOFT_MODE_PATH = join(PI_ROOT, "src", "soft-mode.ts");
const DOC_PATHS = [
	join(PI_ROOT, "..", "AGENTS.md"),
	join(PI_ROOT, "..", "README.md"),
	join(PI_ROOT, "templates", "SUBAGENTS.md"),
];

export interface SoftModeExports {
	hasReminderFn: boolean;
	hasSuffixFn: boolean;
	hasReminderShim: boolean;
	hasSuffixShim: boolean;
	reminderMentions: string[];
	suffixMentions: string[];
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
	const src = readFileSync(SOFT_MODE_PATH, "utf-8");

	// Profile-driven functions
	const hasReminderFn = /export\s+function\s+softModeReminder\s*\(/.test(src);
	const hasSuffixFn = /export\s+function\s+softModeSystemPromptSuffix\s*\(/.test(src);

	// Backward-compat shims (deprecated since GC-2026-049)
	const reminderShimMatch = src.match(
		/export\s+const\s+SOFT_MODE_REMINDER\s*[:=]\s*([\s\S]+?);\s*(?:\n|$)/,
	);
	const suffixShimMatch = src.match(
		/export\s+const\s+SOFT_MODE_SYSTEM_PROMPT_SUFFIX\s*[:=]\s*([\s\S]+?);\s*(?:\n|$)/,
	);
	const hasReminderShim = reminderShimMatch !== null;
	const hasSuffixShim = suffixShimMatch !== null;

	const reminderMentions = reminderShimMatch ? extractStringLiterals(reminderShimMatch[1]) : [];
	const suffixMentions = suffixShimMatch ? extractStringLiterals(suffixShimMatch[1]) : [];

	return {
		hasReminderFn,
		hasSuffixFn,
		hasReminderShim,
		hasSuffixShim,
		reminderMentions,
		suffixMentions,
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

	// Gate: both Profile-driven functions AND both shims MUST exist.
	// The shims are still required by the legacy test contract.
	if (!sm.hasReminderFn) {
		return { ok: false, exportError: "missing export: softModeReminder(profile)", warnings };
	}
	if (!sm.hasSuffixFn) {
		return { ok: false, exportError: "missing export: softModeSystemPromptSuffix(profile)", warnings };
	}
	if (!sm.hasReminderShim) {
		return {
			ok: false,
			exportError: "missing deprecated shim: SOFT_MODE_REMINDER (required by legacy tests)",
			warnings,
		};
	}
	if (!sm.hasSuffixShim) {
		return {
			ok: false,
			exportError: "missing deprecated shim: SOFT_MODE_SYSTEM_PROMPT_SUFFIX (required by legacy tests)",
			warnings,
		};
	}

	// Drift warnings — informational only.
	const reminderText = sm.reminderMentions.join("\n");
	const suffixText = sm.suffixMentions.join("\n");
	const allShimText = `${reminderText}\n${suffixText}`;
	const mentionsTaskCount = /task[- ]count\s+threshold/i.test(allShimText);

	for (const docPath of DOC_PATHS) {
		if (!existsSync(docPath)) continue;
		const text = readFileSync(docPath, "utf-8");
		if (!/soft\s+mode/i.test(text)) continue;

		if (/task[- ]count\s+threshold/i.test(text) && !mentionsTaskCount) {
			warnings.push(
				`${relative(PI_ROOT, docPath)}: mentions "task-count threshold" but soft-mode.ts shims do not`,
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
		`OK: soft-mode mental model — profile-driven exports present, shims present (${sm.reminderMentions.length + sm.suffixMentions.length} string literal(s) in shims)`,
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
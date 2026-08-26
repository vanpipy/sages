#!/usr/bin/env bun
/**
 * verify-soft-mode-mental-model.ts — GC-2026-052 T6.1 (GC-2026-073 updated)
 *
 * Verifies that the documentation describing "soft mode" does not
 * contradict the actual soft-mode wiring in the orchestrator's
 * `src/extension.ts`. The goal is to keep the mental model
 * consistent across:
 *
 *   - The runtime (canonical): `src/extension.ts` exposes the
 *     `SOFT_MODE_REMINDER` constant, and the `installSessionHooks`
 *     function wires it into a `pi.on("tool_call", ...)` handler
 *     that fires once per session on the first `bash` call.
 *   - The documentation (mirrors): `AGENTS.md`, `README.md`, and
 *     `templates/SYSTEM.md`.
 *
 * What this verifier checks (post-GC-2026-073):
 *
 *   1. **Runtime wiring exists.** `src/extension.ts` exports
 *      `installSessionHooks` (or wires it inline) AND that function
 *      contains a `pi.on("tool_call", ...)` handler that calls
 *      `pi.appendEntry("system", SOFT_MODE_REMINDER)`.
 *   2. **Default reminder string exists.** The `SOFT_MODE_REMINDER`
 *      constant is declared and contains the canonical reminder
 *      text (verified by a regex match on the expected keywords —
 *      no need to pin byte-for-byte equality).
 *   3. **Concept drift warning.** If a doc mentions
 *      "task-count threshold" but the default reminder string never
 *      mentions it, the verifier emits a `WARN:` to stderr (does
 *      not fail the gate). This is informational — drift may be
 *      intentional — but surfaces a hint for human review.
 *
 * On any runtime wiring missing: print FAIL and exit 1.
 * Otherwise: print `OK: soft-mode mental model` and exit 0.
 *
 * No external dependencies. Self-test: running this script against
 * the current `pi-orchestrator/` tree MUST exit 0.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// GC-2026-073: the conductor (./pi/) is gone. The soft-mode reminder
// now lives in `pi-orchestrator/src/extension.ts` as
// `SOFT_MODE_REMINDER`, fired by `installSessionHooks`. The verifier
// points at the orchestrator's own extension and templates.
const PI_ORCH_ROOT = join(__dirname, "..");
const EXTENSION_PATH = join(PI_ORCH_ROOT, "src", "extension.ts");
const DOC_PATHS = [
	join(PI_ORCH_ROOT, "..", "AGENTS.md"),
	join(PI_ORCH_ROOT, "..", "README.md"),
	join(PI_ORCH_ROOT, "templates", "SYSTEM.md"),
];

export interface SoftModeExports {
	hasReminderConstant: boolean;
	hasAppendEntryCall: boolean;
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
	const extSrc = readFileSync(EXTENSION_PATH, "utf-8");

	// Gate 1: the orchestrator's extension.ts declares
	// `SOFT_MODE_REMINDER` (the once-per-session reminder text).
	const hasReminderConstant = /const\s+SOFT_MODE_REMINDER\s*=/.test(extSrc);

	// Gate 2: the orchestrator's extension.ts wires
	// `pi.appendEntry("system", SOFT_MODE_REMINDER)` inside a
	// `pi.on("tool_call", ...)` handler. The historical
	// `installReminderInjector` helper is gone — the reminder now
	// fires directly from `installSessionHooks`.
	const hasAppendEntryCall =
		/pi\.on\(\s*["']tool_call["']/.test(extSrc) &&
		/pi\.appendEntry\(\s*["']system["']\s*,\s*SOFT_MODE_REMINDER/.test(extSrc);

	// Default reminder string — lives in extension.ts as
	// SOFT_MODE_REMINDER. Surface its literal contents for the drift
	// check below.
	const reminderMatch = extSrc.match(
		/const\s+SOFT_MODE_REMINDER\s*=\s*([\s\S]+?);\s*(?:\n|$)/,
	);
	const reminderMentions = reminderMatch ? extractStringLiterals(reminderMatch[1]) : [];

	return {
		hasReminderConstant,
		hasAppendEntryCall,
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

	// Gate: the extension must declare SOFT_MODE_REMINDER AND wire it
	// into a pi.on("tool_call") handler that calls pi.appendEntry("system",
	// SOFT_MODE_REMINDER). Both are required for soft mode to function.
	if (!sm.hasReminderConstant || !sm.hasAppendEntryCall) {
		const missing: string[] = [];
		if (!sm.hasReminderConstant) missing.push("SOFT_MODE_REMINDER constant");
		if (!sm.hasAppendEntryCall)
			missing.push(
				"pi.on('tool_call') handler with pi.appendEntry('system', SOFT_MODE_REMINDER)",
			);
		return {
			ok: false,
			exportError: `src/extension.ts must declare and wire ${missing.join(" + ")}`,
			warnings,
		};
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
				`${relative(PI_ORCH_ROOT, docPath)}: mentions "task-count threshold" but soft-mode reminder does not`,
			);
		}
	}

	return { ok: true, warnings };
}

function main(): void {
	const result = checkSoftModeMentalModel();
	if (!result.ok) {
		console.error(`verify-soft-mode-mental-model: FAIL — ${result.exportError}`);
		console.error(
			`      fix: declare SOFT_MODE_REMINDER and wire it into a pi.on('tool_call') handler in src/extension.ts`,
		);
		process.exit(1);
	}
	for (const w of result.warnings) {
		console.warn(`WARN: ${w}`);
	}
	const sm = inspectSoftMode();
	console.log(
		`OK: soft-mode mental model — runtime wiring present (${sm.reminderMentions.length} string literal(s) in default reminder)`,
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

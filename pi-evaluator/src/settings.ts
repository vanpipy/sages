/**
 * pi-evaluator/src/settings.ts
 *
 * Reads `sages.rewardMode` from `~/.pi/agent/settings.json`.
 *
 * Two exports:
 *   - `readSagesRewardModeAt(path)`: pure helper, takes an explicit path.
 *     Easier to test (no env manipulation) and used by debug tooling.
 *   - `readSagesRewardMode()`: env-driven wrapper used by extension.ts.
 *     Reads `$HOME/.pi/agent/settings.json`.
 *
 * Both functions swallow ALL read / parse errors and return false. Rationale:
 * reward mode is opt-in; we never want to crash the session because the
 * user's settings.json is malformed.
 *
 * Strict `=== true` check: any non-boolean truthy value (string "true",
 * number 1, etc.) returns false. This is intentional — we want explicit
 * opt-in, not accidental JSON-truthy matches.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_RELATIVE_PATH = join(".pi", "agent", "settings.json");

/**
 * Read `sages.rewardMode` from the settings.json at the given absolute path.
 *
 * @param settingsPath Absolute path to a settings.json file.
 * @returns true if `sages.rewardMode === true`; false otherwise (including all errors).
 */
export function readSagesRewardModeAt(settingsPath: string): boolean {
	try {
		if (!existsSync(settingsPath)) return false;
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw) as { sages?: { rewardMode?: unknown } } | null;
		return parsed?.sages?.rewardMode === true;
	} catch {
		return false;
	}
}

/**
 * Resolve the home directory in a test-overridable way.
 *
 * We prefer `process.env.HOME` because Bun's `os.homedir()` on Linux reads the
 * passwd database (not `$HOME`) and ignores in-process overrides, which makes
 * unit-testing the wrapper impossible. Falling back to `os.homedir()` covers
 * platforms / shells that don't export `HOME`.
 */
function resolveHomeDir(): string {
	const fromEnv = process.env.HOME;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return homedir();
}

/**
 * Read `sages.rewardMode` from `$HOME/.pi/agent/settings.json`.
 *
 * @returns true iff the setting is explicitly `true`; false otherwise.
 */
export function readSagesRewardMode(): boolean {
	return readSagesRewardModeAt(join(resolveHomeDir(), SETTINGS_RELATIVE_PATH));
}

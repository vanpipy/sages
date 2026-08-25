/**
 * Profile loader — resolves the active profile from 3 candidate locations.
 *
 * Resolution order:
 *   1. `~/.pi/profile.yaml` — user-level override
 *   2. `<pkg>/profiles/standard.yaml` — built-in default (module-relative)
 *   3. `STANDARD_PROFILE` constant — in-code fallback when YAML files are missing
 *
 * The result is cached; `clearProfileCache()` (test-only) clears it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

import { STANDARD_PROFILE, type Profile } from "./types.js";
import { validateProfile } from "./validator.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILTIN_PROFILE_DIR = join(PACKAGE_ROOT, "profiles");

let cached: Profile | undefined;

export function loadProfile(): Profile {
	if (cached) return cached;

	const userPath = join(homedir(), ".pi", "profile.yaml");
	if (existsSync(userPath)) {
		cached = readAndValidate(userPath, "user");
		return cached;
	}

	const builtinPath = join(BUILTIN_PROFILE_DIR, "standard.yaml");
	if (existsSync(builtinPath)) {
		cached = readAndValidate(builtinPath, "built-in");
		return cached;
	}

	return STANDARD_PROFILE;
}

function readAndValidate(path: string, source: string): Profile {
	const raw = readFileSync(path, "utf-8");
	const parsed = yaml.load(raw) as Profile;
	const result = validateProfile(parsed);
	if (!result.valid) {
		throw new Error(
			`[sages] profile at ${path} (${source}) is invalid:\n` +
				result.errors.map((e) => `  - ${e}`).join("\n"),
		);
	}
	return parsed;
}

/** Test-only. Production code should treat the cache as immutable. */
export function clearProfileCache(): void {
	cached = undefined;
}
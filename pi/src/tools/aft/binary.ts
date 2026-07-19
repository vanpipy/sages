/**
 * AFT binary location — single resolver. The rest of the codebase never sees
 * the path; if we ever change binary resolution strategy, only this file moves.
 *
 * Lookup order (per design Decision 5):
 *   1. $AFT_BINARY env var (escape hatch for tests / unusual installs)
 *   2. npm-bundled (@cortexkit/aft-<platform>/bin/aft in ~/.pi/agent/npm/node_modules)
 *   3. `which aft` (PATH lookup)
 *   4. ~/.cargo/bin/aft (cargo-installed dev build — for AFT contributors)
 *   5. Throw with remediation message matching SKILL.md troubleshooting table
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export class AftBinaryNotFoundError extends Error {
	constructor(missing: string) {
		super(
			`[AFT] Cannot locate AFT binary.\n` +
				`Searched: $AFT_BINARY, ~/.pi/agent/npm/node_modules/@cortexkit/aft-*/bin/aft, which aft, ~/.cargo/bin/aft.\n` +
				`None found.\n` +
				`Fix: install AFT for Pi via \`npx @cortexkit/aft@latest setup --harness pi\`, or set $AFT_BINARY.\n` +
				`Original: ${missing}`,
		);
		this.name = "AftBinaryNotFoundError";
	}
}

const NPM_BIN_DIRS = [
	"~/.pi/agent/npm/node_modules/@cortexkit/aft-linux-x64/bin/aft",
	"~/.pi/agent/npm/node_modules/@cortexkit/aft-linux-arm64/bin/aft",
	"~/.pi/agent/npm/node_modules/@cortexkit/aft-darwin-x64/bin/aft",
	"~/.pi/agent/npm/node_modules/@cortexkit/aft-darwin-arm64/bin/aft",
	"~/.pi/agent/npm/node_modules/@cortexkit/aft-win32-x64/bin/aft",
	"~/.pi/agent/npm/node_modules/@cortexkit/aft-win32-arm64/bin/aft",
];

function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return process.env.HOME ? `${process.env.HOME}${p.slice(1)}` : p;
	}
	return p;
}

function tryEnv(): string | undefined {
	const env = process.env.AFT_BINARY;
	if (env && existsSync(env)) return env;
	return undefined;
}

function tryNpmBundled(): string | undefined {
	for (const p of NPM_BIN_DIRS) {
		const full = expandHome(p);
		if (existsSync(full)) return full;
	}
	return undefined;
}

function tryPath(): string | undefined {
	try {
		// `which aft` — non-throwing wrapper around PATH lookup
		const result = execFileSync("which", ["aft"], { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		if (result && existsSync(result)) return result;
	} catch {
		// which exits non-zero if not found
	}
	return undefined;
}

function tryCargo(): string | undefined {
	const full = `${process.env.HOME ?? "~"}/.cargo/bin/aft`;
	if (existsSync(full)) return full;
	return undefined;
}

/**
 * Returns the resolved AFT binary path. Throws if not found.
 *
 * Memoized for the lifetime of the process — repeated lookups are cheap.
 */
let cachedPath: string | undefined;
export function resolveAftBinary(): string {
	if (cachedPath) return cachedPath;
	const path = tryEnv() ?? tryNpmBundled() ?? tryPath() ?? tryCargo();
	if (!path) {
		throw new AftBinaryNotFoundError(
			process.env.AFT_BINARY ?? "no AFT_BINARY, no npm bundle, not on PATH, no cargo install",
		);
	}
	cachedPath = path;
	return path;
}

/** Test-only: clear the memoization. */
export function __resetAftBinaryCache(): void {
	cachedPath = undefined;
}

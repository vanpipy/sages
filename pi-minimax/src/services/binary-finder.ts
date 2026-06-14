/**
 * binary-finder.ts — Locate the `mmx` binary on the user's system.
 *
 * Layered lookup (first match wins):
 *   1. MMX_BIN env var          (explicit override for CI / testing)
 *   2. <npm prefix -g>/bin/mmx  (canonical "did `npm i -g mmx-cli`" path)
 *   3. which mmx                (PATH fallback for brew / custom installs)
 *
 * Each candidate is verified by running `<path> --version`; failure falls through
 * to the next source. Result is cached at module level (verify-once-and-cache).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MmxSource = "env" | "npm-global" | "path" | "not-found";

export interface MmxLocation {
    found: boolean;
    path: string;
    source: MmxSource;
    version?: string;
}

export interface FindMmxOptions {
    /** Override execText (for tests). Defaults to node:child_process.execFile. */
    execText?: (cmd: string, args: string[]) => Promise<string>;
}

/** Module-level cache; cleared via clearMmxCache() in tests. */
let cached: MmxLocation | null = null;

export function clearMmxCache(): void {
    cached = null;
}

async function defaultExecText(cmd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(cmd, args);
    return stdout.trim();
}

/**
 * Find mmx on the system. Returns a cached result if available.
 *
 * Order: MMX_BIN env → npm-global → PATH. Each candidate verified by `--version`.
 */
export async function findMmx(opts: FindMmxOptions = {}): Promise<MmxLocation> {
    if (cached) return cached;

    const execText = opts.execText ?? defaultExecText;

    // 1. MMX_BIN env override
    const envBin = process.env.MMX_BIN;
    if (envBin) {
        const version = await tryVersion(execText, envBin);
        if (version !== null) {
            return (cached = { found: true, path: envBin, source: "env", version });
        }
    }

    // 2. npm-global install (canonical "I ran `npm i -g mmx-cli`")
    try {
        const prefix = await execText("npm", ["prefix", "-g"]);
        const candidate = `${prefix.trim()}/bin/mmx`;
        const version = await tryVersion(execText, candidate);
        if (version !== null) {
            return (cached = { found: true, path: candidate, source: "npm-global", version });
        }
    } catch {
        // npm prefix -g failed (no npm, no node, etc.) — fall through
    }

    // 3. PATH fallback (which mmx)
    try {
        const whichResult = await execText("which", ["mmx"]);
        const candidate = whichResult.trim();
        if (candidate) {
            const version = await tryVersion(execText, candidate);
            if (version !== null) {
                return (cached = { found: true, path: candidate, source: "path", version });
            }
        }
    } catch {
        // which not available, or no mmx on PATH
    }

    return (cached = { found: false, path: "", source: "not-found" });
}

/**
 * Run `<bin> --version`. Returns the version string on success, null on failure.
 */
async function tryVersion(
    execText: (cmd: string, args: string[]) => Promise<string>,
    bin: string,
): Promise<string | null> {
    try {
        const raw = await execText(bin, ["--version"]);
        // Real mmx output is `mmx 1.0.15\n`; trim defensively so callers
        // see a clean string regardless of trailing whitespace.
        return raw.trim();
    } catch {
        return null;
    }
}

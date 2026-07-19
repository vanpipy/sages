/**
 * region-fix.ts — Detect mmx-cli's region=cn base_url double-prefix bug.
 *
 * ## The bug
 *
 * mmx-cli 1.0.15/1.0.16 has a resolver bug for `region=cn`: it derives
 * `base_url = https://api.minimaxi.com/anthropic/v1` from config, but the
 * endpoint handlers prepend another `/v1/<endpoint>` segment on top. The
 * resulting request URL is `https://api.minimaxi.com/anthropic/v1/v1/...`
 * which returns HTTP 404 from the API gateway.
 *
 * Affects ALL mmx commands hitting the API (search, text chat, image, ...).
 *
 * ## The workaround
 *
 * Pass `--base-url https://api.minimaxi.com` (NO `/anthropic/v1` suffix)
 * explicitly. mmx-cli then constructs `https://api.minimaxi.com/v1/...`
 * which is the correct, reachable URL.
 *
 * Verified by hand (mmx 1.0.15, region=cn):
 *   mmx search query --q test --verbose
 *     → POST .../anthropic/v1/v1/coding_plan/search   ← 404
 *   mmx search query --q test --base-url https://api.minimaxi.com --verbose
 *     → POST .../v1/coding_plan/search                ← 200
 *
 * ## This service
 *
 * `detectRegionFix()` reads `~/.mmx/config.json` once, decides whether the
 * bug applies (region === "cn"), and returns the corrected base URL. The
 * result is cached at module level — config changes require either a
 * `clearRegionFixCache()` call or process restart.
 *
 * Production callers (search.ts, auth.ts, auth-bootstrap.ts) call
 * `detectRegionFix()` once at the start of each tool invocation, then pass
 * the result through `ExecMmxArgs.regionFix`. execMmx then transparently
 * appends `--base-url` to the mmx subprocess argv.
 *
 * ## Fail-open semantics
 *
 * If the config file is missing, malformed, or unreadable, the service
 * returns `{needsBaseUrlOverride: false}` — i.e., we do NOT inject the
 * workaround. This is safer than guessing: a missed fix surfaces as the
 * same 404 the user already sees, but a wrong fix (e.g., injecting on
 * `region=global`) would silently break otherwise-working commands.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shape of the bits we care about from `~/.mmx/config.json`. */
export interface MmxConfigSnapshot {
    region?: string;
    baseUrl?: string;
    api_key?: string;
    [key: string]: unknown;
}

/** Async reader of the mmx config snapshot. Returns null if file missing. */
export type RegionFixReader = () => Promise<MmxConfigSnapshot | null>;

/**
 * Result of region-fix detection. `correctedBaseUrl` is always populated
 * (so callers can use it as a fallback / debug aid), but
 * `needsBaseUrlOverride` controls whether execMmx actually injects the flag.
 */
export interface RegionFixState {
    needsBaseUrlOverride: boolean;
    correctedBaseUrl: string;
}

/**
 * The corrected base URL for region=cn. Strips the buggy `/anthropic/v1`
 * suffix that mmx-cli's resolver adds on top of the actual API root.
 */
export const CORRECTED_CN_BASE_URL = "https://api.minimaxi.com";

/** Default config path: `~/.mmx/config.json`. */
const DEFAULT_CONFIG_PATH = join(homedir(), ".mmx", "config.json");

/** Module-level cache; cleared via clearRegionFixCache() in tests. */
let cachedState: RegionFixState | null = null;

export function clearRegionFixCache(): void {
    cachedState = null;
}

/** Default reader: reads + parses `~/.mmx/config.json`. */
export async function readMmxConfig(): Promise<MmxConfigSnapshot | null> {
    try {
        const raw = await readFile(DEFAULT_CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as MmxConfigSnapshot;
        }
        return null;
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        // ENOENT (file missing) is a normal first-run state — return null.
        // Other errors (EACCES, JSON parse) also return null; caller treats
        // null as "no fix needed" (fail-open).
        if (err.code === "ENOENT") return null;
        return null;
    }
}

export interface DetectRegionFixOptions {
    /** Override the config reader (for tests). Default: readMmxConfig(). */
    reader?: RegionFixReader;
}

/**
 * Detect whether the mmx-cli region=cn base_url bug applies, and return the
 * corrected base URL if so. Cached at module level after first call.
 *
 * Logic:
 *   - reader returns null/error         → no override (fail-open)
 *   - reader returns { region: "cn" }   → override needed, use CORRECTED_CN_BASE_URL
 *   - reader returns anything else      → no override (other regions are fine)
 *
 * Case-sensitive on `region`: mmx-cli's resolver uses lowercase strings
 * ("cn", "global"); we mirror that to avoid false positives on "CN" etc.
 */
export async function detectRegionFix(opts: DetectRegionFixOptions = {}): Promise<RegionFixState> {
    if (cachedState) return cachedState;

    const reader = opts.reader ?? readMmxConfig;
    let snapshot: MmxConfigSnapshot | null = null;
    try {
        snapshot = await reader();
    } catch {
        // Fail-open: any reader exception (IO, JSON parse) → no override
        cachedState = { needsBaseUrlOverride: false, correctedBaseUrl: CORRECTED_CN_BASE_URL };
        return cachedState;
    }

    if (!snapshot) {
        cachedState = { needsBaseUrlOverride: false, correctedBaseUrl: CORRECTED_CN_BASE_URL };
        return cachedState;
    }

    const needsOverride = snapshot.region === "cn";
    cachedState = {
        needsBaseUrlOverride: needsOverride,
        correctedBaseUrl: CORRECTED_CN_BASE_URL,
    };
    return cachedState;
}
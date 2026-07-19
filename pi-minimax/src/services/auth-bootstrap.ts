/**
 * auth-bootstrap.ts — Auto-authenticate mmx from MINIMAX_API_KEY env when needed.
 *
 * ensureAuth() is called by every pi tool before invoking mmx. It:
 *   1. Checks cache; returns immediately if previously OK'd, throws if cached fail
 *   2. Runs `mmx auth status --output json` to determine current state
 *   3. If authed: caches "ok" and returns (NEVER overwrites existing session)
 *   4. If unauthed + MINIMAX_API_KEY env: runs `mmx auth login --api-key $KEY`
 *      (emits onUpdate notice so the user sees the bootstrap)
 *   5. If unauthed + no env: caches "skipped-no-env", throws NotAuthedError
 *
 * The cache is module-level; clearAuthState() resets it (for tests).
 */

import { execMmx, type ExecMmxArgs, type ExecMmxResult } from "./exec.js";
import { detectRegionFix } from "./region-fix.js";
import { parseAuthStatus, InvalidAuthStatusError } from "./auth-status.js";

/**
 * Hardcoded 5-minute TTL for the auth "ok" cache.
 *
 * Rationale: mmx-cli's OAuth tokens expire in ~1 hour, but we re-check every
 * 5 minutes to detect session expiry mid-pi-session (avoids stale "ok" state
 * when the OAuth token has silently expired). API-key sessions never expire,
 * but we re-check anyway for consistency and to catch mmx-cli config changes.
 */
export const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

export class NotAuthedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NotAuthedError";
    }
}

export class BootstrapFailedError extends Error {
    constructor(message: string, readonly cause?: unknown) {
        super(message);
        this.name = "BootstrapFailedError";
    }
}

type UpdateContent = { type: string; text: string };
type UpdateFn = (msg: { content: UpdateContent[] }) => void | Promise<void>;

export interface EnsureAuthOptions {
    onUpdate?: UpdateFn;
    /** Override execMmx (for tests). Accepts a partial ExecMmxArgs. */
    execMmx?: (
        args: Pick<ExecMmxArgs, "command"> & Partial<Pick<ExecMmxArgs, "args" | "apiKey" | "regionFix">>,
    ) => Promise<ExecMmxResult>;
}

type AuthState =
    | { kind: "ok"; expiresAt: number }
    | { kind: "skipped-no-env" }
    | { kind: "failed" };

let cachedState: AuthState | null = null;

/** Reset the cached bootstrap state. For tests. */
export function clearAuthState(): void {
    cachedState = null;
}



async function runExec(
    execFn: NonNullable<EnsureAuthOptions["execMmx"]>,
    args: Parameters<NonNullable<EnsureAuthOptions["execMmx"]>>[0],
): Promise<ExecMmxResult> {
    return execFn(args);
}

/**
 * Ensure mmx is authenticated, auto-bootstrapping from MINIMAX_API_KEY env if possible.
 */
export async function ensureAuth(opts: EnsureAuthOptions = {}): Promise<void> {
    const execFn = opts.execMmx ?? execMmx;

    // Cache hit → fast path
    if (cachedState?.kind === "ok" && Date.now() < cachedState.expiresAt) {
        return;
    }
    if (cachedState?.kind === "skipped-no-env") {
        throw new NotAuthedError("Run: mmx auth login, or export MINIMAX_API_KEY");
    }
    if (cachedState?.kind === "failed") {
        throw new BootstrapFailedError("Previous auth bootstrap attempt failed");
    }

    // Step 1: check current auth status
    let statusResult: ExecMmxResult;
    try {
        // Region fix is cached at module level — safe to call per-invocation.
        // We pass it through so that mmx auth status, auth login, and any
        // future bootstrap steps all hit the corrected endpoint under region=cn.
        const regionFix = await detectRegionFix();
        statusResult = await runExec(execFn, { command: "auth status", regionFix });
    } catch (e) {
        cachedState = { kind: "failed" };
        throw new BootstrapFailedError("Failed to run `mmx auth status`", e);
    }

    let status;
    try {
        status = parseAuthStatus(statusResult.stdout);
    } catch (e) {
        if (e instanceof InvalidAuthStatusError) {
            cachedState = { kind: "failed" };
            throw new BootstrapFailedError("Failed to parse auth status JSON", e);
        }
        throw e;
    }

    // Step 2: if already authed, cache with TTL and return
    if (status.authenticated === true || (status as { method?: string }).method) {
        cachedState = { kind: "ok", expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
        return;
    }

    // Step 3: unauthed — try env bootstrap
    const envKey = process.env.MINIMAX_API_KEY;
    if (!envKey) {
        cachedState = { kind: "skipped-no-env" };
        throw new NotAuthedError(
            "mmx is not authenticated and MINIMAX_API_KEY env is not set. " +
                "Run: mmx auth login, or export MINIMAX_API_KEY.",
        );
    }

    // Step 4: bootstrap from env
    await opts.onUpdate?.({
        content: [
            {
                type: "text",
                text: "Auto-bootstrapping mmx auth from MINIMAX_API_KEY env...",
            },
        ],
    });

    let loginResult: ExecMmxResult;
    try {
        const regionFix = await detectRegionFix();
        loginResult = await runExec(execFn, { command: "auth login", apiKey: envKey, regionFix });
    } catch (e) {
        cachedState = { kind: "failed" };
        throw new BootstrapFailedError("Failed to run `mmx auth login`", e);
    }

    if (loginResult.exitCode !== 0) {
        cachedState = { kind: "failed" };
        throw new BootstrapFailedError(
            `mmx auth login exited with code ${loginResult.exitCode}: ${loginResult.stderr || loginResult.stdout}`,
        );
    }

    cachedState = { kind: "ok", expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
}

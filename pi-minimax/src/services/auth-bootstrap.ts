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
import { parseAuthStatus, InvalidAuthStatusError } from "./auth-status.js";

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
    execMmx?: (args: Pick<ExecMmxArgs, "command"> & Partial<Pick<ExecMmxArgs, "args" | "apiKey">>) => Promise<ExecMmxResult>;
}

type AuthState = "ok" | "skipped-no-env" | "failed";

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
    if (cachedState === "ok") return;
    if (cachedState === "skipped-no-env") {
        throw new NotAuthedError("Run: mmx auth login, or export MINIMAX_API_KEY");
    }
    if (cachedState === "failed") {
        throw new BootstrapFailedError("Previous auth bootstrap attempt failed");
    }

    // Step 1: check current auth status
    let statusResult: ExecMmxResult;
    try {
        statusResult = await runExec(execFn, { command: "auth status" });
    } catch (e) {
        cachedState = "failed";
        throw new BootstrapFailedError("Failed to run `mmx auth status`", e);
    }

    let status;
    try {
        status = parseAuthStatus(statusResult.stdout);
    } catch (e) {
        if (e instanceof InvalidAuthStatusError) {
            cachedState = "failed";
            throw new BootstrapFailedError("Failed to parse auth status JSON", e);
        }
        throw e;
    }

    // Step 2: if already authed, cache and return
    if (status.authenticated === true || (status as { method?: string }).method) {
        cachedState = "ok";
        return;
    }

    // Step 3: unauthed — try env bootstrap
    const envKey = process.env.MINIMAX_API_KEY;
    if (!envKey) {
        cachedState = "skipped-no-env";
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
        loginResult = await runExec(execFn, { command: "auth login", apiKey: envKey });
    } catch (e) {
        cachedState = "failed";
        throw new BootstrapFailedError("Failed to run `mmx auth login`", e);
    }

    if (loginResult.exitCode !== 0) {
        cachedState = "failed";
        throw new BootstrapFailedError(
            `mmx auth login exited with code ${loginResult.exitCode}: ${loginResult.stderr || loginResult.stdout}`,
        );
    }

    cachedState = "ok";
}

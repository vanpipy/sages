/**
 * auth.ts — L0 tool: minimax_auth_status.
 *
 * Thin wrapper around `mmx auth status --output json`. Auto-bootstraps auth
 * from MINIMAX_API_KEY env when needed (via ensureAuth).
 *
 * The business logic is exposed as runAuthStatusTool(deps) so it can be
 * tested in isolation; the registerTool() call wraps it for pi.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureAuth, NotAuthedError, type EnsureAuthOptions } from "../services/auth-bootstrap.js";
import { execMmx, type ExecMmxResult } from "../services/exec.js";
import { parseAuthStatus } from "../services/auth-status.js";

type UpdateFn = NonNullable<EnsureAuthOptions["onUpdate"]>;

export type AuthToolResult =
    | {
          success: true;
          authenticated?: true;
          method: "api-key" | "oauth";
          source: string;
          key?: string;
          token_expires?: string;
          account?: string;
      }
    | {
          success: false;
          error: {
              code: "NOT_AUTHED" | "MMX_NOT_FOUND" | "AUTH_STATUS_PARSE_ERROR" | "TIMEOUT" | "UNKNOWN";
              message: string;
          };
      };

export interface AuthToolDeps {
    ensureAuth?: (opts?: EnsureAuthOptions) => Promise<void>;
    execMmx?: (args: Parameters<typeof execMmx>[0]) => Promise<ExecMmxResult>;
    onUpdate?: UpdateFn;
}

/**
 * Pure business logic for the auth_status tool. Testable without pi.
 */
export async function runAuthStatusTool(deps: AuthToolDeps = {}): Promise<AuthToolResult> {
    const ensure = deps.ensureAuth ?? ensureAuth;
    const run = deps.execMmx ?? execMmx;

    try {
        await ensure({ onUpdate: deps.onUpdate });
    } catch (e) {
        if (e instanceof NotAuthedError) {
            return fail("NOT_AUTHED", e.message);
        }
        return fail("UNKNOWN", (e as Error).message);
    }

    let result: ExecMmxResult;
    try {
        result = await run({ command: "auth status" });
    } catch (e) {
        const msg = (e as Error).message;
        if (/ENOENT|no such file|not found/i.test(msg)) {
            return fail("MMX_NOT_FOUND", "mmx binary not found on PATH. Run: npm install -g mmx-cli");
        }
        return fail("UNKNOWN", msg);
    }

    if (result.timedOut) {
        return fail("TIMEOUT", "mmx auth status timed out (60s)");
    }

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
        return fail("UNKNOWN", `mmx auth status exited ${result.exitCode}: ${result.stderr || result.stdout}`);
    }

    try {
        const status = parseAuthStatus(result.stdout);
        if (status.authenticated === false) {
            // Bootstrap didn't fire (e.g., execMmx is mocked and returned unauthed); report as unauthed
            return fail("NOT_AUTHED", status.message || "Not authenticated");
        }
        return {
            success: true,
            authenticated: true,
            method: status.method,
            source: status.source,
            key: status.key,
            token_expires: status.token_expires,
            account: status.account,
        };
    } catch (e) {
        return fail("AUTH_STATUS_PARSE_ERROR", (e as Error).message);
    }
}

function fail(code: "NOT_AUTHED" | "MMX_NOT_FOUND" | "AUTH_STATUS_PARSE_ERROR" | "TIMEOUT" | "UNKNOWN", message: string): AuthToolResult {
    return { success: false, error: { code, message } };
}

/**
 * Register the minimax_auth_status tool with pi.
 */
export function registerAuthTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "minimax_auth_status",
        label: "mmx Auth Status",
        description:
            "Check mmx authentication state. Returns {success, method, source, ...} or " +
            "{success: false, error: {code: NOT_AUTHED | MMX_NOT_FOUND, message}}. " +
            "Auto-bootstraps from MINIMAX_API_KEY env if needed.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, onUpdate, _ctx) {
            const result = await runAuthStatusTool({
                ensureAuth,
                execMmx,
                onUpdate: onUpdate as UpdateFn | undefined,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    });
}

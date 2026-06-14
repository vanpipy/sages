/**
 * test/_helpers/mockExec.ts — Shared test utilities for mocking execMmx.
 *
 * mockExec(scripted) creates a fake execMmx that returns scripted results in
 * order, mirroring execMmx's JSON-parse behavior so `result.parsed` is set
 * for valid JSON stdout. Tracks all calls for assertions.
 */

import type { ExecMmxResult, FlatValue } from "../../src/services/exec.js";
import type { EnsureAuthOptions } from "../../src/services/auth-bootstrap.js";

export type MockExecFn = NonNullable<EnsureAuthOptions["execMmx"]>;
export interface MockExecCall {
    command: string;
    args?: Record<string, FlatValue>;
    apiKey?: string;
}

export interface MockExecHandle {
    fn: MockExecFn;
    calls: MockExecCall[];
}

export function mockExec(scripted: ExecMmxResult[]): MockExecHandle {
    const calls: MockExecCall[] = [];
    const queue = [...scripted];
    const fn: MockExecFn = async (a) => {
        calls.push({
            command: a.command,
            args: a.args as Record<string, FlatValue> | undefined,
            apiKey: a.apiKey,
        });
        const next = queue.shift();
        if (!next) throw new Error(`Unscripted execMmx call: ${JSON.stringify(a)}`);
        // Mirror execMmx's JSON parse behavior so tests see `parsed`
        let parsed: unknown;
        const trimmed = next.stdout.trim();
        if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                /* not JSON */
            }
        }
        return { ...next, parsed };
    };
    return { fn, calls };
}

/** Common fixture: a successful auth status response (api-key method). */
export const AUTHED_APIKEY_RESPONSE = (): ExecMmxResult => ({
    stdout: JSON.stringify({
        authenticated: true,
        method: "api-key",
        source: "config.json",
        key: "sk-xxxx…",
    }),
    stderr: "",
    exitCode: 0,
});

/** Common fixture: an unauthenticated auth status response. */
export const UNAUTHED_RESPONSE = (): ExecMmxResult => ({
    stdout: JSON.stringify({
        authenticated: false,
        message: "Not authenticated.",
        hint: "Run: mmx auth login\nOr set $MINIMAX_API_KEY",
    }),
    stderr: "",
    exitCode: 0,
});

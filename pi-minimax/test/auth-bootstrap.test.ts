/**
 * RED phase: tests for auth-bootstrap service.
 *
 * Scenarios (from draft S8-S10):
 *   S8: when authed → ensureAuth() returns immediately, never calls login
 *       (even if MINIMAX_API_KEY env is set; protects OAuth sessions)
 *   S9: when unauthed + env set → calls mmx auth login --api-key $KEY
 *   S10: when unauthed + no env → throws NotAuthedError with hint
 *
 * Plus: caching within session, clearAuthState() resets, onUpdate notification.
 */

import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { ensureAuth, clearAuthState, NotAuthedError } from "../src/services/auth-bootstrap.js";
import type { ExecMmxResult } from "../src/services/exec.js";

type ExecMmxCall = { command: string; args?: Record<string, unknown>; apiKey?: string };
type ExecMmxFn = (args: ExecMmxCall) => Promise<ExecMmxResult>;

function mockExecMmx(scripted: Array<ExecMmxCall & { result: ExecMmxResult }>): {
    fn: ExecMmxFn;
    calls: ExecMmxCall[];
} {
    const calls: ExecMmxCall[] = [];
    const queue = [...scripted];
    const fn: ExecMmxFn = async (args) => {
        calls.push({ command: args.command, args: args.args, apiKey: args.apiKey });
        const next = queue.shift();
        if (!next) {
            throw new Error(`Unscripted call: ${JSON.stringify(args)}`);
        }
        return next.result;
    };
    return { fn, calls };
}

describe("auth-bootstrap", () => {
    beforeEach(() => {
        delete process.env.MINIMAX_API_KEY;
        clearAuthState();
    });

    it("S8: returns immediately when authed (no login, even with env set)", async () => {
        process.env.MINIMAX_API_KEY = "sk-ignored";
        const { fn, calls } = mockExecMmx([
            {
                command: "auth status",
                result: {
                    stdout: JSON.stringify({ authenticated: true, method: "api-key", source: "config.json", key: "sk-yyyy…" }),
                    stderr: "",
                    exitCode: 0,
                },
            },
        ]);
        await ensureAuth({ execMmx: fn });
        // Only the auth-status call; no login call
        expect(calls).toHaveLength(1);
        expect(calls[0]!.command).toBe("auth status");
    });

    it("S9: auto-logs in from MINIMAX_API_KEY env when unauthed", async () => {
        process.env.MINIMAX_API_KEY = "sk-from-env";
        const updates: string[] = [];
        const { fn, calls } = mockExecMmx([
            {
                command: "auth status",
                result: {
                    stdout: JSON.stringify({ authenticated: false, message: "Not authenticated.", hint: "Run mmx auth login" }),
                    stderr: "",
                    exitCode: 0,
                },
            },
            {
                command: "auth login",
                args: { "api-key": "sk-from-env" },
                apiKey: "sk-from-env",
                result: { stdout: '{"ok":true}', stderr: "", exitCode: 0 },
            },
        ]);
        await ensureAuth({
            execMmx: fn,
            onUpdate: (msg) => {
                updates.push(msg.content.map((c) => c.text).join(""));
            },
        });
        expect(calls).toHaveLength(2);
        expect(calls[0]!.command).toBe("auth status");
        expect(calls[1]!.command).toBe("auth login");
        expect(calls[1]!.apiKey).toBe("sk-from-env");
        // onUpdate notice emitted
        expect(updates.some((u) => u.includes("Auto-bootstrapping"))).toBe(true);
    });

    it("S10: throws NotAuthedError when unauthed and no env", async () => {
        const { fn, calls } = mockExecMmx([
            {
                command: "auth status",
                result: {
                    stdout: JSON.stringify({ authenticated: false, message: "Not authenticated.", hint: "x" }),
                    stderr: "",
                    exitCode: 0,
                },
            },
        ]);
        await expect(ensureAuth({ execMmx: fn })).rejects.toThrow(NotAuthedError);
        // Only the auth-status call; no login attempt
        expect(calls).toHaveLength(1);
    });

    it("caches 'ok' state — second call does not re-check auth status", async () => {
        const { fn, calls } = mockExecMmx([
            {
                command: "auth status",
                result: {
                    stdout: JSON.stringify({ authenticated: true, method: "oauth", source: "config.json" }),
                    stderr: "",
                    exitCode: 0,
                },
            },
        ]);
        await ensureAuth({ execMmx: fn });
        await ensureAuth({ execMmx: fn });
        await ensureAuth({ execMmx: fn });
        expect(calls).toHaveLength(1); // Only first call hit exec
    });

    it("caches 'skipped-no-env' state — second call throws NotAuthedError without re-checking", async () => {
        const { fn, calls } = mockExecMmx([
            {
                command: "auth status",
                result: {
                    stdout: JSON.stringify({ authenticated: false, message: "x", hint: "y" }),
                    stderr: "",
                    exitCode: 0,
                },
            },
        ]);
        await expect(ensureAuth({ execMmx: fn })).rejects.toThrow(NotAuthedError);
        const callsAfterFirst = calls.length;
        await expect(ensureAuth({ execMmx: fn })).rejects.toThrow(NotAuthedError);
        expect(calls).toHaveLength(callsAfterFirst); // No new calls
    });

    it("clearAuthState() forces re-check on next ensureAuth()", async () => {
        const { fn, calls } = mockExecMmx([
            {
                command: "auth status",
                result: {
                    stdout: JSON.stringify({ authenticated: true, method: "api-key", source: "config.json" }),
                    stderr: "",
                    exitCode: 0,
                },
            },
            {
                command: "auth status",
                result: {
                    stdout: JSON.stringify({ authenticated: true, method: "api-key", source: "config.json" }),
                    stderr: "",
                    exitCode: 0,
                },
            },
        ]);
        await ensureAuth({ execMmx: fn });
        clearAuthState();
        await ensureAuth({ execMmx: fn });
        expect(calls).toHaveLength(2);
    });

    describe("TTL (AUTH_CACHE_TTL_MS = 5min)", () => {
        afterEach(() => {
            setSystemTime(); // reset to real time
        });

        it("re-checks auth status after TTL elapses", async () => {
            const baseTime = new Date("2026-06-14T12:00:00Z").getTime();
            setSystemTime(new Date(baseTime));

            const { fn, calls } = mockExecMmx([
                {
                    command: "auth status",
                    result: {
                        stdout: JSON.stringify({ authenticated: true, method: "api-key", source: "config.json" }),
                        stderr: "",
                        exitCode: 0,
                    },
                },
                {
                    command: "auth status",
                    result: {
                        stdout: JSON.stringify({ authenticated: true, method: "api-key", source: "config.json" }),
                        stderr: "",
                        exitCode: 0,
                    },
                },
            ]);

            await ensureAuth({ execMmx: fn });
            expect(calls).toHaveLength(1);

            // 4 minutes later — within TTL (5min), no re-check
            setSystemTime(new Date(baseTime + 4 * 60 * 1000));
            await ensureAuth({ execMmx: fn });
            expect(calls).toHaveLength(1);

            // 6 minutes later — past TTL, re-check
            setSystemTime(new Date(baseTime + 6 * 60 * 1000));
            await ensureAuth({ execMmx: fn });
            expect(calls).toHaveLength(2);
        });

        it("ok cache is shared across subsequent calls within TTL", async () => {
            const baseTime = new Date("2026-06-14T12:00:00Z").getTime();
            setSystemTime(new Date(baseTime));

            const { fn, calls } = mockExecMmx([
                {
                    command: "auth status",
                    result: {
                        stdout: JSON.stringify({ authenticated: true, method: "oauth", source: "config.json" }),
                        stderr: "",
                    exitCode: 0,
                    },
                },
            ]);

            await ensureAuth({ execMmx: fn });
            setSystemTime(new Date(baseTime + 60 * 1000)); // 1 min
            await ensureAuth({ execMmx: fn });
            setSystemTime(new Date(baseTime + 4 * 60 * 1000 + 59 * 1000)); // 4m59s
            await ensureAuth({ execMmx: fn });
            expect(calls).toHaveLength(1); // All within TTL
        });
    });
});

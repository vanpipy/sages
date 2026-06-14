/**
 * RED phase: tests for minimax_search_query tool (L2).
 *
 * Scenarios (from draft S12, S14):
 *   S12: runs `mmx search query --q <query>` and returns parsed {query, results}
 *   S14: returns structured error on failure
 */

import { describe, it, expect } from "bun:test";
import { runSearchQuery } from "../src/tools/search.js";
import type { ExecMmxResult, FlatValue } from "../src/services/exec.js";
import { NotAuthedError, type EnsureAuthOptions } from "../src/services/auth-bootstrap.js";

type ExecFn = EnsureAuthOptions["execMmx"];

function mockExec(scripted: ExecMmxResult[]): { fn: ExecFn; calls: Array<{ command: string; args?: Record<string, FlatValue>; apiKey?: string }> } {
    const calls: Array<{ command: string; args?: Record<string, FlatValue>; apiKey?: string }> = [];
    const queue = [...scripted];
    const fn: ExecFn = async (a) => {
        calls.push({ command: a.command, args: a.args as Record<string, FlatValue> | undefined, apiKey: a.apiKey });
        const next = queue.shift();
        if (!next) throw new Error("Unscripted");
        let parsed: unknown;
        const trimmed = next.stdout.trim();
        if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
            try { parsed = JSON.parse(trimmed); } catch { /* not JSON */ }
        }
        return { ...next, parsed };
    };
    return { fn, calls };
}

describe("minimax_search_query tool", () => {
    it("S12: runs mmx search query --q and returns parsed results", async () => {
        const { fn, calls } = mockExec([
            {
                stdout: JSON.stringify({
                    organic: [
                        { title: "MiniMax AI", link: "https://minimax.io", snippet: "AI platform", date: "2026-01-01" },
                    ],
                }),
                stderr: "",
                exitCode: 0,
            },
        ]);
        const result = await runSearchQuery({
            input: { query: "MiniMax AI" },
            ensureAuth: async () => {},
            execMmx: fn,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.query).toBe("MiniMax AI");
            expect(result.results).toHaveLength(1);
            expect(result.results[0]!.title).toBe("MiniMax AI");
        }
        // Verify command and --q flag passed correctly
        expect(calls[0]!.command).toBe("search query");
        expect(calls[0]!.args).toEqual({ q: "MiniMax AI" });
    });

    it("passes apiKey override", async () => {
        const { fn, calls } = mockExec([
            { stdout: '{"organic":[]}', stderr: "", exitCode: 0 },
        ]);
        await runSearchQuery({
            input: { query: "x", apiKey: "sk-test" },
            ensureAuth: async () => {},
            execMmx: fn,
        });
        expect(calls[0]!.apiKey).toBe("sk-test");
    });

    it("calls ensureAuth before execMmx", async () => {
        let ensureCalledBeforeExec = false;
        let execCalled = false;
        const ensureAuth = async () => {
            ensureCalledBeforeExec = !execCalled;
        };
        const execMmx: ExecFn = async () => {
            execCalled = true;
            return { stdout: '{"organic":[]}', stderr: "", exitCode: 0 };
        };
        await runSearchQuery({ input: { query: "x" }, ensureAuth, execMmx });
        expect(ensureCalledBeforeExec).toBe(true);
    });

    it("S14a: returns NOT_AUTHED when ensureAuth throws", async () => {
        const { fn } = mockExec([]);
        const result = await runSearchQuery({
            input: { query: "x" },
            ensureAuth: async () => { throw new NotAuthedError("nope"); },
            execMmx: fn,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("NOT_AUTHED");
        }
    });

    it("S14b: returns MMX_NOT_FOUND when execMmx fails to spawn", async () => {
        const result = await runSearchQuery({
            input: { query: "x" },
            ensureAuth: async () => {},
            execMmx: async () => { throw new Error("spawn mmx ENOENT"); },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("MMX_NOT_FOUND");
        }
    });

    it("returns empty results when mmx returns empty organic array", async () => {
        const { fn } = mockExec([
            { stdout: '{"organic":[]}', stderr: "", exitCode: 0 },
        ]);
        const result = await runSearchQuery({
            input: { query: "no-such-thing-xyz" },
            ensureAuth: async () => {},
            execMmx: fn,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.results).toEqual([]);
        }
    });

    it("returns TIMEOUT error when execMmx returns timedOut: true", async () => {
        const result = await runSearchQuery({
            input: { query: "x" },
            ensureAuth: async () => {},
            execMmx: async () => ({ stdout: "", stderr: "killed", exitCode: 124, timedOut: true }),
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("TIMEOUT");
            expect(result.error.message).toMatch(/timed out/);
        }
    });
});

/**
 * RED phase: tests for minimax_exec tool (L1 escape hatch).
 *
 * Scenarios (from draft S13, S14):
 *   S13: runs `mmx <command> [args]` and returns structured result
 *   S14: returns MMX_NOT_FOUND when execMmx fails fatally
 */

import { describe, it, expect } from "bun:test";
import { runExecTool } from "../src/tools/exec.js";
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
        // Mirror execMmx's JSON parse behavior so tests see `parsed`
        let parsed: unknown;
        const trimmed = next.stdout.trim();
        if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
            try { parsed = JSON.parse(trimmed); } catch { /* not JSON */ }
        }
        return { ...next, parsed };
    };
    return { fn, calls };
}

describe("minimax_exec tool", () => {
    it("S13: runs mmx command and returns parsed result", async () => {
        const { fn, calls } = mockExec([
            { stdout: '{"model_remains":[]}', stderr: "", exitCode: 0 },
        ]);
        const result = await runExecTool({
            input: { command: "quota show" },
            ensureAuth: async () => {},
            execMmx: fn,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.exitCode).toBe(0);
            expect(result.parsed).toEqual({ model_remains: [] });
        }
        expect(calls).toHaveLength(1);
        expect(calls[0]!.command).toBe("quota show");
    });

    it("passes args and apiKey through to execMmx", async () => {
        const { fn, calls } = mockExec([
            { stdout: "{}", stderr: "", exitCode: 0 },
        ]);
        await runExecTool({
            input: { command: "text chat", args: { message: "Hi" }, apiKey: "sk-test" },
            ensureAuth: async () => {},
            execMmx: fn,
        });
        expect(calls[0]!.args).toEqual({ message: "Hi" });
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
            return { stdout: "{}", stderr: "", exitCode: 0 };
        };
        await runExecTool({ input: { command: "quota show" }, ensureAuth, execMmx });
        expect(ensureCalledBeforeExec).toBe(true);
    });

    it("S14a: returns NOT_AUTHED when ensureAuth throws", async () => {
        const { fn } = mockExec([]);
        const result = await runExecTool({
            input: { command: "quota show" },
            ensureAuth: async () => {
                throw new NotAuthedError("nope");
            },
            execMmx: fn,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("NOT_AUTHED");
        }
    });

    it("S14b: returns MMX_NOT_FOUND when execMmx fails to spawn", async () => {
        const result = await runExecTool({
            input: { command: "quota show" },
            ensureAuth: async () => {},
            execMmx: async () => {
                throw new Error("spawn mmx ENOENT");
            },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("MMX_NOT_FOUND");
        }
    });
});

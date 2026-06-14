/**
 * RED phase: failing tests for exec service.
 *
 * Scenarios (from draft S6, S7):
 *   S6: command + args builds correct mmx invocation with auto agent flags
 *   S7: apiKey override adds --api-key
 * Edge cases:
 *   - boolean true → --flag; boolean false → omit
 *   - string[] → repeated --key v1 --key v2
 *   - raw=true skips auto agent flags
 *   - JSON stdout → result.parsed populated
 *   - non-JSON stdout → result.parsed undefined
 *   - non-zero exitCode propagated
 */

import { describe, it, expect } from "bun:test";
import { execMmx, type ExecFileFn } from "../src/services/exec.js";

interface CapturedCall {
    cmd: string;
    args: string[];
}

function mockExecFile(stdout = '{"ok":true}'): { fn: ExecFileFn; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const fn: ExecFileFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout, stderr: "", exitCode: 0 };
    };
    return { fn, calls };
}

describe("exec", () => {
    it("S6: command + args builds correct mmx invocation with auto agent flags", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx({ command: "text chat", args: { message: "Hi", stream: true } }, { execFile: fn });
        expect(calls).toHaveLength(1);
        const c = calls[0]!;
        expect(c.cmd).toBe("mmx");
        // command parts
        expect(c.args).toContain("text");
        expect(c.args).toContain("chat");
        // user args
        expect(c.args).toContain("--message");
        expect(c.args).toContain("Hi");
        expect(c.args).toContain("--stream");
        // auto agent flags (injected at end)
        expect(c.args).toContain("--output");
        expect(c.args).toContain("json");
        expect(c.args).toContain("--quiet");
        expect(c.args).toContain("--non-interactive");
    });

    it("S7: apiKey override adds --api-key", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx({ command: "quota show", apiKey: "sk-test" }, { execFile: fn });
        const args = calls[0]!.args;
        expect(args).toContain("--api-key");
        expect(args).toContain("sk-test");
    });

    it("boolean true → flag, boolean false → omit", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            { command: "video generate", args: { prompt: "X", download: true, async: false } },
            { execFile: fn },
        );
        const args = calls[0]!.args;
        expect(args).toContain("--download");
        expect(args).not.toContain("--async");
    });

    it("string[] values become repeated flags", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            { command: "text chat", args: { message: ["a", "b", "c"] } },
            { execFile: fn },
        );
        const args = calls[0]!.args;
        const msgIdxs = args.map((a, i) => (a === "--message" ? i : -1)).filter((i) => i >= 0);
        expect(msgIdxs).toHaveLength(3);
        expect(args[msgIdxs[0]! + 1]).toBe("a");
        expect(args[msgIdxs[1]! + 1]).toBe("b");
        expect(args[msgIdxs[2]! + 1]).toBe("c");
    });

    it("raw=true skips auto agent flags", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx({ command: "video download", raw: true }, { execFile: fn });
        const args = calls[0]!.args;
        expect(args).not.toContain("--quiet");
        expect(args).not.toContain("--non-interactive");
        expect(args).not.toContain("--output");
    });

    it("parses JSON stdout into result.parsed", async () => {
        const fn: ExecFileFn = async () => ({ stdout: '{"foo":1}', stderr: "", exitCode: 0 });
        const result = await execMmx({ command: "quota show" }, { execFile: fn });
        expect(result.parsed).toEqual({ foo: 1 });
    });

    it("non-JSON stdout leaves parsed undefined", async () => {
        const fn: ExecFileFn = async () => ({ stdout: "hello.mp3\n", stderr: "", exitCode: 0 });
        const result = await execMmx({ command: "speech synthesize" }, { execFile: fn });
        expect(result.parsed).toBeUndefined();
        expect(result.stdout).toBe("hello.mp3\n");
    });

    it("propagates non-zero exitCode", async () => {
        const fn: ExecFileFn = async () => ({ stdout: "", stderr: "not authed", exitCode: 3 });
        const result = await execMmx({ command: "quota show" }, { execFile: fn });
        expect(result.exitCode).toBe(3);
    });

    it("sets timedOut: true when execFile throws ERR_CHILD_PROCESS_TIMEOUT", async () => {
        const fn: ExecFileFn = async () => {
            const e = new Error("Command failed") as Error & { code: string; killed: boolean; signal: string };
            e.code = "ERR_CHILD_PROCESS_TIMEOUT";
            e.killed = true;
            e.signal = "SIGTERM";
            throw e;
        };
        const result = await execMmx({ command: "video generate", args: { prompt: "x" } }, { execFile: fn });
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(124);
    });

    it("sets timedOut: true when execFile throws with killed+SIGTERM but no ERR_CHILD_PROCESS_TIMEOUT code", async () => {
        const fn: ExecFileFn = async () => {
            const e = new Error("killed") as Error & { killed: boolean; signal: string };
            e.killed = true;
            e.signal = "SIGTERM";
            throw e;
        };
        const result = await execMmx({ command: "video generate", args: { prompt: "x" } }, { execFile: fn });
        expect(result.timedOut).toBe(true);
    });

    it("does NOT set timedOut for non-timeout errors (mimicking defaultExecFile catch)", async () => {
        // Mimic what defaultExecFile returns after catching an ENOENT:
        // {stdout:'', stderr:'spawn mmx ENOENT', exitCode:1, timedOut:undefined}
        const fn: ExecFileFn = async () => ({ stdout: "", stderr: "spawn mmx ENOENT", exitCode: 1 });
        const result = await execMmx({ command: "quota show" }, { execFile: fn });
        expect(result.timedOut).toBeUndefined();
        expect(result.exitCode).toBe(1);
    });
});

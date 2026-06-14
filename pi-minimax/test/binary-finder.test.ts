/**
 * RED phase: failing tests for binary-finder
 *
 * Scenarios covered (from .sages/workspace/draft.md S1-S5 + edge cases):
 *   S1: MMX_BIN env takes priority over npm-global and PATH
 *   S2: npm-global path is found via `npm prefix -g` + /bin/mmx
 *   S3: PATH fallback when env and npm-global fail
 *   S4: not-found returns empty result
 *   S5: verify-once-and-cache within a session
 *   Edge: MMX_BIN path invalid → falls through to next source
 *   Edge: npm-global candidate invalid → falls through to PATH
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { findMmx, clearMmxCache } from "../src/services/binary-finder.js";

const NPM_GLOBAL_DIR = "/usr/local";
const MMX_PATH = `${NPM_GLOBAL_DIR}/bin/mmx`;
const ENV_PATH = "/opt/custom/mmx";
const USER_MMX_PATH = "/home/user/.local/bin/mmx";

type MockScenario = {
    match: (cmd: string, args: string[]) => boolean;
    stdout: string;
    shouldThrow?: boolean;
    code?: number;
};

function mockExecText(scenarios: MockScenario[]): (cmd: string, args: string[]) => Promise<string> {
    return async (cmd, args) => {
        const s = scenarios.find((sc) => sc.match(cmd, args));
        if (!s) throw new Error(`No mock for: ${cmd} ${JSON.stringify(args)}`);
        if (s.shouldThrow) {
            const e = new Error("mock failure") as Error & { code?: number };
            e.code = s.code ?? 1;
            throw e;
        }
        return s.stdout;
    };
}

describe("binary-finder", () => {
    beforeEach(() => {
        delete process.env.MMX_BIN;
        clearMmxCache();
    });

    it("S1: MMX_BIN env takes priority over npm-global and PATH", async () => {
        process.env.MMX_BIN = ENV_PATH;
        const execText = mockExecText([
            { match: (cmd) => cmd === ENV_PATH && !process.env.MMX_BIN_TEST_NO_VERSION, stdout: "mmx 1.0.15\n" },
        ]);
        const result = await findMmx({ execText });
        expect(result.found).toBe(true);
        expect(result.path).toBe(ENV_PATH);
        expect(result.source).toBe("env");
        expect(result.version).toBe("mmx 1.0.15");
    });

    it("S2: npm-global path found when env unset", async () => {
        const execText = mockExecText([
            { match: (cmd, args) => cmd === "npm" && args[0] === "prefix", stdout: NPM_GLOBAL_DIR },
            { match: (cmd) => cmd === MMX_PATH, stdout: "mmx 1.0.15\n" },
        ]);
        const result = await findMmx({ execText });
        expect(result.found).toBe(true);
        expect(result.path).toBe(MMX_PATH);
        expect(result.source).toBe("npm-global");
        expect(result.version).toBe("mmx 1.0.15");
    });

    it("S3: PATH fallback when env unset and npm-global fails", async () => {
        const execText = mockExecText([
            { match: (cmd, args) => cmd === "npm" && args[0] === "prefix", stdout: "", shouldThrow: true, code: 1 },
            { match: (cmd, args) => cmd === "which" && args[0] === "mmx", stdout: `${USER_MMX_PATH}\n` },
            { match: (cmd) => cmd === USER_MMX_PATH, stdout: "mmx 1.0.15\n" },
        ]);
        const result = await findMmx({ execText });
        expect(result.found).toBe(true);
        expect(result.path).toBe(USER_MMX_PATH);
        expect(result.source).toBe("path");
        expect(result.version).toBe("mmx 1.0.15");
    });

    it("S4: not-found when all sources fail", async () => {
        const execText = mockExecText([
            { match: (cmd, args) => cmd === "npm" && args[0] === "prefix", stdout: "", shouldThrow: true, code: 1 },
            { match: (cmd, args) => cmd === "which" && args[0] === "mmx", stdout: "\n" },
        ]);
        const result = await findMmx({ execText });
        expect(result.found).toBe(false);
        expect(result.path).toBe("");
        expect(result.source).toBe("not-found");
        expect(result.version).toBeUndefined();
    });

    it("S5: verify-once-and-cache within a session", async () => {
        let calls = 0;
        const execText = async () => {
            calls++;
            return "mmx 1.0.15";
        };
        const r1 = await findMmx({ execText });
        const callsAfterFirst = calls;
        const r2 = await findMmx({ execText });
        expect(r2).toEqual(r1);
        // Second call must not spawn any subprocess
        expect(calls).toBe(callsAfterFirst);
    });

    it("clearMmxCache() forces re-exec on next call", async () => {
        let calls = 0;
        const execText = async () => {
            calls++;
            return "mmx 1.0.15";
        };
        await findMmx({ execText });
        const callsBeforeClear = calls;
        clearMmxCache();
        await findMmx({ execText });
        expect(calls).toBeGreaterThan(callsBeforeClear);
    });

    it("falls through MMX_BIN when its --version fails", async () => {
        process.env.MMX_BIN = "/nonexistent/mmx";
        const execText = mockExecText([
            { match: (cmd) => cmd === "/nonexistent/mmx", stdout: "", shouldThrow: true, code: 1 },
            { match: (cmd, args) => cmd === "npm" && args[0] === "prefix", stdout: NPM_GLOBAL_DIR },
            { match: (cmd) => cmd === MMX_PATH, stdout: "mmx 1.0.15\n" },
        ]);
        const result = await findMmx({ execText });
        expect(result.found).toBe(true);
        expect(result.source).toBe("npm-global");
    });

    it("falls through npm-global when its --version fails", async () => {
        const execText = mockExecText([
            { match: (cmd, args) => cmd === "npm" && args[0] === "prefix", stdout: NPM_GLOBAL_DIR },
            { match: (cmd) => cmd === MMX_PATH, stdout: "", shouldThrow: true, code: 1 },
            { match: (cmd, args) => cmd === "which" && args[0] === "mmx", stdout: `${USER_MMX_PATH}\n` },
            { match: (cmd) => cmd === USER_MMX_PATH, stdout: "mmx 1.0.15\n" },
        ]);
        const result = await findMmx({ execText });
        expect(result.found).toBe(true);
        expect(result.source).toBe("path");
    });
});

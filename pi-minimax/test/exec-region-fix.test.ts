/**
 * RED phase: tests for execMmx auto-injection of --base-url from regionFix.
 *
 * Scenarios:
 *   E1: regionFix.needsBaseUrlOverride=true + caller did NOT pass --base-url
 *       → --base-url <correctedBaseUrl> is appended
 *   E2: regionFix.needsBaseUrlOverride=true + caller DID pass --base-url
 *       → caller's value preserved (we don't double-add)
 *   E3: regionFix.needsBaseUrlOverride=false → no injection
 *   E4: regionFix undefined/null → no injection (default behavior preserved
 *       for backwards compatibility with existing tests)
 *   E5: injection happens AFTER user args + auto agent flags + apiKey
 *       (last position so it overrides any earlier value mmx-cli might honor)
 */

import { describe, it, expect } from "bun:test";
import { execMmx, type ExecFileFn } from "../src/services/exec.js";
import type { RegionFixState } from "../src/services/region-fix.js";

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

const REGION_FIX_CN: RegionFixState = {
    needsBaseUrlOverride: true,
    correctedBaseUrl: "https://api.minimaxi.com",
};

describe("execMmx region-fix auto-injection", () => {
    it("E1: injects --base-url when regionFix says override needed and caller did not pass it", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            { command: "search query", args: { q: "Chengdu weather" }, regionFix: REGION_FIX_CN },
            { execFile: fn },
        );
        const args = calls[0]!.args;
        const idx = args.indexOf("--base-url");
        expect(idx).toBeGreaterThan(-1);
        expect(args[idx + 1]).toBe("https://api.minimaxi.com");
    });

    it("E2: does NOT inject --base-url when caller already provided one", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            {
                command: "search query",
                args: { q: "x", "base-url": "https://custom.example.com" },
                regionFix: REGION_FIX_CN,
            },
            { execFile: fn },
        );
        const args = calls[0]!.args;
        const baseUrlIdxs = args
            .map((a, i) => (a === "--base-url" ? i : -1))
            .filter((i) => i >= 0);
        // Exactly ONE --base-url (the caller's), not two
        expect(baseUrlIdxs).toHaveLength(1);
        expect(args[baseUrlIdxs[0]! + 1]).toBe("https://custom.example.com");
    });

    it("E3: does NOT inject when regionFix says no override needed", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            {
                command: "search query",
                args: { q: "x" },
                regionFix: { needsBaseUrlOverride: false, correctedBaseUrl: "https://api.minimaxi.com" },
            },
            { execFile: fn },
        );
        expect(calls[0]!.args).not.toContain("--base-url");
    });

    it("E4: does NOT inject when regionFix is undefined (default behavior)", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx({ command: "search query", args: { q: "x" } }, { execFile: fn });
        expect(calls[0]!.args).not.toContain("--base-url");
    });

    it("E4b: does NOT inject when regionFix is explicitly null", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            { command: "search query", args: { q: "x" }, regionFix: null },
            { execFile: fn },
        );
        expect(calls[0]!.args).not.toContain("--base-url");
    });

    it("E5: --base-url is appended LAST (after user args, auto flags, apiKey)", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            {
                command: "text chat",
                args: { message: "hi" },
                apiKey: "sk-test",
                regionFix: REGION_FIX_CN,
            },
            { execFile: fn },
        );
        const args = calls[0]!.args;
        const baseUrlIdx = args.indexOf("--base-url");
        const apiKeyIdx = args.indexOf("--api-key");
        const nonInteractiveIdx = args.indexOf("--non-interactive");
        // --base-url must come after --api-key and --non-interactive
        expect(baseUrlIdx).toBeGreaterThan(apiKeyIdx);
        expect(baseUrlIdx).toBeGreaterThan(nonInteractiveIdx);
        // And it must be the very last argv pair (last 2 elements)
        expect(baseUrlIdx).toBe(args.length - 2);
        expect(args[baseUrlIdx + 1]).toBe("https://api.minimaxi.com");
    });

    it("E6: region fix works for search AND text chat (bug affects both)", async () => {
        // Regression: ensure the fix applies uniformly to all mmx commands,
        // not just 'search query'. The bug lives in mmx-cli's HTTP client,
        // so every endpoint needs the workaround.
        const { fn, calls } = mockExecFile();
        await execMmx(
            { command: "text chat", args: { message: "hi" }, regionFix: REGION_FIX_CN },
            { execFile: fn },
        );
        expect(calls[0]!.args).toContain("--base-url");
        expect(calls[0]!.args).toContain("https://api.minimaxi.com");
    });

    it("E7: correctedBaseUrl empty string → no injection (defensive)", async () => {
        const { fn, calls } = mockExecFile();
        await execMmx(
            {
                command: "search query",
                args: { q: "x" },
                regionFix: { needsBaseUrlOverride: true, correctedBaseUrl: "" },
            },
            { execFile: fn },
        );
        expect(calls[0]!.args).not.toContain("--base-url");
    });
});
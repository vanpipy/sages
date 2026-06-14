/**
 * Tests for extensions/minimax-extension.ts entry point.
 */

import { describe, it, expect } from "bun:test";

describe("extension entry", () => {
    it("default export is a function", async () => {
        const mod = await import("../extensions/minimax-extension.js");
        expect(typeof mod.default).toBe("function");
    });

    it("calls registerMinimaxTools and registers slash commands", async () => {
        const { default: extension } = await import("../extensions/minimax-extension.js");
        const calls: Array<{ kind: string; name: string }> = [];
        const pi = {
            registerTool: (tool: { name: string }) => calls.push({ kind: "tool", name: tool.name }),
            registerCommand: (name: string) => calls.push({ kind: "command", name }),
        } as unknown as Parameters<typeof extension>[0];
        extension(pi);
        // Tools
        expect(calls.filter((c) => c.kind === "tool").map((c) => c.name).sort()).toEqual([
            "minimax_auth_status",
            "minimax_exec",
            "minimax_search_query",
        ]);
        // Slash commands
        expect(calls.filter((c) => c.kind === "command").map((c) => c.name).sort()).toEqual([
            "minimax-auth-status",
            "minimax-search",
        ]);
    });
});

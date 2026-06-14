/**
 * Tests for tools/index.ts: registerMinimaxTools should register all 3 tools.
 */

import { describe, it, expect } from "bun:test";

describe("tools/index", () => {
    it("registerMinimaxTools registers all 3 tools", async () => {
        const { registerMinimaxTools } = await import("../src/tools/index.js");
        const registered: string[] = [];
        const pi = {
            registerTool: (tool: { name: string }) => {
                registered.push(tool.name);
            },
        } as unknown as Parameters<typeof registerMinimaxTools>[0];
        registerMinimaxTools(pi);
        expect(registered).toContain("minimax_auth_status");
        expect(registered).toContain("minimax_exec");
        expect(registered).toContain("minimax_search_query");
        expect(registered).toHaveLength(3);
    });
});

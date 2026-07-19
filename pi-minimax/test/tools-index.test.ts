/**
 * Tests for tools/index.ts: registerMinimaxTools should register the 2
 * post-simplification tools (auth status, web search).
 *
 * Note: `minimax_exec` (L1 escape hatch) was removed 2026-07-19. The LLM now
 * uses the AFT-backed `bash` tool to run any other mmx subcommand directly,
 * and the `mmxc-cli` skill (installed via `npx skills add MiniMax-AI/cli -y -g`)
 * is the canonical reference for the full mmx command surface.
 */

import { describe, it, expect } from "bun:test";

describe("tools/index", () => {
    it("registerMinimaxTools registers the 2 simplified tools", async () => {
        const { registerMinimaxTools } = await import("../src/tools/index.js");
        const registered: string[] = [];
        const pi = {
            registerTool: (tool: { name: string }) => {
                registered.push(tool.name);
            },
        } as unknown as Parameters<typeof registerMinimaxTools>[0];
        registerMinimaxTools(pi);
        expect(registered).toContain("minimax_auth_status");
        expect(registered).toContain("minimax_search_query");
        expect(registered).toHaveLength(2);
        // Negative: the removed exec tool must not be re-introduced.
        expect(registered).not.toContain("minimax_exec");
    });

    describe("tool descriptions list all error codes", () => {
        // Regression test: each tool's description must mention NOT_AUTHED, MMX_NOT_FOUND, and TIMEOUT
        // so the LLM knows what error codes to expect. (Audit v1.1 finding: ink/minor.)

        const REQUIRED_ERROR_CODES = ["NOT_AUTHED", "MMX_NOT_FOUND", "TIMEOUT"];

        async function getDescription(toolName: string): Promise<string> {
            const { registerMinimaxTools } = await import("../src/tools/index.js");
            let captured = "";
            const pi = {
                registerTool: (tool: { name: string; description: string }) => {
                    if (tool.name === toolName) captured = tool.description;
                },
            } as unknown as Parameters<typeof registerMinimaxTools>[0];
            registerMinimaxTools(pi);
            return captured;
        }

        for (const code of REQUIRED_ERROR_CODES) {
            it(`minimax_auth_status description mentions ${code}`, async () => {
                const desc = await getDescription("minimax_auth_status");
                expect(desc).toContain(code);
            });
            it(`minimax_search_query description mentions ${code}`, async () => {
                const desc = await getDescription("minimax_search_query");
                expect(desc).toContain(code);
            });
        }
    });
});

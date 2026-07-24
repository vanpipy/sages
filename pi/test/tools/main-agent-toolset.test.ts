/**
 * Tests for `registerSagesExtension` — Layer 1 + Layer 2 main-agent gates.
 *
 * Layer 1: `session_start` filters `edit` / `write` from main agent's active tools.
 * Layer 2: `tool_call` event blocks bash commands targeting production code paths.
 *
 * RED phase — these tests fail until `pi/src/extension.ts` is updated to register
 * the two `pi.on(...)` handlers (see goal GC-2026-001, P2).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import registerSagesExtension from "@/extension.js";

/**
 * Minimal mock of the ExtensionAPI surface actually used by registerSagesExtension.
 * - `registerTool` is called by `registerOrchestratorTools` and `registerFileGate`
 *   to register the 4 orchestrator + 2 file-gate tools. We don't need them for
 *   these tests; just record the calls so we can confirm extension registration
 *   ran.
 * - `on(event, handler)` captures the session_start + tool_call handlers.
 * - `getActiveTools` returns the configurable test fixture list.
 * - `setActiveTools` records the filter result.
 */
class MockPi {
    handlers: Record<string, Array<(...args: any[]) => any>> = {};
    getActiveToolsResult: string[] = [];
    setActiveToolsCalls: string[][] = [];
    registeredTools: Array<{ name: string }> = [];

    on(event: string, handler: (...args: any[]) => any): void {
        (this.handlers[event] ||= []).push(handler);
    }
    getActiveTools(): string[] {
        return this.getActiveToolsResult;
    }
    setActiveTools(tools: string[]): void {
        this.setActiveToolsCalls.push(tools);
    }
    registerTool(def: { name: string }): void {
        this.registeredTools.push({ name: def.name });
    }
    // The orchestrator + file-gate never call these; stubbed to satisfy the
    // ExtensionAPI surface in case of future additions.
    registerCommand(_name: string, _opts: any): void {}
    registerShortcut(_s: any, _opts: any): void {}
    registerFlag(_name: string, _opts: any): void {}
}

describe("registerSagesExtension — Layer 1: edit/write drop", () => {
    let mock: MockPi;

    beforeEach(() => {
        mock = new MockPi();
    });

    /** Helper: register the extension and return a copy of the captured list. */
    function registerAndFilter(initialTools: string[]): string[] {
        mock.getActiveToolsResult = initialTools;
        registerSagesExtension(mock as any);
        const sessionStart = mock.handlers.session_start?.[0];
        expect(sessionStart).toBeDefined();
        sessionStart!();
        expect(mock.setActiveToolsCalls).toHaveLength(1);
        return mock.setActiveToolsCalls[0];
    }

    it("T-A: drops `edit` and `write` from a mixed list", () => {
        const filtered = registerAndFilter([
            "read", "edit", "write", "grep", "bash", "sages_write",
        ]);
        expect(filtered).toEqual(["read", "grep", "bash", "sages_write"]);
    });

    it("T-B: preserves all non-write tools including sages_edit + orchestrator tools (drops edit + write)", () => {
        // Fixture includes both the write tools to drop AND a comprehensive set
        // of read/meta/orchestrator/dispatch tools that must be preserved.
        const fixture = [
            "read", "grep", "find", "ls",
            "bash", "sages_write", "sages_edit",
            "goal_contract_create", "dag_synthesize",
            "task_dispatch", "orchestrator_audit",
            "Agent", "get_subagent_result", "steer_subagent",
            "edit",   // ← must be dropped
            "write",  // ← must be dropped
        ];
        const filtered = registerAndFilter(fixture);
        expect(filtered).not.toContain("edit");
        expect(filtered).not.toContain("write");
        for (const t of fixture) {
            if (t !== "edit" && t !== "write") {
                expect(filtered).toContain(t);
            }
        }
        expect(filtered).toHaveLength(fixture.length - 2);
    });

    it("no-op when neither edit nor write is in active tools", () => {
        const filtered = registerAndFilter(["read", "bash", "sages_write", "sages_edit"]);
        expect(filtered).toEqual(["read", "bash", "sages_write", "sages_edit"]);
    });
});

describe("registerSagesExtension — Layer 2: bash write-intent gate", () => {
    let mock: MockPi;

    beforeEach(() => {
        mock = new MockPi();
    });

    async function getBashHandler(): Promise<(event: any, ctx: any) => Promise<any> | any> {
        registerSagesExtension(mock as any);
        const handler = mock.handlers.tool_call?.[0];
        expect(handler).toBeDefined();
        return handler!;
    }

    it("T-C: blocks `rm src/foo.ts` with reason mentioning production code", async () => {
        const handler = await getBashHandler();
        const result = await handler(
            { toolName: "bash", input: { command: "rm src/foo.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(result).toBeDefined();
        expect(result.block).toBe(true);
        expect(result.reason).toMatch(/production code/);
    });

    it("T-D: passes through non-bash events (returns undefined)", async () => {
        const handler = await getBashHandler();
        const result = await handler(
            { toolName: "read", input: { path: "src/foo.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(result).toBeUndefined();
    });

    it("passes through read-only bash commands (cat, ls, grep)", async () => {
        const handler = await getBashHandler();
        for (const cmd of ["cat src/foo.ts", "ls -la src/", "grep TODO src/foo.ts"]) {
            const result = await handler(
                { toolName: "bash", input: { command: cmd } },
                { cwd: "/home/leroy/sages-worktrees/main" },
            );
            expect(result).toBeUndefined();
        }
    });
});

describe("registerSagesExtension — registration correctness", () => {
    it("still registers all orchestrator + file-gate tools after adding gates", () => {
        const mock = new MockPi();
        registerSagesExtension(mock as any);
        const toolNames = mock.registeredTools.map((t) => t.name).sort();
        // 4 orchestrator + 2 file-gate = 6
        expect(toolNames).toEqual([
            "dag_synthesize",
            "goal_contract_create",
            "orchestrator_audit",
            "sages_edit",
            "sages_write",
            "task_dispatch",
        ]);
    });
});

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

describe("registerSagesExtension — Layer 1: positive capability allowlist", () => {
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
            "read", "edit", "write", "grep", "bash",
        ]);
        expect(filtered).toEqual(["read", "grep", "bash"]);
    });

    it("T-B: preserves approved orchestrator, Agent lifecycle, and read-only tools only", () => {
        const approved = [
            "read", "grep", "find", "ls", "bash", "aft_read", "aft_search", "aft_zoom", "aft_outline",
            "codebase_search", "codebase_refs", "codebase_memory_list_projects", "ctx_search", "todowrite",
            "goal_contract_create", "dag_synthesize", "task_dispatch", "orchestrator_audit",
            "Agent", "get_subagent_result", "steer_subagent",
        ];
        const denied = ["edit", "write", "aft_edit", "apply_patch", "mystery_mutate"];
        const filtered = registerAndFilter([...approved, ...denied]);
        expect(filtered).toEqual(approved);
        for (const tool of denied) expect(filtered).not.toContain(tool);
    });

    it("no-op when neither edit nor write is in active tools", () => {
        const filtered = registerAndFilter([
            "read", "bash",
            "goal_contract_create", "dag_synthesize",
            "task_dispatch", "orchestrator_audit",
            "Agent",
        ]);
        expect(filtered).toEqual([
            "read", "bash",
            "goal_contract_create", "dag_synthesize",
            "task_dispatch", "orchestrator_audit",
            "Agent",
        ]);
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

    it("T-C: blocks `rm src/foo.ts` with destructive reason (GC-2026-015 follow-up)", async () => {
        // Restored invariant: rm/mv/cp/unlink/rmdir are always
        // denied regardless of target, so the L4 production-target
        // reason is shadowed by the destructive short-circuit. Use
        // a non-destructive write-intent below to assert the
        // L4 production-target reason survives for ordinary
        // write-intents.
        const handler = await getBashHandler();
        const result = await handler(
            { toolName: "bash", input: { command: "rm src/foo.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(result).toBeDefined();
        expect(result.block).toBe(true);
        expect(result.reason).toMatch(/destructive:/);
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
    it("registers only the 4 orchestrator tools (no sages_write/sages_edit since f7144b2 + 633ca97)", () => {
        const mock = new MockPi();
        registerSagesExtension(mock as any);
        const toolNames = mock.registeredTools.map((t) => t.name).sort();
        expect(toolNames).toEqual([
            "dag_synthesize",
            "goal_contract_create",
            "orchestrator_audit",
            "task_dispatch",
        ]);
    });

    it("main agent toolset contains no direct write tools (forces Agent dispatch)", () => {
        // Belt-and-suspenders: after dropping raw edit/write AND retiring
        // sages_write/sages_edit, the LLM has no way to write any file
        // directly. All edits must go through Agent dispatch. This is
        // the "pure coordinator" design point.
        const mock = new MockPi();
        registerSagesExtension(mock as any);
        const toolNames = mock.registeredTools.map((t) => t.name);
        for (const writeLike of ["edit", "write", "sages_edit", "sages_write"]) {
            expect(toolNames).not.toContain(writeLike);
        }
    });
});

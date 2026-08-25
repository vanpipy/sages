/**
 * Tests for `registerSagesExtension` — soft mode (GC-2026-031).
 *
 * The Sages main agent operates in soft mode: no commands are blocked,
 * `edit` / `write` / `aft_edit` / `apply_patch` are present in the
 * active toolset, and bash write-intent is allowed without a guard.
 * Subagent dispatch is a RECOMMENDATION (driven by the agent's own
 * todowrite count), surfaced via auto-steer reminders, never blocks.
 *
 * The session_start + before_agent_start handlers were dropped after
 * this suite was originally written; their assertions were removed in
 * the same change. The remaining tests cover the bash tool_call handler
 * (the only soft-mode reminder surface still wired) and tool
 * registration correctness.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import registerSagesExtension from "@/extension.js";
import { STANDARD_PROFILE } from "@/profile/types.js";

/**
 * Minimal mock of the ExtensionAPI surface actually used by registerSagesExtension.
 * - `registerTool` is called by `registerOrchestratorTools` to register the 4
 *   orchestrator tools. We record the calls so we can confirm registration ran.
 * - `on(event, handler)` captures every event handler.
 * - `getActiveTools` / `setActiveTools` record / restore the toolset (soft mode
 *   does NOT touch these — main agent has full toolset on registration).
 * - `appendEntry(channel, text)` records the soft-mode reminders that the bash
 *   handler emits once per session.
 */
class MockPi {
    handlers: Record<string, Array<(...args: any[]) => any>> = {};
    getActiveToolsResult: string[] = [];
    setActiveToolsCalls: string[][] = [];
    registeredTools: Array<{ name: string }> = [];
    appendedEntries: Array<{ channel: string; text: string }> = [];

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
    appendEntry(channel: string, text: string): void {
        this.appendedEntries.push({ channel, text });
    }
    // The orchestrator + file-gate never call these; stubbed to satisfy the
    // ExtensionAPI surface in case of future additions.
    registerCommand(_name: string, _opts: any): void {}
    registerShortcut(_s: any, _opts: any): void {}
    registerFlag(_name: string, _opts: any): void {}
}

// (Tests for session_start + before_agent_start handlers were removed when
// the handlers themselves were dropped — the assertions verified the
// handlers were registered, which they no longer are.)

describe("registerSagesExtension — soft mode bash handler (no Layer 2 block)", () => {
    let mock: MockPi;

    beforeEach(() => {
        mock = new MockPi();
    });

    async function getBashHandler(): Promise<(event: any, ctx: any) => Promise<any> | any> {
        registerSagesExtension(mock as any);
        const handlers = mock.handlers.tool_call ?? [];
        expect(handlers.length).toBeGreaterThan(0);
        // Return a composite handler that invokes ALL registered tool_call
        // handlers in order. Mirrors how pi actually runs event handlers
        // (they all fire, first non-undefined result wins).
        return (event: any, ctx: any) => {
            let result: any = undefined;
            for (const h of handlers) {
                const r = h(event, ctx);
                if (r !== undefined && result === undefined) result = r;
            }
            return result;
        };
    }

    it("T-C (inverted): `rm src/foo.ts` is NOT blocked in soft mode", async () => {
        // Destructive commands are no longer hard-blocked. Soft mode lets them
        // through; the only response is the auto-steer reminder (covered below).
        const handler = await getBashHandler();
        const result = await handler(
            { toolName: "bash", input: { command: "rm src/foo.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(result).toBeUndefined();
    });

    it("T-AUTO-STEER: emits SOFT_MODE_REMINDER via appendEntry for write-intent bash (once per session)", async () => {
        const handler = await getBashHandler();
        // First write-intent command — should emit the reminder.
        await handler(
            { toolName: "bash", input: { command: "echo x > src/foo.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(mock.appendedEntries).toHaveLength(1);
        expect(mock.appendedEntries[0].channel).toBe("system");
        expect(mock.appendedEntries[0].text).toBe(STANDARD_PROFILE.policies!.soft_mode_reminder);
        // Second write-intent command — throttled, NO new reminder.
        await handler(
            { toolName: "bash", input: { command: "sed -i 's/a/b/' src/bar.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(mock.appendedEntries).toHaveLength(1);
    });

    it("emits reminder on FIRST bash (read-only or write-intent) — PR 1 conductor", async () => {
        // GC-2026-069 PR 1: the new conductor's reminder injector fires on the
        // first bash call regardless of classification (more eager than the
        // historical write-intent-only behavior — the soft-mode nudge is
        // useful even for read-only commands because it tells the LLM that
        // subagent dispatch is recommended for non-trivial work).
        const handler = await getBashHandler();
        await handler(
            { toolName: "bash", input: { command: "ls -la" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(mock.appendedEntries).toHaveLength(1);
    });

    it("T-D (preserved): passes through non-bash events (returns undefined)", async () => {
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
    it("registers the 4 orchestrator tools + sages_reminder", () => {
        const mock = new MockPi();
        registerSagesExtension(mock as any);
        const toolNames = mock.registeredTools.map((t) => t.name).sort();
        expect(toolNames).toEqual([
            "dag_synthesize",
            "goal_contract_create",
            "orchestrator_audit",
            "sages_reminder",
            "task_dispatch",
        ]);
    });
});

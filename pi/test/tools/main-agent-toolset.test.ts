/**
 * Tests for `registerSagesExtension` — soft mode (GC-2026-031).
 *
 * The Sages main agent operates in soft mode: no commands are blocked,
 * `edit` / `write` / `aft_edit` / `apply_patch` are present in the
 * active toolset, and bash write-intent is allowed without a guard.
 * Subagent dispatch is a RECOMMENDATION (driven by the agent's own
 * todowrite count), surfaced via auto-steer reminders, never blocks.
 *
 * RED phase — these tests fail until `pi/src/extension.ts` is updated
 * to remove Layer 1, emit soft-mode reminders via `pi.appendEntry`,
 * and inject the soft-mode system-prompt suffix via `before_agent_start`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import registerSagesExtension from "@/extension.js";
import { SOFT_MODE_REMINDER, SOFT_MODE_SYSTEM_PROMPT_SUFFIX } from "@/soft-mode.js";

/**
 * Minimal mock of the ExtensionAPI surface actually used by registerSagesExtension.
 * - `registerTool` is called by `registerOrchestratorTools` to register the 4
 *   orchestrator tools. We record the calls so we can confirm registration ran.
 * - `on(event, handler)` captures every event handler.
 * - `getActiveTools` / `setActiveTools` record / restore the toolset (soft mode
 *   does NOT touch these — main agent has full toolset on session_start).
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

describe("registerSagesExtension — soft mode (no Layer 1 strip)", () => {
    let mock: MockPi;

    beforeEach(() => {
        mock = new MockPi();
    });

    it("T-A (inverted): preserves `edit` and `write` after session_start", () => {
        mock.getActiveToolsResult = ["read", "edit", "write", "grep", "bash"];
        registerSagesExtension(mock as any);
        const sessionStart = mock.handlers.session_start?.[0];
        expect(sessionStart).toBeDefined();
        sessionStart!();
        // Soft mode does not touch the active toolset.
        expect(mock.setActiveToolsCalls).toHaveLength(0);
    });

    it("T-B (updated): preserves the FULL toolset (including edit/write/aft_edit/apply_patch) after session_start", () => {
        const fullToolset = [
            "read", "edit", "write", "aft_edit", "apply_patch",
            "grep", "find", "ls", "bash",
            "aft_read", "aft_search", "aft_zoom", "aft_outline",
            "codebase_search", "codebase_refs", "codebase_memory_list_projects",
            "ctx_search", "todowrite",
            "goal_contract_create", "dag_synthesize", "task_dispatch", "orchestrator_audit",
            "Agent", "get_subagent_result", "steer_subagent",
        ];
        mock.getActiveToolsResult = fullToolset;
        registerSagesExtension(mock as any);
        const sessionStart = mock.handlers.session_start?.[0];
        sessionStart!();
        // Soft mode does not strip anything — the toolset stays as-is.
        expect(mock.setActiveToolsCalls).toHaveLength(0);
    });

    it("session_start resets the auto-steer throttle (once-per-session)", () => {
        registerSagesExtension(mock as any);
        const sessionStart = mock.handlers.session_start?.[0];
        expect(sessionStart).toBeDefined();
        // First session_start — flag is fresh, no prior reminder.
        sessionStart!();
        // session_start may inject the GC-2026-067 session digest (a
        // `system` channel entry) — we don't assert the absolute count
        // because future digest changes would break the test. The
        // auto-steer reminder (SOFT_MODE_REMINDER) is what we care
        // about here, and it should NOT have fired yet.
        const steerEntries = mock.appendedEntries.filter(
            (e) => e.text === SOFT_MODE_REMINDER,
        );
        expect(steerEntries).toHaveLength(0);
    });
});

describe("registerSagesExtension — soft mode bash handler (no Layer 2 block)", () => {
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
        expect(mock.appendedEntries[0].text).toBe(SOFT_MODE_REMINDER);
        // Second write-intent command — throttled, NO new reminder.
        await handler(
            { toolName: "bash", input: { command: "sed -i 's/a/b/' src/bar.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(mock.appendedEntries).toHaveLength(1);
    });

    it("does NOT emit reminder for read-only bash commands", async () => {
        const handler = await getBashHandler();
        await handler(
            { toolName: "bash", input: { command: "ls -la" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        await handler(
            { toolName: "bash", input: { command: "cat src/foo.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(mock.appendedEntries).toHaveLength(0);
    });

    it("reminder throttle resets on session_start (next session can be reminded again)", async () => {
        const handler = await getBashHandler();
        const sessionStart = mock.handlers.session_start?.[0];
        expect(sessionStart).toBeDefined();

        // First session — emit and consume the reminder slot.
        await handler(
            { toolName: "bash", input: { command: "echo x > src/foo.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(mock.appendedEntries).toHaveLength(1);
        await handler(
            { toolName: "bash", input: { command: "echo y > src/bar.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        expect(mock.appendedEntries).toHaveLength(1);

        // session_start — throttle resets. (Also appends the GC-2026-067
        // session digest; we filter to the auto-steer reminder below so
        // digest changes don't break this assertion.)
        sessionStart!();
        await handler(
            { toolName: "bash", input: { command: "echo z > src/baz.ts" } },
            { cwd: "/home/leroy/sages-worktrees/main" },
        );
        const steerEntries = mock.appendedEntries.filter(
            (e) => e.text === SOFT_MODE_REMINDER,
        );
        expect(steerEntries).toHaveLength(2);
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

describe("registerSagesExtension — before_agent_start appends soft-mode suffix", () => {
    let mock: MockPi;

    beforeEach(() => {
        mock = new MockPi();
    });

    it("T-SOFT-MODE-SUFFIX: before_agent_start injects SOFT_MODE_SYSTEM_PROMPT_SUFFIX into the system prompt", async () => {
        registerSagesExtension(mock as any);
        const handler = mock.handlers.before_agent_start?.[0];
        expect(handler).toBeDefined();
        const result = await handler(
            { systemPrompt: "BASE_SYSTEM_PROMPT" },
            {} as any,
        );
        expect(result).toBeDefined();
        expect(result.systemPrompt).toContain("BASE_SYSTEM_PROMPT");
        expect(result.systemPrompt).toContain(SOFT_MODE_SYSTEM_PROMPT_SUFFIX.trim());
    });
});

describe("registerSagesExtension — registration correctness", () => {
    it("registers the 4 orchestrator tools + sages_reminder + sages_todo", () => {
        const mock = new MockPi();
        registerSagesExtension(mock as any);
        const toolNames = mock.registeredTools.map((t) => t.name).sort();
        expect(toolNames).toEqual([
            "dag_synthesize",
            "goal_contract_create",
            "orchestrator_audit",
            "sages_reminder",
            "sages_todo",
            "task_dispatch",
        ]);
    });
});

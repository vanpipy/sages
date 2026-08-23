/**
 * todo-extension tests — GC-2026-060 + GC-2026-068 sages-todo extension wiring.
 *
 * Covers the `registerSagesExtension` wiring block:
 *  - `sages_todo` sync tool_call → TodoStateManager + persist
 *  - before_agent_start injects the per-turn todo block (only when the
 *    list is non-empty OR a change diff is pending); diff is one-shot
 *  - session_start restores the persisted list (cross-session resume)
 *  - input event resets the stale counters
 *  - turn_end advances staleness and appends a rate-limited reminder
 *  - dag_synthesize / orchestrator_audit tool_calls trigger auto-plan
 *  - root-only guard: an explicit `owner !== "root"` marker is rejected
 *  - existing soft-mode handlers keep working (bash reminder, suffix)
 *
 * Uses the MockPi pattern from main-agent-toolset.test.ts — the mock
 * records handlers by event name, so `input` / `turn_end` are just more
 * recorded handlers. Todo state lives in the extension closure; tests
 * observe it through the persisted file (loadTodoState), the
 * before_agent_start output, and the appended reminder entries.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import registerSagesExtension from "@/extension.js";
import {
  SOFT_MODE_REMINDER,
  SOFT_MODE_SYSTEM_PROMPT_SUFFIX,
} from "@/soft-mode.js";
import {
  TodoStateManager,
  loadTodoState,
  saveTodoState,
  todoStateDir,
  type TodoItem,
} from "@/tools/todo/todo-state.js";
import { executeSagesTodo } from "@/tools/todo/sages-todo-tool.js";

/**
 * Minimal mock of the ExtensionAPI surface used by registerSagesExtension.
 * Handlers are recorded by event name (session_start / tool_call /
 * before_agent_start / input / turn_end) so tests can fire the exact
 * event sequence they need; registerTool + appendEntry record outputs.
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
  registerCommand(_name: string, _opts: any): void {}
  registerShortcut(_s: any, _opts: any): void {}
  registerFlag(_name: string, _opts: any): void {}
}

/** Fixture DAG: batch 1 = P1, P2 (parallel); batch 2 = P3. */
const FIXTURE_DAG = {
  id: "DAG-2026-060",
  goal_id: "GC-2026-060",
  title: "Auto-todo fixture",
  state: "approved",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  tasks: [
    {
      id: "P1",
      description: "Build the todo state manager",
      status: "pending",
      batch: 1,
      retry_count: 0,
      max_retries: 2,
    },
    {
      id: "P2",
      description: "Build the sages_todo tool",
      status: "pending",
      batch: 1,
      retry_count: 0,
      max_retries: 2,
    },
    {
      id: "P3",
      description: "Wire the todo reminder into the extension",
      status: "pending",
      batch: 2,
      retry_count: 0,
      max_retries: 2,
    },
  ],
};

/** Expected deriveDagTodos output for FIXTURE_DAG (no audit-state). */
const EXPECTED_DERIVED: TodoItem[] = [
  { id: "P1", content: "Build the todo state manager", status: "in_progress" },
  { id: "P2", content: "Build the sages_todo tool", status: "in_progress" },
  { id: "P3", content: "Wire the todo reminder into the extension", status: "pending" },
];

const GENTLE_TEXT =
  "You have todos that have been in_progress for a while — " +
  "verify each is still advancing or mark it pending/complete.";

let mock: MockPi;
let tmp: string;

beforeEach(() => {
  mock = new MockPi();
  // resolveRepoRoot treats a directory containing .pi/orchestrator as the
  // repo root — creating it here keeps every test isolated from the real
  // sages repo and from the findSagesRoot fallback.
  tmp = mkdtempSync(join(tmpdir(), "sages-todo-ext-"));
  mkdirSync(join(tmp, ".pi", "orchestrator"), { recursive: true });
  writeFileSync(
    join(tmp, ".pi", "orchestrator", "dag-GC-2026-060.yaml"),
    yaml.dump(FIXTURE_DAG, { noRefs: true }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Fire every registered tool_call handler (pi fires all listeners serially). */
async function fireToolCall(event: any, ctx: any = { cwd: tmp }): Promise<void> {
  for (const handler of mock.handlers.tool_call ?? []) {
    await handler(event, ctx);
  }
}

/** Fire the single before_agent_start handler and return the new prompt. */
async function beforeAgentStart(systemPrompt = "BASE"): Promise<string> {
  const handler = mock.handlers.before_agent_start?.[0];
  expect(handler).toBeDefined();
  const result = await handler({ systemPrompt }, {} as any);
  return result.systemPrompt;
}

/** Fire every turn_end handler once. */
function fireTurnEnd(): void {
  for (const handler of mock.handlers.turn_end ?? []) {
    handler();
  }
}

/** Fire every input handler once (user interjection). */
function fireInput(text = "stay on track"): void {
  for (const handler of mock.handlers.input ?? []) {
    handler({ text, source: "interactive" }, {} as any);
  }
}

function todoReminders(): Array<{ channel: string; text: string }> {
  return mock.appendedEntries.filter((e) => e.text.startsWith("[sages todo reminder]"));
}

// ─── sages_todo sync mirror ──────────────────────────────────────────────────

describe("todo extension — sages_todo sync mirror", () => {
  it("mirrors a sages_todo sync call into the root todo state (get returns the list)", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({
      toolName: "sages_todo",
      input: {
        action: "sync",
        todos: [
          { content: "Build the state manager", status: "pending" },
          { content: "Wire the extension", status: "in_progress" },
          { content: "Done thing", status: "completed" },
        ],
      },
    });

    // Persisted to <repo>/.pi/orchestrator/todo-state.json.
    const loaded = loadTodoState(todoStateDir(tmp));
    expect(loaded?.getTodos()).toEqual([
      { content: "Build the state manager", status: "pending" },
      { content: "Wire the extension", status: "in_progress" },
      { content: "Done thing", status: "completed" },
    ]);
    expect(loaded?.getCounts()).toEqual({ pending: 1, inProgress: 1, completed: 1 });

    // And the sages_todo get action (file-backed) returns the mirrored list.
    const get = await executeSagesTodo({ action: "get" }, { cwd: tmp });
    expect(get.details.status).toBe("ok");
    expect(get.details.todos).toEqual(loaded?.getTodos());
  });

  it("ignores empty/malformed sages_todo inputs (no state change, no crash)", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({ toolName: "sages_todo", input: { action: "sync", todos: [] } });
    await fireToolCall({ toolName: "sages_todo", input: { action: "sync" } });
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ content: "", status: "pending" }, { status: "pending" }, "junk"] },
    });
    expect(loadTodoState(todoStateDir(tmp))).toBeNull();
    expect(await beforeAgentStart()).not.toContain("[sages todos:");
  });

  it("root-only: sages_todo with an explicit owner marker 'subagent' is rejected", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({
      toolName: "sages_todo",
      input: {
        owner: "subagent",
        action: "sync",
        todos: [{ content: "subagent sneaky todo", status: "in_progress" }],
      },
    });

    // State untouched: nothing persisted, nothing injected.
    expect(loadTodoState(todoStateDir(tmp))).toBeNull();
    const prompt = await beforeAgentStart();
    expect(prompt).not.toContain("[sages todos:");
  });
});

// ─── before_agent_start injection ───────────────────────────────────────────

describe("todo extension — before_agent_start todo block", () => {
  it("injects the block when todos exist; skips when empty; diff is one-shot", async () => {
    registerSagesExtension(mock as any);

    // Empty state → no todo block (avoid noise).
    const emptyPrompt = await beforeAgentStart();
    expect(emptyPrompt).toContain("BASE");
    expect(emptyPrompt).not.toContain("[sages todos:");

    // Mirror a sages_todo sync: list + change diff.
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ content: "Build X", status: "pending" }] },
    });

    // Next turn: block + change highlight.
    const prompt1 = await beforeAgentStart();
    expect(prompt1).toContain("[sages todos: 1 pending | 0 in_progress | 0 completed]");
    expect(prompt1).toContain("⚠ changed: +1 added");
    expect(prompt1).toContain("- pending: Build X");

    // Diff is one-shot: the next turn keeps the block but drops the highlight.
    const prompt2 = await beforeAgentStart();
    expect(prompt2).toContain("[sages todos: 1 pending | 0 in_progress | 0 completed]");
    expect(prompt2).not.toContain("⚠ changed:");
  });

  it("injects the block with the change highlight for a replacement diff (added + removed)", async () => {
    registerSagesExtension(mock as any);
    // Seed two todos, then mirror a whole-list replacement that drops
    // both and adds one new item — the diff is added + removed.
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ content: "A", status: "pending" }, { content: "B", status: "completed" }] },
    });
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ content: "Keep this", status: "in_progress" }] },
    });
    const prompt = await beforeAgentStart();
    expect(prompt).toContain("⚠ changed: +1 added · 2 removed");
    expect(prompt).toContain("- in_progress: Keep this");
  });
});

// ─── session_start restore ──────────────────────────────────────────────────

describe("todo extension — session_start cross-session resume", () => {
  it("restores the persisted todo list on session_start", async () => {
    // Pre-seed a persisted state file in the temp repo (simulating a
    // previous session that was compacted/restarted).
    saveTodoState(
      todoStateDir(tmp),
      new TodoStateManager([{ id: "P1", content: "Resume me", status: "in_progress" }]),
    );

    registerSagesExtension(mock as any);
    const sessionStart = mock.handlers.session_start?.[0];
    expect(sessionStart).toBeDefined();
    sessionStart({}, { cwd: tmp });

    const prompt = await beforeAgentStart();
    expect(prompt).toContain("[sages todos: 0 pending | 1 in_progress | 0 completed]");
    expect(prompt).toContain("- in_progress: Resume me");
    // Restored state is not a fresh change — no highlight.
    expect(prompt).not.toContain("⚠ changed:");
  });

  it("starts with an empty list when no persisted state exists", async () => {
    registerSagesExtension(mock as any);
    mock.handlers.session_start?.[0]({}, { cwd: tmp });
    const prompt = await beforeAgentStart();
    expect(prompt).not.toContain("[sages todos:");
  });
});

// ─── input reset + turn_end stale reminder ──────────────────────────────────

describe("todo extension — turn_end stale reminder (rate-limited)", () => {
  it("fires exactly one appendEntry reminder for a stale in_progress todo, then never repeats", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ id: "P1", content: "long running", status: "in_progress" }] },
    });

    // 8 consecutive turns with P1 still in_progress.
    for (let i = 0; i < 8; i++) fireTurnEnd();

    const reminders = todoReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].channel).toBe("system");
    expect(reminders[0].text).toBe(`[sages todo reminder] ${GENTLE_TEXT}`);
  });

  it("does not remind while the todo is below the gentle threshold", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ id: "P1", content: "quick task", status: "in_progress" }] },
    });
    for (let i = 0; i < 3; i++) fireTurnEnd(); // P1 reaches 2
    expect(todoReminders()).toHaveLength(0);
  });

  it("input event resets stale counters (staleness clock restarts)", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ id: "P1", content: "long running", status: "in_progress" }] },
    });

    // 3 turns: P1 = 2 → no reminder.
    for (let i = 0; i < 3; i++) fireTurnEnd();
    expect(todoReminders()).toHaveLength(0);

    // User interjects → counters reset.
    fireInput();

    // 3 more turns after the reset: P1 = 0,1,2 → still no reminder.
    for (let i = 0; i < 3; i++) fireTurnEnd();
    expect(todoReminders()).toHaveLength(0);

    // 4th post-input turn: P1 = 3 → gentle reminder fires exactly once.
    fireTurnEnd();
    const reminders = todoReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].text).toBe(`[sages todo reminder] ${GENTLE_TEXT}`);
  });

  it("input event also clears a pending change diff", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ content: "Build X", status: "pending" }] },
    });
    fireInput();
    const prompt = await beforeAgentStart();
    expect(prompt).not.toContain("⚠ changed:");
  });
});

// ─── auto-plan triggers ─────────────────────────────────────────────────────

describe("todo extension — orchestrator tool_call auto-plan", () => {
  it("dag_synthesize (goal_id) triggers auto-plan from the fixture DAG", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({ toolName: "dag_synthesize", input: { goal_id: "GC-2026-060" } });

    const loaded = loadTodoState(todoStateDir(tmp));
    expect(loaded?.getTodos()).toEqual(EXPECTED_DERIVED);
    expect(loaded?.getCounts()).toEqual({ pending: 1, inProgress: 2, completed: 0 });

    // The change diff is stored → the next turn highlights it.
    const prompt = await beforeAgentStart();
    expect(prompt).toContain("⚠ changed: +3 added");
    expect(prompt).toContain("- in_progress: Build the todo state manager");
  });

  it("orchestrator_audit (dag_id) triggers auto-plan from the fixture DAG", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({ toolName: "orchestrator_audit", input: { dag_id: "GC-2026-060" } });
    expect(loadTodoState(todoStateDir(tmp))?.getTodos()).toEqual(EXPECTED_DERIVED);
  });

  it("dag_synthesize without dag_id/goal_id falls back to the newest dag-*.yaml glob", async () => {
    registerSagesExtension(mock as any);
    await fireToolCall({ toolName: "dag_synthesize", input: {} });
    expect(loadTodoState(todoStateDir(tmp))?.getTodos()).toEqual(EXPECTED_DERIVED);
  });

  it("auto-plan is a no-op when no DAG exists (never wipes the current list)", async () => {
    registerSagesExtension(mock as any);
    // Seed the list with a manual todo.
    await fireToolCall({
      toolName: "sages_todo",
      input: { action: "sync", todos: [{ content: "manual ad-hoc todo", status: "pending" }] },
    });
    // Unknown dag_id → deriveDagTodos returns [] → list untouched.
    await fireToolCall({ toolName: "dag_synthesize", input: { goal_id: "GC-9999" } });
    expect(loadTodoState(todoStateDir(tmp))?.getTodos()).toEqual([
      { content: "manual ad-hoc todo", status: "pending" },
    ]);
  });
});

// ─── existing soft-mode handlers stay intact ────────────────────────────────

describe("todo extension — existing soft-mode handlers keep working", () => {
  it("bash write-intent still appends the soft-mode reminder exactly once per session", async () => {
    registerSagesExtension(mock as any);
    const bashHandler = mock.handlers.tool_call?.[0];
    expect(bashHandler).toBeDefined();

    await bashHandler({ toolName: "bash", input: { command: "echo x > src/foo.ts" } }, { cwd: tmp });
    await bashHandler({ toolName: "bash", input: { command: "sed -i s/a/b/ src/bar.ts" } }, { cwd: tmp });

    const softModeReminders = mock.appendedEntries.filter(
      (e) => e.channel === "system" && e.text === SOFT_MODE_REMINDER,
    );
    expect(softModeReminders).toHaveLength(1);
  });

  it("before_agent_start still injects the soft-mode system-prompt suffix", async () => {
    registerSagesExtension(mock as any);
    const prompt = await beforeAgentStart();
    expect(prompt).toContain("BASE");
    expect(prompt).toContain(SOFT_MODE_SYSTEM_PROMPT_SUFFIX.trim());
  });

  it("registers sages_todo alongside the orchestrator tools + sages_reminder", () => {
    registerSagesExtension(mock as any);
    const names = mock.registeredTools.map((t) => t.name).sort();
    expect(names).toContain("sages_todo");
    expect(names).toEqual([
      "dag_synthesize",
      "goal_contract_create",
      "orchestrator_audit",
      "sages_reminder",
      "sages_todo",
      "task_dispatch",
    ]);
  });
});

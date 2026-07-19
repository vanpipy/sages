/**
 * LuBan Tools Tests — Single-tool surface
 *
 * Per the simplify-actions principle:
 *   - luban_execute_task: single task with observe cycle (RED → GREEN → REFACTOR → complete).
 *     The LLM reads execution.yaml directly via semantic tools to plan iteration order.
 *
 * The LLM does the actual implementation work via semantic tools
 * (serena_replace_symbol_body, etc.). LuBan only validates test outcomes.
 *
 * Removed: luban_run_batch (planner; LLM reads execution.yaml directly),
 *          luban_get_status (status returned in every execute_task response).
 * Deprecated stubs for luban_run_batch, luban_get_status, luban_execute_all,
 * luban_execute_batch return isError with redirect hint to luban_execute_task.
 *
 * Removed: template stub generators (generateSourceTemplate, the
 * "export function xxx() { return {} }" GREEN-phase filler). The LLM
 * writes real implementations via semantic tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// pi stub — tools captured at register time, cwd flows through at call time
// ---------------------------------------------------------------------------

type ToolFn = (params: any, cwd: string) => Promise<any>;

function makePiStub() {
  const tools = new Map<string, { cfg: any; fn: ToolFn }>();
  return {
    tools,
    registerTool(cfg: any) {
      tools.set(cfg.name, {
        cfg,
        fn: async (params: any, cwd: string) =>
          cfg.execute("call-id", params, undefined, undefined, { cwd }),
      });
    },
    async call(name: string, params: any, cwd: string) {
      const t = tools.get(name);
      if (!t) throw new Error(`tool not registered: ${name}`);
      return await t.fn(params, cwd);
    },
  };
}

const tmpDir = (suffix: string) =>
  join("/tmp", `sages-luban-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// Reliable pass/fail commands for testing runTests outcome detection.
//   - FAIL_CMD: always exits 1 (used in init/RED phase)
//   - PASS_CMD: always exits 0 (used when test should pass)
//   - STATEFUL_CMD: passes iff src/x.ts exists — lets us simulate LLM
//     doing real work (creating the source file) between phases
const FAIL_CMD = "false";
const PASS_CMD = "true";
const STATEFUL_CMD = "sh -c '[ -f src/x.ts ] && echo PASS || (echo FAIL; false)'";

// ---------------------------------------------------------------------------
// luban_execute_task — observe cycle (RED → GREEN → REFACTOR → complete)
// ---------------------------------------------------------------------------

describe("luban_execute_task", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("exec");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    mkdirSync(join(cwd, "src"), { recursive: true });
    const { registerLubanTools } = await import("../../../src/tools/luban/index.js");
    pi = makePiStub();
    registerLubanTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  describe("init (no observation)", () => {
    it("first call returns RED contract with status/intent/validation", async () => {
      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "implement add(a,b)",
          files: ["src/math/add.ts"],
          test_files: ["src/math/add.test.ts"],
          test_command: "bun test src/math/add.test.ts",
        },
        cwd,
      );

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("RED");
      expect(payload.intent).toBeDefined();
      expect(payload.intent.toLowerCase()).toContain("test");
      expect(payload.validation).toBeDefined();
      expect(payload.validation.test_command).toBe("bun test src/math/add.test.ts");
      expect(payload.validation.expected_outcome).toBe("fail");
      expect(payload.validation.files_required).toContain("src/math/add.test.ts");
    });

    it("persists task state to .sages/workspace/.luban-task-state.json", async () => {
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/x.ts"],
          test_files: ["src/x.test.ts"],
          test_command: PASS_CMD,
        },
        cwd,
      );

      const statePath = join(cwd, ".sages/workspace/.luban-task-state.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state["T1"]).toBeDefined();
      expect(state["T1"].current_phase).toBe("RED");
    });

    it("does NOT write template stub files (semantic-tool design)", async () => {
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/x.ts"],
          test_files: ["src/x.test.ts"],
          test_command: PASS_CMD,
        },
        cwd,
      );

      // The implementation file should NOT exist yet — the LLM writes it.
      expect(existsSync(join(cwd, "src/x.ts"))).toBe(false);
    });
  });

  describe("RED phase observation", () => {
    it("observation {test_outcome: 'fail'} advances to GREEN", async () => {
      // Init
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/x.ts"],
          test_files: ["src/x.test.ts"],
          test_command: FAIL_CMD,
        },
        cwd,
      );

      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "RED", test_outcome: "fail" },
        },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("GREEN");
      expect(payload.auto_advanced).toBe(true);
      expect(payload.intent.toLowerCase()).toContain("pass");
      expect(payload.validation.expected_outcome).toBe("pass");
    });

    it("observation {test_outcome: 'pass'} is rejected (RED must fail)", async () => {
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/x.ts"],
          test_files: ["src/x.test.ts"],
          test_command: PASS_CMD,
        },
        cwd,
      );

      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "RED", test_outcome: "pass" },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("RED");
      expect(payload.error.toLowerCase()).toContain("fail");
    });
  });

  describe("GREEN phase observation", () => {
    async function initAndCompleteRed() {
      // Use STATEFUL_CMD: passes iff src/x.ts exists. This lets us simulate
      // the LLM's GREEN-phase work (creating the source file) between phases.
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/x.ts"],
          test_files: ["src/x.test.ts"],
          test_command: STATEFUL_CMD,
        },
        cwd,
      );
      // Simulate LLM writing the test file (RED work).
      writeFileSync(join(cwd, "src/x.test.ts"), "// test scaffold");
      // src/x.ts doesn't exist yet → STATEFUL_CMD exits 1 → RED validates fail.
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "RED", test_outcome: "fail" },
        },
        cwd,
      );
    }

    it("observation {test_outcome: 'pass'} advances to REFACTOR", async () => {
      await initAndCompleteRed();

      // Simulate LLM writing the source file (GREEN work) — STATEFUL_CMD now passes.
      writeFileSync(join(cwd, "src/x.ts"), "export const x = 1;");

      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "GREEN", test_outcome: "pass" },
        },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("REFACTOR");
      expect(payload.auto_advanced).toBe(true);
      expect(payload.validation.expected_outcome).toBe("pass");
    });

    it("observation {test_outcome: 'fail'} is rejected (GREEN must pass)", async () => {
      await initAndCompleteRed();

      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "GREEN", test_outcome: "fail" },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("GREEN");
    });
  });

  describe("REFACTOR phase observation", () => {
    async function runToRefactor() {
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/x.ts"],
          test_files: ["src/x.test.ts"],
          test_command: STATEFUL_CMD,
        },
        cwd,
      );
      writeFileSync(join(cwd, "src/x.test.ts"), "// test scaffold");
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "RED", test_outcome: "fail" },
        },
        cwd,
      );
      writeFileSync(join(cwd, "src/x.ts"), "export const x = 1;");
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "GREEN", test_outcome: "pass" },
        },
        cwd,
      );
    }

    it("observation {test_outcome: 'pass'} returns complete", async () => {
      await runToRefactor();

      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "REFACTOR", test_outcome: "pass" },
        },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("complete");
      expect(payload.phases).toEqual(["RED", "GREEN", "REFACTOR"]);
    });

    it("observation {test_outcome: 'fail'} is rejected (REFACTOR must keep tests passing)", async () => {
      await runToRefactor();

      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "REFACTOR", test_outcome: "fail" },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("REFACTOR");
    });
  });

  describe("error handling", () => {
    it("observation without prior init returns error", async () => {
      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T_UNINIT",
          observation: { phase: "RED", test_outcome: "fail" },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("not");
    });

    it("scope guard: denyFiles rejects matching source files", async () => {
      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/forbidden.ts"],
          test_files: [],
          test_command: PASS_CMD,
          deny_files: ["src/forbidden.ts"],
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("scope");
    });

    it("observation with wrong phase is rejected", async () => {
      await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          task_description: "x",
          files: ["src/x.ts"],
          test_files: ["src/x.test.ts"],
          test_command: FAIL_CMD,
        },
        cwd,
      );

      // Currently in RED. Try to submit GREEN observation directly.
      const result = await pi.call(
        "luban_execute_task",
        {
          task_id: "T1",
          observation: { phase: "GREEN", test_outcome: "pass" },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toMatch(/phase|expected/);
    });
  });
});

// ---------------------------------------------------------------------------
// Deprecated stubs — every old luban_* name returns isError with a redirect hint
// pointing to luban_execute_task.
// ---------------------------------------------------------------------------

describe("deprecated LuBan stubs", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("deprecated");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    const { registerLubanTools } = await import("../../../src/tools/luban/index.js");
    pi = makePiStub();
    registerLubanTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  const DEPRECATED = [
    "luban_execute_all",
    "luban_execute_batch",
    "luban_get_status",
  ];

  for (const name of DEPRECATED) {
    it(`${name} returns isError with redirect hint to luban_execute_task`, async () => {
      const result = await pi.call(name, { plan_name: "x" }, cwd);
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("deprecated");
      expect(payload.hint).toBeDefined();
      expect(payload.hint).toContain("luban_execute_task");
    });
  }
});

// ---------------------------------------------------------------------------
// Template stub removal — verified by behavior in the main describe block:
//   "does NOT write template stub files (semantic-tool design)"
// The first call to luban_execute_task must not auto-create source files
// with `return {}` template stubs — the LLM writes real implementations
// via serena_replace_symbol_body / serena_create_text_file.
// ---------------------------------------------------------------------------
/**
 * GaoYao Tools Tests — Simplified Surface
 *
 * Tests the 3-tool surface per the simplify-actions principle:
 *   - gaoyao_audit    (init / resume / reset / status — all in one)
 *   - gaoyao_observe  (file_read + finding, with auto-advance)
 *   - gaoyao_finalize (unchanged)
 *
 * Each tool returns the contract shape: {status, intent, validation}.
 * Phases auto-advance when their requirements are met — the LLM never
 * has to call a separate "advance phase" tool.
 *
 * Deprecated stubs (gaoyao_init, gaoyao_record_file_read,
 * gaoyao_record_finding, gaoyao_execute_phase, gaoyao_status,
 * gaoyao_reset) return isError with a redirect hint to the new tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

// bun:test doesn't have it.each; iterate manually in a for-loop.
function forEach<T>(items: T[], body: (item: T) => void) {
  for (const item of items) body(item);
}

// ---------------------------------------------------------------------------
// pi stub — captures tools at register time; cwd flows through at call time
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

const tmpDir = (suffix: string) => join("/tmp", `sages-gaoyao-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// ---------------------------------------------------------------------------
// gaoyao_audit: unified init / resume / reset / status
// ---------------------------------------------------------------------------

describe("gaoyao_audit", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("audit");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    const { registerGaoYaoTools } = await import("../../../src/tools/gaoyao/index.js");
    pi = makePiStub();
    registerGaoYaoTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  describe("fresh session", () => {
    it("creates a session in ENUMERATE phase and returns the audit contract", async () => {
      const result = await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("ENUMERATE");
      expect(payload.intent).toBeDefined();
      expect(typeof payload.intent).toBe("string");
      expect(payload.validation).toBeDefined();
      expect(payload.validation.files_required).toBe(5);
      expect(payload.session_id).toBeDefined();
    });

    it("writes a session file to .sages/workspace/.gaoyao-session.json", async () => {
      await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);

      const sessionPath = join(cwd, ".sages/workspace/.gaoyao-session.json");
      expect(existsSync(sessionPath)).toBe(true);
      const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
      expect(session.phase).toBe("ENUMERATE");
    });
  });

  describe("resume existing session", () => {
    it("returns current state with phase guidance without re-initializing", async () => {
      const first = await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
      const firstSessionId = JSON.parse(first.content[0].text).session_id;

      const second = await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
      const payload = JSON.parse(second.content[0].text);

      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("ENUMERATE");
      expect(payload.resumed).toBe(true);
      expect(payload.session_id).toBe(firstSessionId); // same session
    });

    it("does not require reset flag when session exists", async () => {
      await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
      // Second call without reset should NOT throw
      const result = await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
      expect(result.isError).toBeFalsy();
    });
  });

  describe("reset flag", () => {
    it("with reset:true clears existing session and starts fresh", async () => {
      const first = await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
      const firstId = JSON.parse(first.content[0].text).session_id;

      const second = await pi.call("gaoyao_audit", { plan_name: "x", reset: true }, cwd);
      const secondId = JSON.parse(second.content[0].text).session_id;

      expect(secondId).not.toBe(firstId);
    });

    it("with reset:true on no existing session starts fresh (no error)", async () => {
      const result = await pi.call("gaoyao_audit", { plan_name: "x", reset: true }, cwd);
      expect(result.isError).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// gaoyao_observe: unified file_read + finding with auto-advance
// ---------------------------------------------------------------------------

describe("gaoyao_observe", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("observe");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    const { registerGaoYaoTools } = await import("../../../src/tools/gaoyao/index.js");
    pi = makePiStub();
    registerGaoYaoTools(pi as any);
    await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  async function advanceToInk() {
    for (let i = 1; i <= 5; i++) {
      await pi.call("gaoyao_observe", { file_read: { path: `src/file${i}.ts`, lines: 50 } }, cwd);
    }
  }

  describe("file_read", () => {
    it("records a file read and returns updated progress", async () => {
      const result = await pi.call(
        "gaoyao_observe",
        { file_read: { path: "src/foo.ts", lines: 100 } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("ENUMERATE");
      expect(payload.files_read).toBe(1);
      expect(payload.files_required).toBe(5);
      expect(payload.auto_advanced).toBe(false);
    });

    it("auto-advances to INK after 5 file reads", async () => {
      await advanceToInk();

      // The 5th call already auto-advanced. Check session state via a resume call.
      const status = await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
      const payload = JSON.parse(status.content[0].text);
      expect(payload.phase).toBe("INK");
      expect(payload.intent).toBeDefined();
      expect(payload.validation.category_required).toBe("ink");
    });
  });

  describe("finding", () => {
    it("rejects finding when current phase is ENUMERATE (no findings allowed)", async () => {
      // Submit a finding during ENUMERATE — should fail because ENUMERATE has no category
      const result = await pi.call(
        "gaoyao_observe",
        {
          finding: {
            category: "ink",
            severity: "minor",
            file: "src/foo.ts",
            line: 1,
            issue: "test",
            recommendation: "fix",
          },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("category");
    });

    it("rejects finding with wrong category for current phase", async () => {
      await advanceToInk();
      const result = await pi.call(
        "gaoyao_observe",
        {
          finding: {
            category: "death",
            severity: "minor",
            file: "src/file1.ts",
            line: 1,
            issue: "wrong category for INK phase",
            recommendation: "fix",
          },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("Invalid category");
    });

    it("accepts finding matching current phase category", async () => {
      await advanceToInk();
      const result = await pi.call(
        "gaoyao_observe",
        {
          finding: {
            category: "ink",
            severity: "minor",
            file: "src/file1.ts",
            line: 10,
            issue: "function too long",
            recommendation: "split into helpers",
          },
        },
        cwd,
      );

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.findings_recorded).toBe(1);
    });

    it("rejects finding for a file not yet read", async () => {
      await advanceToInk();
      const result = await pi.call(
        "gaoyao_observe",
        {
          finding: {
            category: "ink",
            severity: "minor",
            file: "src/NOT_READ.ts",
            line: 1,
            issue: "finding for unread file",
            recommendation: "fix",
          },
        },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("not been read");
    });

    it("auto-advances to NOSE after first INK finding (>=1 finding rule)", async () => {
      await advanceToInk();
      const result = await pi.call(
        "gaoyao_observe",
        {
          finding: {
            category: "ink",
            severity: "minor",
            file: "src/file1.ts",
            line: 10,
            issue: "function too long",
            recommendation: "split",
          },
        },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.auto_advanced).toBe(true);
      expect(payload.phase).toBe("NOSE");
      expect(payload.validation.category_required).toBe("nose");
    });
  });

  describe("requires existing session", () => {
    it("returns error when called without a session", async () => {
      const freshDir = tmpDir("no-session");
      mkdirSync(join(freshDir, ".sages/workspace"), { recursive: true });

      // Don't init — call directly
      const localPi = makePiStub();
      const { registerGaoYaoTools } = await import("../../../src/tools/gaoyao/index.js");
      registerGaoYaoTools(localPi as any);

      const result = await localPi.call(
        "gaoyao_observe",
        { file_read: { path: "src/foo.ts", lines: 10 } },
        freshDir,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("session");

      rmSync(freshDir, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// gaoyao_finalize (mostly unchanged)
// ---------------------------------------------------------------------------

describe("gaoyao_finalize", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("finalize");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    const { registerGaoYaoTools } = await import("../../../src/tools/gaoyao/index.js");
    pi = makePiStub();
    registerGaoYaoTools(pi as any);
    await pi.call("gaoyao_audit", { plan_name: "x" }, cwd);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects when not in FINAL phase", async () => {
    const result = await pi.call("gaoyao_finalize", {}, cwd);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deprecated stubs return isError with redirect hint
// ---------------------------------------------------------------------------

describe("deprecated GaoYao stubs", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("deprecated");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    const { registerGaoYaoTools } = await import("../../../src/tools/gaoyao/index.js");
    pi = makePiStub();
    registerGaoYaoTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  const DEPRECATED_TOOLS = [
    "gaoyao_init",
    "gaoyao_record_file_read",
    "gaoyao_record_finding",
    "gaoyao_execute_phase",
    "gaoyao_status",
    "gaoyao_reset",
  ];
  forEach(DEPRECATED_TOOLS, (toolName) => {
    it(`${toolName} returns isError with redirect hint`, async () => {
      const params = toolName === "gaoyao_reset" ? { confirm: true } : {};
      const result = await pi.call(toolName, params, cwd);

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("deprecated");
      expect(payload.hint).toBeDefined();
    });
  });
});
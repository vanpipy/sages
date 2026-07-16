/**
 * Fuxi Tools Tests — Simplified 3-tool surface
 *
 * Per the simplify-actions principle:
 *   - fuxi_start: initialize workflow (state.json)
 *   - fuxi_design: observe cycle through design → review → plan
 *   - fuxi_end: verdict-driven end (PASS/NEEDS_CHANGES/REJECTED)
 *
 * Status returned in every response. No separate status tool.
 *
 * Deprecated stubs (6): fuxi_request, fuxi_plan, fuxi_recover,
 * fuxi_get_status, fuxi_update_score, fuxi_brainstorm_recovery.
 * All return isError with redirect hint to the new 3-tool surface.
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
  join("/tmp", `sages-fuxi-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// ---------------------------------------------------------------------------
// fuxi_start
// ---------------------------------------------------------------------------

describe("fuxi_start", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("start");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    mkdirSync(join(cwd, ".sages/sessions"), { recursive: true });
    const { registerFuxiTools } = await import("../../src/tools/fuxi-tools.js");
    pi = makePiStub();
    registerFuxiTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("initializes a new workflow and returns a design contract", async () => {
    const result = await pi.call(
      "fuxi_start",
      { plan_name: "test-plan", request: "implement feature X" },
      cwd,
    );

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("in_progress");
    expect(payload.phase).toBe("design");
    expect(payload.intent).toBeDefined();
    expect(payload.validation).toBeDefined();
    expect(payload.workflow_id).toBeDefined();
    expect(payload.plan_name).toBe("test-plan");
  });

  it("persists state.json to .sages/workspace/", async () => {
    await pi.call("fuxi_start", { plan_name: "test-plan", request: "implement feature X" }, cwd);

    const statePath = join(cwd, ".sages/workspace/state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.planName).toBe("test-plan");
    expect(state.request).toBe("implement feature X");
  });
});

// ---------------------------------------------------------------------------
// fuxi_design — observe cycle (design → review → plan)
// ---------------------------------------------------------------------------

describe("fuxi_design", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("design");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    mkdirSync(join(cwd, ".sages/sessions"), { recursive: true });
    const { registerFuxiTools } = await import("../../src/tools/fuxi-tools.js");
    pi = makePiStub();
    registerFuxiTools(pi as any);
    await pi.call("fuxi_start", { plan_name: "x", request: "y" }, cwd);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("first call returns design contract", async () => {
    const result = await pi.call("fuxi_design", {}, cwd);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("in_progress");
    expect(payload.phase).toBe("design");
    expect(payload.intent.toLowerCase()).toContain("draft");
    expect(payload.validation).toBeDefined();
    expect(payload.validation.file).toBe("draft.md");
    expect(payload.validation.min_size).toBeGreaterThan(0);
  });

  describe("design → review", () => {
    it("observation {draft_written: true, draft_path} advances to review", async () => {
      // Write a real draft.md (size > 500 bytes)
      const draftContent = "x".repeat(600);
      writeFileSync(join(cwd, ".sages/workspace/draft.md"), draftContent);

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("review");
      expect(payload.auto_advanced).toBe(true);
    });

    it("observation {draft_written: true} with missing draft.md is rejected", async () => {
      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toMatch(/draft|file/);
    });

    it("observation with too-small draft.md is rejected (min_size)", async () => {
      writeFileSync(join(cwd, ".sages/workspace/draft.md"), "tiny");

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toMatch(/size|small|bytes/);
    });
  });

  describe("review → plan", () => {
    async function advanceToReview() {
      writeFileSync(join(cwd, ".sages/workspace/draft.md"), "x".repeat(600));
      await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );
    }

    it("observation {score: 85} advances to plan", async () => {
      await advanceToReview();

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "review", score: 85 } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("plan");
      expect(payload.auto_advanced).toBe(true);
    });

    it("observation {score: 80} advances to plan (boundary, >= 80 passes)", async () => {
      await advanceToReview();

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "review", score: 80 } },
        cwd,
      );

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.phase).toBe("plan");
      expect(payload.auto_advanced).toBe(true);
    });

    it("observation {score: 50} is rejected (too low)", async () => {
      await advanceToReview();

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "review", score: 50 } },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("score");
    });
  });

  describe("error handling", () => {
    it("observation without prior init returns error", async () => {
      const freshDir = tmpDir("nofuxi");
      mkdirSync(join(freshDir, ".sages/workspace"), { recursive: true });
      mkdirSync(join(freshDir, ".sages/sessions"), { recursive: true });

      const localPi = makePiStub();
      const { registerFuxiTools } = await import("../../src/tools/fuxi-tools.js");
      registerFuxiTools(localPi as any);

      const result = await localPi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        freshDir,
      );

      expect(result.isError).toBe(true);

      rmSync(freshDir, { recursive: true, force: true });
    });

    it("observation with wrong phase is rejected", async () => {
      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "review", score: 85 } }, // expecting "design"
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toMatch(/phase|expected/);
    });
  });
});

// ---------------------------------------------------------------------------
// fuxi_end
// ---------------------------------------------------------------------------

describe("fuxi_end", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("end");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    mkdirSync(join(cwd, ".sages/sessions"), { recursive: true });
    mkdirSync(join(cwd, ".sages/archive"), { recursive: true });
    const { registerFuxiTools } = await import("../../src/tools/fuxi-tools.js");
    pi = makePiStub();
    registerFuxiTools(pi as any);
    await pi.call("fuxi_start", { plan_name: "x", request: "y" }, cwd);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("without audit.md returns error", async () => {
    const result = await pi.call("fuxi_end", {}, cwd);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.toLowerCase()).toContain("audit");
  });

  it("observation {verdict: PASS} archives and returns complete", async () => {
    // Write a minimal audit.md with PASS verdict
    const auditContent = `# Audit\n\n**Verdict**: PASS (95%)\n`;
    writeFileSync(join(cwd, ".sages/workspace/audit.md"), auditContent);

    const result = await pi.call(
      "fuxi_end",
      { observation: { verdict: "PASS" } },
      cwd,
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("complete");
    expect(payload.verdict).toBe("PASS");
    expect(payload.archive_path).toBeDefined();
  });

  it("observation {verdict: NEEDS_CHANGES} returns implement-phase routing", async () => {
    const auditContent = `# Audit\n\n**Verdict**: NEEDS_CHANGES (60%)\n`;
    writeFileSync(join(cwd, ".sages/workspace/audit.md"), auditContent);

    const result = await pi.call(
      "fuxi_end",
      { observation: { verdict: "NEEDS_CHANGES" } },
      cwd,
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("in_progress");
    expect(payload.phase).toBe("implement");
    expect(payload.intent.toLowerCase()).toContain("fix");
  });

  it("observation {verdict: REJECTED} returns design-phase routing", async () => {
    const auditContent = `# Audit\n\n**Verdict**: REJECTED (30%)\n`;
    writeFileSync(join(cwd, ".sages/workspace/audit.md"), auditContent);

    const result = await pi.call(
      "fuxi_end",
      { observation: { verdict: "REJECTED" } },
      cwd,
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("in_progress");
    expect(payload.phase).toBe("design");
  });
});

// ---------------------------------------------------------------------------
// Deprecated stubs return isError with redirect hint
// ---------------------------------------------------------------------------

describe("deprecated Fuxi stubs", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("deprecated");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    mkdirSync(join(cwd, ".sages/sessions"), { recursive: true });
    const { registerFuxiTools } = await import("../../src/tools/fuxi-tools.js");
    pi = makePiStub();
    registerFuxiTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  const DEPRECATED = [
    "fuxi_request",
    "fuxi_plan",
    "fuxi_recover",
    "fuxi_get_status",
    "fuxi_update_score",
    "fuxi_brainstorm_recovery",
  ];

  for (const toolName of DEPRECATED) {
    it(`${toolName} returns isError with redirect hint`, async () => {
      const result = await pi.call(toolName, {}, cwd);
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("deprecated");
      expect(payload.hint).toBeDefined();
    });
  }
});
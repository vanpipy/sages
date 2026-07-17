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

  describe("tier-aware design (Scope section)", () => {
    const draftWithScope = (tier: string, inScope: string[], bodyBytes: number) => {
      const scopeLines = [
        "## Scope",
        `- Tier: ${tier}`,
        `- In scope: [${inScope.join(", ")}]`,
      ];
      // Total length = scopeLines.join("\n").length + 1 (separator) + padding.length
      const padding = "x".repeat(
        Math.max(0, bodyBytes - scopeLines.join("\n").length - 1),
      );
      return scopeLines.join("\n") + "\n" + padding;
    };

    it("trivial tier accepts a 100-byte draft and reports tier in validation", async () => {
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope("trivial", ["Foundation"], 100),
      );

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.phase).toBe("review");
      expect(payload.auto_advanced).toBe(true);
      expect(payload.tier).toBe("trivial");
      expect(payload.scope_aware).toBe(true);
    });

    it("trivial tier rejects a 50-byte draft (under tier min_size)", async () => {
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope("trivial", ["Foundation"], 50),
      );

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toMatch(/too small/);
      expect(result.details.tier).toBe("trivial");
      expect(result.details.scope_driven).toBe(true);
    });

    it("simple tier accepts a 250-byte draft and advances to review", async () => {
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope("simple", ["Foundation", "Business", "Evolution"], 250),
      );
      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );
      expect(JSON.parse(result.content[0].text).phase).toBe("review");
      expect(result.isError).toBeFalsy();
    });

    it("simple tier rejects a 100-byte draft (under tier min_size)", async () => {
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope("simple", ["Foundation", "Business", "Evolution"], 100),
      );
      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );
      expect(result.isError).toBe(true);
      expect(result.details.tier).toBe("simple");
    });

    it("standard tier accepts a 500-byte draft and advances to review", async () => {
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope(
          "standard",
          ["Business", "Data", "Control", "Foundation", "Observation", "Security", "Evolution"],
          500,
        ),
      );
      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );
      expect(JSON.parse(result.content[0].text).phase).toBe("review");
      expect(result.isError).toBeFalsy();
    });

    it("standard tier rejects a 400-byte draft (under tier min_size)", async () => {
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope(
          "standard",
          ["Business", "Data", "Control", "Foundation", "Observation", "Security", "Evolution"],
          400,
        ),
      );
      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );
      expect(result.isError).toBe(true);
      expect(result.details.tier).toBe("standard");
    });

    it("no Scope section uses legacy 500-byte minimum", async () => {
      // 300-byte draft with no Scope section — fails (legacy needs 500)
      writeFileSync(join(cwd, ".sages/workspace/draft.md"), "x".repeat(300));
      let result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );
      expect(result.isError).toBe(true);
      expect(result.details.scope_driven).toBe(false);
      expect(result.details.min_size).toBe(500);

      // 600-byte draft with no Scope section — passes (legacy)
      writeFileSync(join(cwd, ".sages/workspace/draft.md"), "x".repeat(600));
      result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );
      const payload = JSON.parse(result.content[0].text);
      expect(payload.phase).toBe("review");
      expect(payload.tier).toBeNull();
      expect(payload.scope_aware).toBe(false);
    });

    it("emits tier_warning when tier band doesn't match plane count", async () => {
      // trivial tier with 2 in-scope planes — should be 'simple'
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope("trivial", ["Foundation", "Business"], 200),
      );

      const result = await pi.call(
        "fuxi_design",
        { observation: { phase: "design", draft_path: "draft.md" } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.phase).toBe("review"); // still advances — warning is soft
      expect(payload.tier_warning).toContain("Tier 'trivial'");
    });

    it("init (no observation) reports tier-aware validation block when Scope present", async () => {
      writeFileSync(
        join(cwd, ".sages/workspace/draft.md"),
        draftWithScope("simple", ["Foundation", "Business", "Evolution"], 250),
      );

      const result = await pi.call("fuxi_design", {}, cwd);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.validation.min_size).toBe(250);
      expect(payload.validation.tier).toBe("simple");
      expect(payload.validation.in_scope_planes).toEqual([
        "Foundation",
        "Business",
        "Evolution",
      ]);
      expect(payload.validation.legacy_min_size).toBe(500);
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
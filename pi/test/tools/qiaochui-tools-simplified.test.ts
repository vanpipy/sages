/**
 * QiaoChui Tools Tests — Auto-write score behavior
 *
 * The simplify-actions principle requires the sage tool to persist the
 * outcome of semantic work. qiaochui_review used to return the score
 * but require the LLM to call fuxi_update_score separately — fragile.
 *
 * New behavior: qiaochui_review accepts an optional `observation` with
 * the LLM's final score and writes it directly to state.json. Returns
 * verdict (APPROVED/REVISE/REJECTED) and `can_start_plan` flag.
 *
 * Without observation: returns heuristic hints + semantic-tool guidance
 * for the LLM to use.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  join("/tmp", `sages-qiaochui-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// ---------------------------------------------------------------------------
// qiaochui_review — auto-write score on observation
// ---------------------------------------------------------------------------

describe("qiaochui_review", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("review");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    // Write a draft.md so the tool can find it
    const draft = "# System Design\n\n## Business Plane\n\nDetailed content for testing.\n".padEnd(800, "x");
    writeFileSync(join(cwd, ".sages/workspace/draft.md"), draft);
    const { registerQiaoChuiTools } = await import("../../src/tools/qiaochui/index.js");
    pi = makePiStub();
    registerQiaoChuiTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  describe("without observation (heuristic + guidance)", () => {
    it("returns heuristic hints + semantic-tool guidance", async () => {
      const result = await pi.call("qiaochui_review", {}, cwd);

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("in_progress");
      expect(payload.intent).toBeDefined();
      expect(payload.intent.toLowerCase()).toContain("review");
      expect(payload.validation).toBeDefined();
      expect(payload.validation.dimensions).toBeDefined();
      expect(payload.validation.pass_threshold).toBe(80);
      expect(payload.heuristic_hints).toBeDefined();
    });

    it("does NOT auto-write score when called without observation", async () => {
      await pi.call("qiaochui_review", {}, cwd);

      const statePath = join(cwd, ".sages/workspace/state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(state.score).toBeUndefined();
      }
    });
  });

  describe("with observation (LLM-provided score)", () => {
    it("observation {score: 85} persists to state.json and returns APPROVED", async () => {
      const result = await pi.call(
        "qiaochui_review",
        { observation: { score: 85, notes: "Looks solid." } },
        cwd,
      );

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("complete");
      expect(payload.score).toBe(85);
      expect(payload.verdict).toBe("APPROVED");
      expect(payload.can_start_plan).toBe(true);

      // Verify persistence
      const statePath = join(cwd, ".sages/workspace/state.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.score).toBe(85);
    });

    it("observation {score: 60} returns REVISE (below 80 threshold)", async () => {
      const result = await pi.call(
        "qiaochui_review",
        { observation: { score: 60 } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.verdict).toBe("REVISE");
      expect(payload.can_start_plan).toBe(false);
    });

    it("observation {score: 30} returns REJECTED", async () => {
      const result = await pi.call(
        "qiaochui_review",
        { observation: { score: 30 } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.verdict).toBe("REJECTED");
      expect(payload.can_start_plan).toBe(false);
    });

    it("observation {score: 80} is APPROVED (consistent with decompose > 80)", async () => {
      const result = await pi.call(
        "qiaochui_review",
        { observation: { score: 80 } },
        cwd,
      );

      const payload = JSON.parse(result.content[0].text);
      expect(payload.verdict).toBe("APPROVED");
      expect(payload.can_start_plan).toBe(true);
    });

    it("observation {score: -5} is rejected (out of range)", async () => {
      const result = await pi.call(
        "qiaochui_review",
        { observation: { score: -5 } },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("range");
    });

    it("observation {score: 150} is rejected (out of range)", async () => {
      const result = await pi.call(
        "qiaochui_review",
        { observation: { score: 150 } },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("range");
    });

    it("observation without score field is rejected", async () => {
      const result = await pi.call(
        "qiaochui_review",
        { observation: { notes: "no score" } },
        cwd,
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("score");
    });

    it("missing draft.md returns error", async () => {
      rmSync(join(cwd, ".sages/workspace/draft.md"));

      const result = await pi.call("qiaochui_review", {}, cwd);

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error.toLowerCase()).toContain("draft");
    });
  });
});

// ---------------------------------------------------------------------------
// qiaochui_decompose — reads score from state.json (auto-written by review)
// ---------------------------------------------------------------------------

describe("qiaochui_decompose", () => {
  let cwd: string;
  let pi: ReturnType<typeof makePiStub>;

  beforeEach(async () => {
    cwd = tmpDir("decompose");
    mkdirSync(join(cwd, ".sages/workspace"), { recursive: true });
    const draft = "# System Design\n\n## Business\n".padEnd(800, "x");
    writeFileSync(join(cwd, ".sages/workspace/draft.md"), draft);
    const { registerQiaoChuiTools } = await import("../../src/tools/qiaochui/index.js");
    pi = makePiStub();
    registerQiaoChuiTools(pi as any);
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("with state.score > 80 (auto-written by qiaochui_review) returns plan + execution.yaml", async () => {
    // First: review with score 85 (auto-writes to state.json)
    await pi.call(
      "qiaochui_review",
      { observation: { score: 85 } },
      cwd,
    );

    // Then: decompose
    const result = await pi.call("qiaochui_decompose", {}, cwd);

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.plan_path).toBeDefined();
    expect(payload.execution_path).toBeDefined();
    expect(payload.task_count).toBeGreaterThan(0);
  });

  it("without prior qiaochui_review (no state.score) is rejected", async () => {
    const result = await pi.call("qiaochui_decompose", {}, cwd);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    // Either "no state" or "no score" message is acceptable.
    expect(payload.error.toLowerCase()).toMatch(/state|score/);
  });

  it("with state.score = 80 (boundary) succeeds", async () => {
    await pi.call(
      "qiaochui_review",
      { observation: { score: 80 } },
      cwd,
    );

    const result = await pi.call("qiaochui_decompose", {}, cwd);

    expect(result.isError).toBeFalsy();
  });

  it("with state.score = 79 (below threshold) is rejected", async () => {
    // Write state.json manually with score 79 to simulate pre-existing state
    writeFileSync(
      join(cwd, ".sages/workspace/state.json"),
      JSON.stringify({ score: 79, phase: "design" }),
    );

    const result = await pi.call("qiaochui_decompose", {}, cwd);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.toLowerCase()).toContain("score");
  });
});
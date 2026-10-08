/**
 * planner-agent.test.ts — Tests for the Planner agent registration
 * (GC-2026-121 AC2/AC6).
 *
 * The Planner subagent is auto-spawned by the unified task-feeder when a user
 * task is created with `kind: "intent"` (no explicit agentType). Its job
 * is to call `decompose_task(user_task_id, specs=[...])` exactly once.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { PLANNER_PROMPT } from "../src/agent-prompts/planner.js";

describe("Planner agent type is registered (GC-2026-121 AC2/AC6)", () => {
  it("registers the Planner agent type in DEFAULT_AGENTS", () => {
    expect(DEFAULT_AGENTS.has("Planner")).toBe(true);
  });

  it("Planner config has the required name + displayName", () => {
    const cfg = DEFAULT_AGENTS.get("Planner");
    expect(cfg).toBeDefined();
    expect(cfg!.name).toBe("Planner");
    expect(cfg!.displayName).toBe("Planner");
  });

  it("Planner systemPrompt is the canonical PLANNER_PROMPT", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    expect(cfg.systemPrompt).toBe(PLANNER_PROMPT);
  });

  it("Planner promptMode is 'replace'", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    expect(cfg.promptMode).toBe("replace");
  });

  it("Planner isDefault is true", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    expect(cfg.isDefault).toBe(true);
  });

  it("Planner excludes pi-subagents (no recursive dispatch)", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    expect(cfg.excludeExtensions).toContain("pi-subagents");
  });

  it("Planner extensions include pi-orchestrator (for decompose_task)", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    // extensions can be `false`, `true`, or array. Planner uses an array.
    expect(Array.isArray(cfg.extensions)).toBe(true);
    expect((cfg.extensions as string[])).toContain("pi-orchestrator");
  });

  it("Planner does NOT include exploration tools (aft / codebase-memory / ctx-search)", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    const exts = cfg.extensions as string[];
    expect(exts).not.toContain("aft-pi");
    expect(exts).not.toContain("codebase-memory");
    expect(exts).not.toContain("ctx-search");
  });

  it("Planner runs in background (does not block parent)", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    expect(cfg.runInBackground).toBe(true);
  });

  it("Planner does NOT inherit parent context (self-contained)", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    expect(cfg.inheritContext).toBe(false);
  });

  it("Planner has at most maxConcurrent=4 (parallel intent tasks)", () => {
    const cfg = DEFAULT_AGENTS.get("Planner")!;
    expect(cfg.maxConcurrent).toBeLessThanOrEqual(4);
    expect(cfg.maxConcurrent).toBeGreaterThanOrEqual(1);
  });
});

describe("PLANNER_PROMPT content (GC-2026-121 AC2)", () => {
  it("declares the role and the decompose_task invocation contract", () => {
    expect(PLANNER_PROMPT).toContain("Planner");
    expect(PLANNER_PROMPT).toContain("decompose_task");
    expect(PLANNER_PROMPT).toContain("user_task_id");
    expect(PLANNER_PROMPT).toContain("specs");
  });

  it("specifies PLANNER_STATUS: BLOCKED for ambiguous intents", () => {
    expect(PLANNER_PROMPT).toContain("PLANNER_STATUS: BLOCKED");
  });

  it("forbids exploration (no AFT / codebase-memory / ctx-search)", () => {
    // The prompt explicitly forbids exploration. Assert on the prohibition
    // language; the tool-family names appear in context "no AFT search" /
    // "no codebase_memory_*" / "no ctx_*" which is the forbidden surface.
    expect(PLANNER_PROMPT).toContain("Do NOT explore the repository");
    expect(PLANNER_PROMPT).toContain("AFT search");
    expect(PLANNER_PROMPT).toContain("codebase_memory_");
    expect(PLANNER_PROMPT).toContain("ctx_");
  });

  it("forbids file modification (no edit / write)", () => {
    expect(PLANNER_PROMPT).toContain("Do NOT modify any files");
  });

  it("forbids multiple decompose_task calls", () => {
    expect(PLANNER_PROMPT).toContain("exactly once");
  });

  it("specifies the spec object shape (subject + description)", () => {
    expect(PLANNER_PROMPT).toContain("subject");
    expect(PLANNER_PROMPT).toContain("description");
  });
});
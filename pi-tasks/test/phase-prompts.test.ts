/**
 * phase-prompts.test.ts — Unit tests for the 4 phase prompt builders.
 *
 * These prompts are sent to subagents when they pick up an Implement /
 * Review / Fix / Merge task. Path B lifts them from path A but rewires the
 * worktree path to be absolute (path A used the literal `<repo>` placeholder
 * which leaked into the agent prompt — see commit 0794246 backstory).
 */

import { describe, expect, test } from "vitest";
import {
  fixPrompt,
  implementPrompt,
  mergePrompt,
  reviewPrompt,
} from "../src/phase-prompts.js";

const goal = {
  id: "GC-TEST-002",
  title: "Refactor cache layer",
  rationale: "Eliminate N+1 lookups",
  scope: { include: ["src/cache/**"], exclude: ["src/legacy/**"] },
  anti_goals: ["Don't touch the public API", "No new deps"],
  done_definition: "All cache reads go through the new LRU wrapper",
};

const findings = [
  { severity: "major" as const, issue: "missing test for eviction", location: "src/cache/lru.ts:88" },
  { severity: "minor" as const, issue: "typecheck warning", location: "src/cache/lru.ts:42" },
];

describe("phase-prompts", () => {
  test("implementPrompt does NOT contain the <repo> literal", () => {
    const prompt = implementPrompt(goal, "/abs/path/to/worktree");
    expect(prompt).not.toContain("<repo>");
  });

  test("implementPrompt embeds the worktree path verbatim", () => {
    const prompt = implementPrompt(goal, "/abs/path/to/worktree");
    expect(prompt).toContain("/abs/path/to/worktree");
    expect(prompt).toContain("Goal: Refactor cache layer");
    expect(prompt).toContain("TDD");
  });

  test("reviewPrompt references the iteration number", () => {
    const prompt = reviewPrompt(goal, 3, "/abs/path/to/worktree", "gc-test-002-implement", "implement");
    expect(prompt).toContain("iteration 3");
    expect(prompt).not.toContain("<repo>");
    expect(prompt).toContain("CLEAN | NEEDS_WORK");
  });

  test("fixPrompt includes each finding (severity + issue + location)", () => {
    const prompt = fixPrompt(goal, 2, "/abs/path/to/worktree", "gc-test-002-implement", findings);
    expect(prompt).not.toContain("<repo>");
    expect(prompt).toContain("Fix iteration 2");
    expect(prompt).toContain("[major]");
    expect(prompt).toContain("missing test for eviction");
    expect(prompt).toContain("src/cache/lru.ts:88");
    expect(prompt).toContain("[minor]");
    expect(prompt).toContain("typecheck warning");
  });

  test("fixPrompt with empty findings still produces a usable prompt", () => {
    const prompt = fixPrompt(goal, 1, "/abs/path/to/worktree", "gc-test-002-implement", []);
    expect(prompt).toContain("Fix iteration 1");
    expect(prompt).not.toContain("<repo>");
  });

  test("mergePrompt references the source branch and the worktree", () => {
    const prompt = mergePrompt(goal, "gc-test-002-implement", "/abs/path/to/worktree");
    expect(prompt).not.toContain("<repo>");
    expect(prompt).toContain("gc-test-002-implement");
    expect(prompt).toContain("/abs/path/to/worktree");
    expect(prompt).toContain("git merge --no-ff");
  });
});

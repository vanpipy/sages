/**
 * commit-conventions-section.test.ts — Pin the Author-derivation strategy
 * into the default Developer + Reviewer configs.
 *
 * The `COMMIT_CONVENTIONS_SECTION` constant carries the fallback chain that
 * makes `git commit` audit-defensible for subagents spawned in detached pi
 * sessions / managed worktrees where `git config user.{name,email}` is empty:
 *
 *   1. try `git config user.{name,email}`
 *   2. fall back to `git log -1 --format='%an%n%ae'`
 *   3. STOP and report FATAL if both are empty (do not invent)
 *
 * Without this guarantee the subagent either fabricates an author (corrupts
 * `git blame`, breaks downstream changelog tooling, fails the audit gate)
 * or fails to commit. The contract is that BOTH default agents carry the
 * section byte-identically, and that the runtime prompt built from the
 * default config contains the section.
 *
 * This test pins:
 *   - `DEFAULT_AGENTS.Developer.systemPrompt` is exactly
 *     `COMMIT_CONVENTIONS_SECTION` (byte-equality, not contains — keeps a
 *     future refactor from accidentally inserting drift).
 *   - `DEFAULT_AGENTS.Reviewer.systemPrompt` is the SAME constant.
 *   - The buildAgentPrompt output for both defaults embeds the Author
 *     derivation block.
 *   - The fallback chain elements (the literal `git log -1 --format='%an%n%ae'`,
 *     the FATAL-on-empty guard, the prohibition on `--author` / `git -c
 *     user.*=...` / `GIT_AUTHOR_*`) are all present.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { COMMIT_CONVENTIONS_SECTION } from "../src/agent-prompts/_sections/commit-conventions.js";
import { buildAgentPrompt } from "../src/prompts.js";
import type { EnvInfo } from "../src/types.js";

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "darwin",
};

beforeEach(() => {
  registerAgents(new Map());
});

describe("commit-conventions section wiring", () => {
  it("Developer default config carries COMMIT_CONVENTIONS_SECTION byte-identically", () => {
    const cfg = DEFAULT_AGENTS.get("Developer");
    expect(cfg, "Developer must be registered in DEFAULT_AGENTS").toBeDefined();
    expect(cfg!.systemPrompt).toBe(COMMIT_CONVENTIONS_SECTION);
  });

  it("Reviewer default config carries COMMIT_CONVENTIONS_SECTION byte-identically", () => {
    const cfg = DEFAULT_AGENTS.get("Reviewer");
    expect(cfg, "Reviewer must be registered in DEFAULT_AGENTS").toBeDefined();
    expect(cfg!.systemPrompt).toBe(COMMIT_CONVENTIONS_SECTION);
  });

  it("Developer and Reviewer share the same section (no drift)", () => {
    expect(DEFAULT_AGENTS.get("Developer")!.systemPrompt).toBe(
      DEFAULT_AGENTS.get("Reviewer")!.systemPrompt,
    );
  });

  it("runtime prompt for Developer contains the Author fallback chain", () => {
    const cfg = getAgentConfig("Developer")!;
    const prompt = buildAgentPrompt(
      cfg,
      "/workspace",
      env,
      "Parent system prompt (orchestrator constitution).",
    );
    // The agent_instructions wrapper holds the section content.
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain(COMMIT_CONVENTIONS_SECTION);
  });

  it("runtime prompt for Reviewer contains the Author fallback chain", () => {
    const cfg = getAgentConfig("Reviewer")!;
    const prompt = buildAgentPrompt(
      cfg,
      "/workspace",
      env,
      "Parent system prompt (orchestrator constitution).",
    );
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain(COMMIT_CONVENTIONS_SECTION);
  });

  it("section explicitly forbids fabricating an author", () => {
    // The strategy is meaningless if its prohibitions are absent — re-pin the
    // forbidden-override list so a future edit cannot drop a line.
    expect(COMMIT_CONVENTIONS_SECTION).toContain(
      "git commit --author=\"Some Name <email@example.com>\"",
    );
    expect(COMMIT_CONVENTIONS_SECTION).toContain(
      "git -c user.name=\"...\" -c user.email=\"...\" commit",
    );
    expect(COMMIT_CONVENTIONS_SECTION).toContain(
      "GIT_AUTHOR_NAME=... GIT_AUTHOR_EMAIL=... git commit",
    );
    expect(COMMIT_CONVENTIONS_SECTION).toContain(
      "Using the LLM's training-data name",
    );
  });

  it("section carries the git-log fallback (Step 2 of the derivation chain)", () => {
    // The fallback is what closes the worktree-without-author gap; pinning
    // the literal command keeps a future refactor from "simplifying" it to
    // an inferior approximation.
    expect(COMMIT_CONVENTIONS_SECTION).toContain(
      "git log -1 --format='%an%n%ae'",
    );
  });

  it("section fails closed when both config and history are empty", () => {
    // The fallback chain MUST end in a stop-and-report, not silent fallback.
    expect(COMMIT_CONVENTIONS_SECTION).toContain("FATAL: cannot resolve git author");
    expect(COMMIT_CONVENTIONS_SECTION).toContain("exit 1");
  });

  it("section forbids committing .pi/ paths", () => {
    // .pi/ is the orchestrator's namespace; subagents must not stage it.
    expect(COMMIT_CONVENTIONS_SECTION).toContain("Never `git add` paths under `.pi/`");
  });
});
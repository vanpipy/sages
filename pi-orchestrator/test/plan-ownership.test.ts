import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const root = resolve(import.meta.dirname, "../../..");
const sources = [
  "pi/templates/SYSTEM.md",
  "pi/templates/agent-tool-description.md",
  "pi/templates/SUBAGENTS.md",
  "pi/skills/orchestrator/SKILL.md",
  "AGENTS.md",
  "pi/src/index.ts",
  "pi/src/tools/orchestrator/index.ts",
  "pi/src/tools/orchestrator/types.ts",
].map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");

const systemMd = readFileSync(resolve(root, "pi/templates/SYSTEM.md"), "utf8");
const subagentsMd = readFileSync(resolve(root, "pi/templates/SUBAGENTS.md"), "utf8");

describe("main-agent Planning Brief ownership contract", () => {
  it("marks the main agent as planning owner and Plan as compiler", () => {
    expect(sources).toMatch(/Planning Owner/);
    expect(sources).toMatch(/Planning Brief/);
    expect(sources).toMatch(/plan(?:ning brief)? compiler/i);
    expect(sources).toMatch(/incomplete[\s\S]*decision|missing[\s\S]*decision/i);
  });

  it("rejects stale architect and open-ended Plan contracts", () => {
    expect(sources).not.toMatch(/`Plan`[^\n]*(?:software architect|architecture design)/i);
    expect(sources).not.toMatch(/Plan[^\n]*open-ended[^\n]*Explore/i);
    expect(sources).not.toMatch(/Plan\s*\|[^\n]*(?:bash|grep|find|ls|graph)/i);
  });
});

// P3: global consistency scan found active SYSTEM.md / SUBAGENTS.md
// guidance still advertising the retired `general-purpose` subagent.
// DAG-2026-011 Phase C removed that helper; the canonical meta-file
// policy now steers callers to `developer` (with `tdd: none` and no
// isolation) for meta-file edits and `developer` (with managed
// worktree isolation) for production code. The historical *why* note
// (Phase C removed general-purpose because ...) stays in audit notes
// and compatibility comments; what we pin here is that the active
// dispatch guidance in SYSTEM.md / SUBAGENTS.md does not tell the
// main agent to dispatch it any more.
describe("active dispatch guidance does not advertise retired general-purpose", () => {
  it("SYSTEM.md does not direct the main agent to dispatch general-purpose", () => {
    // No active example / table row / dispatch decision in SYSTEM.md
    // should target the retired `general-purpose` agent.
    expect(systemMd).not.toMatch(/subagent_type:\s*"general-purpose"/);
    expect(systemMd).not.toMatch(/`general-purpose`\s+no-isolation/i);
    // Dispatch examples / "use X for Y" sentences must not mention
    // general-purpose as a target.
    expect(systemMd).not.toMatch(/dispatch\s+`?general-purpose`?/i);
    expect(systemMd).not.toMatch(/Use\s+`?general-purpose`?\s+for/i);
  });

  it("SYSTEM.md foreground/background policy excludes general-purpose", () => {
    // The Foreground vs Background table should list Explore/Plan as
    // foreground and developer/auditor as background — never
    // general-purpose (that helper no longer exists).
    expect(systemMd).not.toMatch(/Explore[^]*?Plan[^]*?general-purpose/);
  });

  it("SYSTEM.md write-tool policy table excludes general-purpose", () => {
    // The Subagent / Path scope / Worktree table that anchors the
    // write-tool policy must not list general-purpose. The current
    // canonical rows are developer (meta + production) and the 4
    // orchestrator tools.
    expect(systemMd).not.toMatch(/\|\s*`?general-purpose`?[^\n]*\|/);
  });

  it("SUBAGENTS.md does not direct the main agent to dispatch general-purpose", () => {
    // Same narrowing for the SUBAGENTS reference document: no active
    // dispatch example or table row targets the retired agent.
    expect(subagentsMd).not.toMatch(/subagent_type:\s*"general-purpose"/);
    expect(subagentsMd).not.toMatch(/dispatch\s+`?general-purpose`?/i);
  });

  it("SUBAGENTS.md no longer retains the obsolete Sidecar: general-purpose section", () => {
    // The Sidecar section was a dedicated home for the retired
    // helper. It must be gone from the active reference.
    expect(subagentsMd).not.toMatch(/^###\s+Sidecar:\s+`?general-purpose`?/m);
  });

  it("SUBAGENTS.md accurately describes the four-agent default roster", () => {
    // The current default roster is Explore, Plan, developer, auditor.
    // The legacy "3 built-ins + 2 shipped" framing (which counted the
    // removed helper) must not survive.
    expect(subagentsMd).toMatch(/\bExplore\b/);
    expect(subagentsMd).toMatch(/\bPlan\b/);
    expect(subagentsMd).toMatch(/\bdeveloper\b/);
    expect(subagentsMd).toMatch(/\bauditor\b/);
    expect(subagentsMd).not.toMatch(/3 built-ins\s*\+\s*2 shipped/i);
    expect(subagentsMd).not.toMatch(/\b3 built-ins\b/i);
  });
});

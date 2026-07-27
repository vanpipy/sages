import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

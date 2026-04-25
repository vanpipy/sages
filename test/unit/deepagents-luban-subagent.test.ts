import { describe, it, expect } from "bun:test";
import { lubanSubAgent } from "../../src/deepagents/luban-subagent.js";

describe("lubanSubAgent", () => {
  it("should be defined", () => {
    expect(lubanSubAgent).toBeDefined();
  });

  it("should have name luban", () => {
    expect(lubanSubAgent.name).toBe("luban");
  });

  it("should have systemPrompt configured", () => {
    expect(typeof lubanSubAgent.systemPrompt).toBe("string");
    expect(lubanSubAgent.systemPrompt.length).toBeGreaterThan(0);
  });

  it("should mention TDD in systemPrompt", () => {
    expect(lubanSubAgent.systemPrompt).toContain("TDD");
    expect(lubanSubAgent.systemPrompt).toContain("Test");
  });
});

import { describe, it, expect } from "bun:test";
import { qiaoChuiSubAgent } from "../../src/deepagents/qiaochui-subagent.js";

describe("qiaoChuiSubAgent", () => {
  it("should be defined", () => {
    expect(qiaoChuiSubAgent).toBeDefined();
  });

  it("should have name qiaochui", () => {
    expect(qiaoChuiSubAgent.name).toBe("qiaochui");
  });

  it("should have systemPrompt configured", () => {
    expect(typeof qiaoChuiSubAgent.systemPrompt).toBe("string");
    expect(qiaoChuiSubAgent.systemPrompt.length).toBeGreaterThan(0);
  });
});

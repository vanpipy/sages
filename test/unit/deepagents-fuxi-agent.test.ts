import { describe, it, expect } from "bun:test";
import { fuxiAgent } from "../../src/deepagents/fuxi-agent.js";

describe("fuxiAgent", () => {
  it("should be defined", () => {
    expect(fuxiAgent).toBeDefined();
  });

  it("should be an object", () => {
    expect(typeof fuxiAgent).toBe("object");
  });
});
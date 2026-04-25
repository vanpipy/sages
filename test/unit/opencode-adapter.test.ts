import { describe, it, expect } from "bun:test";
import { getSagesTools, invokeTool, fuxiAgent } from "../../src/opencode-adapter.js";

describe("OpenCode Adapter", () => {
  it("should export fuxiAgent", () => {
    expect(fuxiAgent).toBeDefined();
    expect(typeof fuxiAgent.invoke).toBe("function");
  });

  it("should export invokeTool function", () => {
    expect(typeof invokeTool).toBe("function");
  });

  it("should export getSagesTools function", () => {
    expect(typeof getSagesTools).toBe("function");
  });
});

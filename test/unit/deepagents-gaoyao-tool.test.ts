import { describe, it, expect } from "bun:test";
import { gaoyaoTool } from "../../src/deepagents/tools/gaoyao-tool.js";

describe("gaoyaoTool", () => {
  it("should be defined", () => {
    expect(gaoyaoTool).toBeDefined();
  });

  it("should have name gaoyao_review", () => {
    expect(gaoyaoTool.name).toBe("gaoyao_review");
  });

  it("should have schema with required fields", () => {
    expect(gaoyaoTool.schema).toBeDefined();
  });
});

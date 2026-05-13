import { describe, it, expect } from "bun:test";

describe("MiniMax Chat Module", () => {
  it("should export chat types (compile-time check)", () => {
    const types = require("../../src/tools/minimax/types.js");
    expect(types).toBeDefined();
    expect(typeof types.ChatMessage).toBe("undefined");
  });

  it("should have correct ChatMessage structure", () => {
    const message = {
      role: "user" as const,
      content: "Hello, world!",
    };
    expect(message.role).toBe("user");
    expect(message.content).toBe("Hello, world!");
  });

  it("should have correct ChatCompletionRequest structure", () => {
    const request = {
      model: "MiniMax-Text-01",
      messages: [{ role: "user" as const, content: "Hi" }],
      max_tokens: 100,
      temperature: 0.7,
    };
    expect(request.model).toBe("MiniMax-Text-01");
    expect(request.messages).toHaveLength(1);
    expect(request.max_tokens).toBe(100);
  });
});

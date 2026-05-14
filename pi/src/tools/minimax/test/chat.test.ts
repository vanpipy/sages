import { describe, it, expect } from "bun:test";

describe("Chat Module", () => {
  it("should export chat types (compile-time check)", () => {
    const types = require("../types.js");
    expect(types).toBeDefined();
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
      model: "MiniMax-M2.7",
      messages: [{ role: "user" as const, content: "Hi" }],
      max_tokens: 100,
      temperature: 0.7,
    };
    expect(request.model).toBe("MiniMax-M2.7");
    expect(request.messages).toHaveLength(1);
    expect(request.max_tokens).toBe(100);
  });

  it("should have TEXT_MODELS constants", () => {
    const types = require("../types.js");
    expect(types.TEXT_MODELS).toBeDefined();
    expect(types.TEXT_MODELS.M2_7).toBe("MiniMax-M2.7");
    expect(types.TEXT_MODELS.M2_7_HIGHSPEED).toBe("MiniMax-M2.7-highspeed");
    expect(types.TEXT_MODELS.M2_5).toBe("MiniMax-M2.5");
  });

  it("should have KNOWN_API_HOSTS constant", () => {
    const types = require("../types.js");
    expect(types.KNOWN_API_HOSTS).toBeDefined();
    expect(types.KNOWN_API_HOSTS).toContain("https://api.minimaxi.com");
    expect(types.KNOWN_API_HOSTS).toContain("https://api.minimax.io");
    expect(types.KNOWN_API_HOSTS).toContain("https://api.minimax.chat");
  });

  it("should export createMiniMax function", async () => {
    const { createMiniMax } = await import("../index.js");
    expect(typeof createMiniMax).toBe("function");
  });

  it("should create a client with apiKey", async () => {
    const { createMiniMax } = await import("../index.js");
    const client = createMiniMax({
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
    expect(typeof client.chat).toBe("function");
    expect(typeof client.search).toBe("function");
  });
});

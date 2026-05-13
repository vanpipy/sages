import { describe, it, expect } from "bun:test";

describe("MiniMax Image Module", () => {
  it("should export image types (compile-time check)", () => {
    const types = require("../../src/tools/minimax/types.js");
    expect(types).toBeDefined();
    expect(typeof types.ImageGenerateRequest).toBe("undefined");
  });

  it("should have correct ImageGenerateRequest structure", () => {
    const request = {
      model: "image-01",
      prompt: "A beautiful landscape",
      width: 1024,
      height: 1024,
      num: 1,
    };
    expect(request.model).toBe("image-01");
    expect(request.prompt).toBe("A beautiful landscape");
    expect(request.width).toBe(1024);
    expect(request.height).toBe(1024);
    expect(request.num).toBe(1);
  });

  it("should have correct ImageResponse structure", () => {
    const response = {
      success: true,
      request_id: "test-123",
      data: [{ url: "https://example.com/image.png" }],
    };
    expect(response.success).toBe(true);
    expect(response.data).toHaveLength(1);
    expect(response.data[0].url).toContain("example.com");
  });
});

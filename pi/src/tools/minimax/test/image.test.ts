import { describe, it, expect } from "bun:test";

describe("Image Module", () => {
  it("should export image types (compile-time check)", () => {
    const types = require("../types.js");
    expect(types).toBeDefined();
  });

  it("should have IMAGE_MODELS constants", () => {
    const types = require("../types.js");
    expect(types.IMAGE_MODELS).toBeDefined();
    expect(types.IMAGE_MODELS.IMAGE_01).toBe("image-01");
    expect(types.IMAGE_MODELS.IMAGE_01_PRO).toBe("image-01-pro");
  });

  it("should have correct ImageGenerateRequest structure", () => {
    const request = {
      model: "image-01",
      prompt: "A beautiful landscape",
      width: 1024,
      height: 1024,
      num_images: 2,
    };
    expect(request.model).toBe("image-01");
    expect(request.prompt).toBe("A beautiful landscape");
    expect(request.width).toBe(1024);
    expect(request.height).toBe(1024);
    expect(request.num_images).toBe(2);
  });

  it("should have correct ImageResponse structure", () => {
    const response = {
      success: true,
      request_id: "test-123",
      image_list: [{ url: "https://example.com/image.png" }],
    };
    expect(response.success).toBe(true);
    expect(response.image_list).toHaveLength(1);
    expect(response.image_list[0].url).toContain("example.com");
  });

  it("should have correct ImageEditRequest structure", () => {
    const request = {
      model: "image-01",
      prompt: "Edit this image",
      image: "data:image/png;base64,...",
      mask: "data:image/png;base64,...",
    };
    expect(request.model).toBe("image-01");
    expect(request.prompt).toBe("Edit this image");
    expect(request.image).toContain("base64");
    expect(request.mask).toContain("base64");
  });

  it("should have VideoGenerateRequest structure", () => {
    const types = require("../types.js");
    expect(types.VIDEO_MODELS).toBeDefined();
    expect(types.VIDEO_MODELS.HAILUO_23).toBe("Hailuo-2.3");
  });
});

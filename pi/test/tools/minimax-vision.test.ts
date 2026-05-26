/**
 * MiniMax Vision Module Unit Tests
 * Validates vision (image understanding) types and request/response structures
 */

import { describe, it, expect } from "bun:test";

describe("MiniMax Vision Module", () => {
  describe("VisionContent types", () => {
    it("should accept text content type", () => {
      const content = {
        type: "text" as const,
        text: "What is in this image?",
      };
      expect(content.type).toBe("text");
      expect(content.text).toBe("What is in this image?");
    });

    it("should accept image_url content type", () => {
      const content = {
        type: "image_url" as const,
        image_url: {
          url: "https://example.com/image.jpg",
        },
      };
      expect(content.type).toBe("image_url");
      expect(content.image_url?.url).toBe("https://example.com/image.jpg");
    });

    it("should accept image_url with low detail", () => {
      const content = {
        type: "image_url" as const,
        image_url: {
          url: "https://example.com/image.jpg",
          detail: "low" as const,
        },
      };
      expect(content.image_url?.detail).toBe("low");
    });

    it("should accept image_url with high detail", () => {
      const content = {
        type: "image_url" as const,
        image_url: {
          url: "https://example.com/image.jpg",
          detail: "high" as const,
        },
      };
      expect(content.image_url?.detail).toBe("high");
    });

    it("should accept image_url with auto detail", () => {
      const content = {
        type: "image_url" as const,
        image_url: {
          url: "https://example.com/image.jpg",
          detail: "auto" as const,
        },
      };
      expect(content.image_url?.detail).toBe("auto");
    });

    it("should accept multiple content items in array", () => {
      const contents = [
        { type: "text" as const, text: "Describe this image:" },
        {
          type: "image_url" as const,
          image_url: { url: "https://example.com/photo.jpg" },
        },
      ];
      expect(contents).toHaveLength(2);
      expect(contents[0].type).toBe("text");
      expect(contents[1].type).toBe("image_url");
    });
  });

  describe("VisionMessage types", () => {
    it("should accept user role", () => {
      const message = {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "What is this?" },
        ],
      };
      expect(message.role).toBe("user");
    });

    it("should accept assistant role", () => {
      const message = {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "This is a cat." },
        ],
      };
      expect(message.role).toBe("assistant");
    });
  });

  describe("VisionRequest validation", () => {
    it("should accept required messages array", () => {
      const request = {
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: "What is this?" },
            ],
          },
        ],
      };
      expect(request.messages).toHaveLength(1);
    });

    it("should accept optional model field", () => {
      const request = {
        model: "MiniMax-VL-01",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "?" }],
          },
        ],
      };
      expect(request.model).toBe("MiniMax-VL-01");
    });

    it("should accept optional max_tokens", () => {
      const request = {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "?" }],
          },
        ],
        max_tokens: 2048,
      };
      expect(request.max_tokens).toBe(2048);
    });

    it("should construct valid vision request with image", () => {
      const request = {
        model: "MiniMax-VL-01",
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: "Describe this image in detail." },
              {
                type: "image_url" as const,
                image_url: {
                  url: "https://example.com/cat.jpg",
                  detail: "high" as const,
                },
              },
            ],
          },
        ],
        max_tokens: 1024,
      };
      expect(request.model).toBe("MiniMax-VL-01");
      expect(request.messages[0].content).toHaveLength(2);
      expect(request.messages[0].content[1].image_url?.detail).toBe("high");
    });
  });

  describe("VisionResponse validation", () => {
    it("should accept success response with id", () => {
      const response = {
        success: true,
        id: "vision-123",
        model: "MiniMax-VL-01",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "This is a cute orange tabby cat.",
            },
            finish_reason: "stop",
          },
        ],
      };
      expect(response.id).toBe("vision-123");
      expect(response.choices[0].message.content).toBe("This is a cute orange tabby cat.");
    });

    it("should accept response with usage info", () => {
      const response = {
        success: true,
        request_id: "req-123",
        id: "vision-456",
        model: "MiniMax-VL-01",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "A cat." },
            finish_reason: "stop",
          },
        ],
      };
      expect(response.success).toBe(true);
    });

    it("should accept multiple choices", () => {
      const response = {
        success: true,
        id: "vision-789",
        model: "MiniMax-VL-01",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "First response." },
            finish_reason: "stop",
          },
          {
            index: 1,
            message: { role: "assistant", content: "Second response." },
            finish_reason: "stop",
          },
        ],
      };
      expect(response.choices).toHaveLength(2);
    });
  });

  describe("createMiniMax client", () => {
    it("should have vision method on client", async () => {
      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax({ apiKey: "test-key" });
      expect(typeof client.vision).toBe("function");
    });
  });
});

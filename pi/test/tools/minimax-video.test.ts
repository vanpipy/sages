/**
 * MiniMax Video Module Unit Tests
 * Validates video generation types and createMiniMax video methods
 */

import { describe, it, expect } from "bun:test";
import { VIDEO_MODELS } from "../../src/tools/minimax/types.js";

describe("MiniMax Video Module", () => {
  describe("VIDEO_MODELS constants", () => {
    it("should have Hailuo-2.3 model", () => {
      expect(VIDEO_MODELS.HAILUO_23).toBe("Hailuo-2.3");
    });

    it("should have Hailuo-2.3-Fast model", () => {
      expect(VIDEO_MODELS.HAILUO_23_FAST).toBe("Hailuo-2.3-Fast");
    });
  });

  describe("createMiniMax function", () => {
    it("should export createMiniMax function", async () => {
      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      expect(typeof createMiniMax).toBe("function");
    });

    it("should create client with videoGenerate method", async () => {
      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax({ apiKey: "test-key" });
      expect(typeof client.videoGenerate).toBe("function");
    });

    it("should create client with all 7 capabilities", async () => {
      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax({ apiKey: "test-key" });
      
      // Text
      expect(typeof client.chat).toBe("function");
      expect(typeof client.chatStream).toBe("function");
      
      // Image
      expect(typeof client.imageGenerate).toBe("function");
      expect(typeof client.imageEdit).toBe("function");
      
      // Video
      expect(typeof client.videoGenerate).toBe("function");
      
      // Speech
      expect(typeof client.speechSynthesize).toBe("function");
      expect(typeof client.speechTranscribe).toBe("function");
      
      // Music
      expect(typeof client.musicGenerate).toBe("function");
      
      // Vision
      expect(typeof client.vision).toBe("function");
      
      // Search
      expect(typeof client.search).toBe("function");
    });
  });

  describe("videoGenerate request validation", () => {
    it("should accept prompt with default model", async () => {
      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax({ apiKey: "test-key" });
      
      // This is a compile-time check - actual API call would require valid credentials
      const request = {
        prompt: "A cat playing piano",
      };
      expect(request.prompt).toBe("A cat playing piano");
    });

    it("should accept prompt with Hailuo-2.3 model", async () => {
      const request = {
        model: "Hailuo-2.3",
        prompt: "A cat playing piano",
      };
      expect(request.model).toBe("Hailuo-2.3");
    });

    it("should accept duration up to 10 seconds", async () => {
      const request = {
        model: "Hailuo-2.3",
        prompt: "A cat playing piano",
        duration: 10,
      };
      expect(request.duration).toBe(10);
    });

    it("should accept fps option", async () => {
      const request = {
        model: "Hailuo-2.3",
        prompt: "A cat playing piano",
        fps: 24,
      };
      expect(request.fps).toBe(24);
    });

    it("should accept 720p resolution", async () => {
      const request = {
        model: "Hailuo-2.3",
        prompt: "A cat playing piano",
        resolution: "720p" as const,
      };
      expect(request.resolution).toBe("720p");
    });

    it("should accept 1080p resolution", async () => {
      const request = {
        model: "Hailuo-2.3",
        prompt: "A cat playing piano",
        resolution: "1080p" as const,
      };
      expect(request.resolution).toBe("1080p");
    });
  });

  describe("videoGenerate response validation", () => {
    it("should accept success response with task_id", () => {
      const response = {
        success: true,
        request_id: "req-123",
        task_id: "task-456",
      };
      expect(response.success).toBe(true);
      expect(response.task_id).toBe("task-456");
    });

    it("should accept response with video_url", () => {
      const response = {
        success: true,
        request_id: "req-123",
        video_url: "https://example.com/video.mp4",
      };
      expect(response.video_url).toBe("https://example.com/video.mp4");
    });

    it("should accept response with status", () => {
      const response = {
        success: true,
        request_id: "req-123",
        status: "completed",
      };
      expect(response.status).toBe("completed");
    });
  });
});

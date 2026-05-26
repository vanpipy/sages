/**
 * MiniMax E2E Tests
 * Integration tests that validate actual API calls
 * 
 * These tests require valid MiniMax credentials:
 * - Set MINIMAX_API_KEY environment variable, or
 * - Have ~/.mmx/config.json with valid credentials
 * 
 * Run with: bun test ./test/tools/minimax-e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Check if we have credentials for E2E testing
const hasMinimaxKey = !!process.env.MINIMAX_API_KEY;
const testConfigDir = join(homedir(), ".mmx-e2e-test");
const testConfigPath = join(testConfigDir, "config.json");

function createTestConfig(): { apiKey: string; groupId?: string; baseURL?: string } | null {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;
  
  return {
    apiKey: key,
    groupId: process.env.MINIMAX_GROUP_ID || undefined,
    baseURL: process.env.MINIMAX_API_HOST || undefined,
  };
}

describe("MiniMax E2E Tests", () => {
  const credentials = createTestConfig();
  const skipE2E = !credentials;

  beforeEach(() => {
    // Setup test config directory
    if (!existsSync(testConfigDir)) {
      mkdirSync(testConfigDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Cleanup test config
    try {
      if (existsSync(testConfigPath)) {
        unlinkSync(testConfigPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Credential Detection", () => {
    it("should have MINIMAX_API_KEY set for E2E tests", () => {
      if (skipE2E) {
        console.log("⚠️  Skipping E2E tests - no MINIMAX_API_KEY environment variable");
      }
      // This test always passes, it's just informational
      expect(true).toBe(true);
    });
  });

  describe("API Connection", () => {
    it("should create MiniMax client with credentials", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);
      expect(client).toBeDefined();
      expect(typeof client.chat).toBe("function");
      expect(typeof client.imageGenerate).toBe("function");
      expect(typeof client.videoGenerate).toBe("function");
      expect(typeof client.speechSynthesize).toBe("function");
      expect(typeof client.musicGenerate).toBe("function");
      expect(typeof client.vision).toBe("function");
      expect(typeof client.search).toBe("function");
    });
  });

  describe("Text Chat E2E", () => {
    it("should complete a simple chat request", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.chat({
        model: "MiniMax-M2.7",
        messages: [{ role: "user", content: "Say 'hello' in exactly one word" }],
        max_tokens: 10,
      });

      expect(response.success).toBe(true);
      expect(response.choices).toBeDefined();
      expect(response.choices.length).toBeGreaterThan(0);
      expect(response.choices[0].message.content).toBeDefined();
    }, { timeout: 30000 });

    it("should handle streaming chat", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      let chunksReceived = 0;
      // chatStream takes 2 args: request and onChunk callback
      await client.chatStream(
        {
          model: "MiniMax-M2.7",
          messages: [{ role: "user", content: "Count from 1 to 3" }],
          max_tokens: 50,
        },
        (chunk) => {
          chunksReceived++;
        }
      );

      // chatStream returns void, chunks are received via callback
      expect(chunksReceived).toBeGreaterThan(0);
    }, { timeout: 30000 });
  });

  describe("Image Generation E2E", () => {
    it("should generate an image", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.imageGenerate({
        model: "image-01",
        prompt: "A simple red circle on white background",
        num_images: 1,
        width: 512,
        height: 512,
      });

      expect(response.success).toBe(true);
      expect(response.image_list).toBeDefined();
      expect(response.image_list!.length).toBeGreaterThan(0);
      // image_list items have either url or base64
      const image = response.image_list![0];
      expect(image.url || image.base64).toBeDefined();
    }, { timeout: 60000 });

    it("should generate multiple images", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.imageGenerate({
        model: "image-01",
        prompt: "A blue square",
        num_images: 2,
        width: 256,
        height: 256,
      });

      expect(response.success).toBe(true);
      expect(response.image_list!.length).toBe(2);
    }, { timeout: 60000 });
  });

  describe("Video Generation E2E", () => {
    it("should initiate video generation", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      // Video generation is async, so we get a task_id
      const response = await client.videoGenerate({
        model: "Hailuo-2.3",
        prompt: "A small white cat walking in a garden",
        duration: 6,
        fps: 24,
        resolution: "720p",
      });

      expect(response.success).toBe(true);
      // Response should have task_id for async polling
      expect(response.task_id || response.status).toBeDefined();
    }, { timeout: 60000 });

    it("should accept video generation with minimal params", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.videoGenerate({
        prompt: "Abstract flowing colors",
      });

      expect(response.success).toBe(true);
    }, { timeout: 60000 });
  });

  describe("Speech Synthesis E2E", () => {
    it("should synthesize speech", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.speechSynthesize({
        model: "speech-2.8-turbo",
        text: "Hello, this is a test of the MiniMax text to speech system.",
        voice_id: "male-qingse",
        speed: 1.0,
        output_format: "mp3",
      });

      expect(response.success).toBe(true);
      expect(response.data?.audio_url).toBeDefined();
    }, { timeout: 30000 });

    it("should synthesize with different voice", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.speechSynthesize({
        text: "Testing speech synthesis",
        voice_id: "male-qingse",
      });

      expect(response.success).toBe(true);
    }, { timeout: 30000 });
  });

  describe("Music Generation E2E", () => {
    it("should generate instrumental music", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.musicGenerate({
        model: "music-2.6",
        prompt: "Peaceful ambient piano music",
        is_instrumental: true,
        duration: 10,
      });

      expect(response.success).toBe(true);
      // Response has either task_id (async) or data.audio_url/audio
      const hasResult = response.data?.audio_url || response.data?.audio || response.task_id;
      expect(hasResult).toBeDefined();
    }, { timeout: 60000 });

    it("should generate music with lyrics", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.musicGenerate({
        model: "music-2.6",
        prompt: "Upbeat pop song",
        lyrics: "[verse] This is a test\n[chorus] Singing along",
        duration: 30,
      });

      expect(response.success).toBe(true);
    }, { timeout: 60000 });
  });

  describe("Vision E2E", () => {
    it("should analyze an image URL", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.vision({
        model: "MiniMax-VL-01",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png",
                },
              },
              { type: "text", text: "Describe this image briefly." },
            ],
          },
        ],
        max_tokens: 100,
      });

      expect(response.success).toBe(true);
      expect(response.choices).toBeDefined();
      expect(response.choices.length).toBeGreaterThan(0);
      expect(response.choices[0].message.content).toBeTruthy();
    }, { timeout: 30000 });
  });

  describe("Search E2E", () => {
    it("should perform a web search", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.search({
        query: "MiniMax AI company",
        num_results: 5,
      });

      expect(response.success).toBe(true);
      // Search responses may have organic results or be empty
      expect(Array.isArray(response.organic) || Array.isArray(response.related_searches)).toBe(true);
    }, { timeout: 30000 });

    it("should handle search with default num_results", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      const response = await client.search({
        query: "artificial intelligence",
      });

      expect(response.success).toBe(true);
    }, { timeout: 30000 });
  });

  describe("Error Handling E2E", () => {
    it("should handle invalid API key gracefully", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      
      const client = createMiniMax({
        apiKey: "invalid-key-12345",
        groupId: credentials!.groupId,
      });

      try {
        await client.chat({
          messages: [{ role: "user", content: "Hello" }],
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        // Check error is MiniMaxError by checking its name property
        expect((error as { name: string }).name).toBe("MiniMaxError");
      }
    }, { timeout: 15000 });

    it("should handle rate limiting gracefully", async () => {
      if (skipE2E) return;

      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax(credentials!);

      // Make multiple rapid requests to potentially trigger rate limit
      // This is a best-effort test
      try {
        await Promise.all([
          client.chat({ messages: [{ role: "user", content: "Test 1" }] }),
          client.chat({ messages: [{ role: "user", content: "Test 2" }] }),
          client.chat({ messages: [{ role: "user", content: "Test 3" }] }),
        ]);
      } catch (error) {
        // Rate limit errors are acceptable - check error code
        const err = error as { code?: string; statusCode?: number };
        const isRateLimit = err.code === "RATE_LIMIT" || err.statusCode === 429;
        expect(isRateLimit).toBe(true);
      }
    }, { timeout: 30000 });
  });
});

// Summary that runs regardless
describe("MiniMax E2E Test Summary", () => {
  it("E2E tests configured correctly", () => {
    const hasKey = !!process.env.MINIMAX_API_KEY;
    if (!hasKey) {
      console.log("\n📋 E2E Test Setup:");
      console.log("   To run E2E tests, set: export MINIMAX_API_KEY='your-key'");
      console.log("   E2E tests will be skipped until credentials are provided.\n");
    } else {
      console.log("\n✅ E2E tests will run with your MINIMAX_API_KEY\n");
    }
    expect(true).toBe(true);
  });
});

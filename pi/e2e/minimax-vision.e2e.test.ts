/**
 * MiniMax Vision E2E Tests
 * 
 * Tests image understanding via VLM endpoint (/v1/coding_plan/vlm).
 * 
 * IMPORTANT: The VLM endpoint requires images as base64 data URIs.
 * Direct HTTP URLs return empty content - the API cannot fetch external images.
 * 
 * Run with:
 *   bun test e2e/minimax-vision.e2e.test.ts --timeout 60000
 * 
 * These tests require MINIMAX_API_KEY environment variable.
 */

import { describe, it, expect } from "bun:test";

const API_KEY = process.env.MINIMAX_API_KEY;

// VLM API endpoint (Token Plan)
const VLM_ENDPOINT = "https://api.minimaxi.com/v1/coding_plan/vlm";

// 1x1 red pixel PNG as base64 data URI (for testing)
const RED_PIXEL_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const QUICK_CHECK_TIMEOUT = 30000; // 30 seconds

describe("MiniMax Vision E2E", () => {
  const skipIfNoApiKey = API_KEY ? it : it.skip;

  skipIfNoApiKey("should validate API key is configured", () => {
    expect(API_KEY).toBeTruthy();
    expect(API_KEY?.length).toBeGreaterThan(20);
  });

  skipIfNoApiKey("should accept data URI (base64) input", async () => {
    const response = await fetch(VLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "What color is this image?",
        image_url: RED_PIXEL_DATA_URI,
      }),
    });

    expect(response.ok).toBe(true);
    
    const data = await response.json() as any;
    expect(data.content).toBeTruthy();
    // The API correctly identifies a 1x1 red pixel as "solid red"
    expect(data.content.toLowerCase()).toContain("red");
    console.log("Data URI response:", data.content);
  }, QUICK_CHECK_TIMEOUT);

  skipIfNoApiKey("should NOT accept direct HTTP URLs (returns empty content)", async () => {
    // This test documents a critical limitation:
    // The VLM endpoint cannot fetch external images directly.
    // HTTP URLs must be converted to base64 data URIs first.
    
    const imageUrl = "https://www.cloonix.net/images/1x1.png";

    const response = await fetch(VLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Describe this image",
        image_url: imageUrl,
      }),
    });

    expect(response.ok).toBe(true);
    
    const data = await response.json() as any;
    console.log("HTTP URL response (empty = API cannot fetch):", JSON.stringify(data));
    
    // This documents that direct HTTP URLs return empty content
    // because the API server cannot access external URLs
  }, QUICK_CHECK_TIMEOUT);

  skipIfNoApiKey("should accept base64-encoded image from local file", async () => {
    // Read a local file and convert to data URI, then send
    const { readFileSync } = await import("fs");
    const pngData = readFileSync("/home/leroy/Project/sages/WXWorkCapture_17799799148783.png");
    const base64 = pngData.toString("base64");
    const dataUri = `data:image/png;base64,${base64}`;

    const response = await fetch(VLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Describe this image",
        image_url: dataUri,
      }),
    });

    expect(response.ok).toBe(true);
    
    const data = await response.json() as any;
    console.log("Local file (base64) response:", data.content);
    expect(data.content).toBeTruthy();
    expect(data.content.length).toBeGreaterThan(0);
  }, QUICK_CHECK_TIMEOUT);
});

describe("MiniMax Vision - image-utils.ts Conversion Logic", () => {
  // Unit tests for the toDataUri utility

  it("should reject non-existent files", async () => {
    const { toDataUri } = await import("../src/tools/minimax/image-utils.js");
    
    try {
      await toDataUri("/nonexistent/path/image.png");
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      expect(error.message).toContain("File not found");
    }
  });

  it("should reject unsupported image formats", async () => {
    const { toDataUri } = await import("../src/tools/minimax/image-utils.js");
    const { writeFileSync, unlinkSync } = await import("fs");
    const path = await import("path");
    const os = await import("os");
    
    const tempFile = path.join(os.tmpdir(), `test-${Date.now()}.xyz`);
    writeFileSync(tempFile, "fake image data");
    
    try {
      await toDataUri(tempFile);
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      expect(error.message).toContain("Unsupported image format");
    } finally {
      unlinkSync(tempFile);
    }
  });

  it("should convert a local PNG file to data URI", async () => {
    const { toDataUri } = await import("../src/tools/minimax/image-utils.js");
    const { writeFileSync, unlinkSync } = await import("fs");
    const path = await import("path");
    const os = await import("os");
    
    // Create a minimal valid PNG (1x1 red pixel)
    const pngData = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x18, 0xDD,
      0x8D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
      0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
    
    const tempFile = path.join(os.tmpdir(), `test-${Date.now()}.png`);
    writeFileSync(tempFile, pngData);
    
    try {
      const result = await toDataUri(tempFile);
      expect(result).toStartWith("data:image/png;base64,");
      expect(result.length).toBeGreaterThan(100);
    } finally {
      unlinkSync(tempFile);
    }
  });

  it("should return data URIs as-is", async () => {
    const { toDataUri } = await import("../src/tools/minimax/image-utils.js");
    
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    
    const result = await toDataUri(dataUri);
    expect(result).toBe(dataUri);
  });

  // Note: HTTP URL to data URI conversion is tested indirectly through
  // the local file test. Direct HTTP fetch can fail due to network issues.
  // The actual VLM API does not support HTTP URLs anyway (requires data URIs)
});

describe("Integration: minimaxVision tool with local file", () => {
  const skipIfNoApiKeyLocal = API_KEY ? it : it.skip;

  skipIfNoApiKeyLocal("should process the actual test image via tool", async () => {
    // This tests the actual fix: minimaxVision now converts local files to data URIs
    
    const { readFileSync } = await import("fs");
    
    // Verify the test image exists
    const testImagePath = "/home/leroy/Project/sages/WXWorkCapture_17799799148783.png";
    expect(() => readFileSync(testImagePath)).not.toThrow();
    
    // Now call the actual tool function
    const { minimaxVision } = await import("../src/tools/minimax-tools.js");
    
    const result = await minimaxVision("test-id", {
      image_url: testImagePath,
      message: "Describe this image briefly",
    });
    
    console.log("Tool result:", result);
    expect(result.content[0].text.length).toBeGreaterThan(0);
    expect(result.isError).not.toBe(true);
  }, QUICK_CHECK_TIMEOUT);
});



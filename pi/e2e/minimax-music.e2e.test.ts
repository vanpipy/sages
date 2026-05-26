/**
 * MiniMax Music E2E Tests
 * 
 * Music generation is ASYNC and can take 60-120 seconds to complete.
 * Run with extended timeout:
 *   bun test e2e/ --timeout 180000
 * 
 * These tests require MINIMAX_API_KEY environment variable.
 */

import { describe, it, expect } from "bun:test";

const API_KEY = process.env.MINIMAX_API_KEY;

// Music generation takes 60-120 seconds - this is expected behavior
const MUSIC_GENERATION_TIMEOUT = 180000; // 3 minutes
const QUICK_CHECK_TIMEOUT = 15000; // 15 seconds for fast validation

describe("MiniMax Music E2E", () => {
  const skipIfNoApiKey = API_KEY ? it : it.skip;

  skipIfNoApiKey("should validate API key is configured", () => {
    expect(API_KEY).toBeTruthy();
    expect(API_KEY?.length).toBeGreaterThan(20);
  });

  skipIfNoApiKey("should reject capitalized model name (Music-2.6)", async () => {
    const response = await fetch("https://api.minimaxi.com/v1/music_generation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "Music-2.6", // Invalid - should be lowercase
        prompt: "test",
        lyrics: "[intro]",
      }),
    });

    const data = await response.json() as any;
    // Should return error about invalid model
    expect(data.base_resp?.status_code).not.toBe(0);
  }, QUICK_CHECK_TIMEOUT);

  skipIfNoApiKey("should generate music with music-2.6 (takes 60-120s)", async () => {
    const response = await fetch("https://api.minimaxi.com/v1/music_generation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "music-2.6",
        prompt: "Peaceful piano",
        lyrics: "[intro] [outro]",
        output_format: "url",
      }),
    });

    expect(response.ok).toBe(true);
    
    const data = await response.json() as any;
    expect(data.base_resp?.status_code).toBe(0);
    // API returns audio URL in data.audio (not data.audio_url)
    expect(data.data?.audio).toBeTruthy();
  }, MUSIC_GENERATION_TIMEOUT);

  skipIfNoApiKey("should generate instrumental music (takes 60-120s)", async () => {
    const response = await fetch("https://api.minimaxi.com/v1/music_generation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "music-2.6",
        prompt: "Ambient sleep music, soft piano",
        is_instrumental: true,
        lyrics: "[intro] [outro]",
        output_format: "url",
      }),
    });

    expect(response.ok).toBe(true);
    
    const data = await response.json() as any;
    expect(data.base_resp?.status_code).toBe(0);
    expect(data.data?.audio).toBeTruthy();
  }, MUSIC_GENERATION_TIMEOUT);
});

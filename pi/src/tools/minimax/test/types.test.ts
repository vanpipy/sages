/**
 * MiniMax Types Tests (TDD RED Phase)
 * These tests define expected behavior for the MiniMax types
 */

import { describe, it, expect } from "bun:test";
import {
  MUSIC_MODELS,
  type MusicGenerateRequest,
  type MusicResponse,
} from "../types.js";

// ============ MUSIC_MODELS Tests ============

describe("MUSIC_MODELS", () => {
  it("should use lowercase model names", () => {
    // Critical: API requires lowercase model names
    expect(MUSIC_MODELS.MUSIC_26).toBe("music-2.6");
  });

  it("should include music-2.5+ model", () => {
    expect(MUSIC_MODELS.MUSIC_25_PLUS).toBe("music-2.5+");
  });

  it("should include music-2.5 model", () => {
    expect(MUSIC_MODELS.MUSIC_25).toBe("music-2.5");
  });
});

// ============ MusicGenerateRequest Tests ============

describe("MusicGenerateRequest", () => {
  it("should accept is_instrumental boolean field", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Peaceful piano",
      is_instrumental: true,
    };
    expect(request.is_instrumental).toBe(true);
  });

  it("should accept lyrics_optimizer boolean field", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Upbeat pop",
      lyrics_optimizer: true,
    };
    expect(request.lyrics_optimizer).toBe(true);
  });

  it("should accept output_format field", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Test music",
      output_format: "url",
    };
    expect(request.output_format).toBe("url");
  });

  it("should accept audio_setting with format, sample_rate, bitrate", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Test music",
      audio_setting: {
        format: "mp3",
        sample_rate: 44100,
        bitrate: 256000,
      },
    };
    expect(request.audio_setting?.format).toBe("mp3");
    expect(request.audio_setting?.sample_rate).toBe(44100);
    expect(request.audio_setting?.bitrate).toBe(256000);
  });

  it("should support instrumental as alias for is_instrumental (legacy)", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Test music",
      instrumental: true,
    };
    expect(request.instrumental).toBe(true);
  });
});

// ============ MusicResponse Tests ============

describe("MusicResponse", () => {
  it("should accept data.audio field (hex encoded)", () => {
    const response: MusicResponse = {
      success: true,
      data: {
        audio: "hex_encoded_audio_data_here",
        audio_url: "https://example.com/music.mp3",
        status: 2,
      },
    };
    expect(response.data?.audio).toBe("hex_encoded_audio_data_here");
  });

  it("should accept data.audio_url field", () => {
    const response: MusicResponse = {
      success: true,
      data: {
        audio_url: "https://example.com/music.mp3",
        status: 2,
      },
    };
    expect(response.data?.audio_url).toBe("https://example.com/music.mp3");
  });

  it("should accept data.status field", () => {
    const response: MusicResponse = {
      success: true,
      data: {
        status: 2,
      },
    };
    expect(response.data?.status).toBe(2);
  });
});

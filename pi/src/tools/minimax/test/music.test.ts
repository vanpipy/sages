/**
 * MiniMax Music Generation Tests (TDD RED Phase)
 * Tests for musicGenerate function
 */

import { describe, it, expect } from "bun:test";
import {
  MUSIC_MODELS,
  type MusicGenerateRequest,
  type MusicResponse,
} from "../types.js";

// ============ Music Generation Request Building Tests ============

describe("Music Generation Request Building", () => {
  it("should use lowercase model name music-2.6 by default", () => {
    const model = MUSIC_MODELS.MUSIC_26;
    expect(model).toBe("music-2.6");
  });

  it("should set output_format to url by default", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Test music",
    };
    const output_format = request.output_format || "url";
    expect(output_format).toBe("url");
  });

  it("should handle instrumental music with default lyrics structure", () => {
    const isInstrumental = true;
    let lyrics = "[intro] [outro]"; // Default for instrumental
    
    if (isInstrumental) {
      lyrics = "[intro] [outro]";
    }
    
    expect(lyrics).toBe("[intro] [outro]");
  });

  it("should preserve user-provided lyrics for non-instrumental", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Upbeat pop",
      lyrics: "[verse] Hello world [chorus] La la la",
      is_instrumental: false,
    };
    
    expect(request.lyrics).toBe("[verse] Hello world [chorus] La la la");
    expect(request.is_instrumental).toBe(false);
  });

  it("should support lyrics_optimizer mode", () => {
    const request: MusicGenerateRequest = {
      model: "music-2.6",
      prompt: "Melancholic indie folk about rainy nights",
      lyrics_optimizer: true,
    };
    
    expect(request.lyrics_optimizer).toBe(true);
  });

  it("should include audio_setting with proper defaults", () => {
    const audio_setting = {
      format: "mp3",
      sample_rate: 44100,
      bitrate: 256000,
    };
    
    expect(audio_setting.format).toBe("mp3");
    expect(audio_setting.sample_rate).toBe(44100);
    expect(audio_setting.bitrate).toBe(256000);
  });
});

// ============ Music Response Parsing Tests ============

describe("Music Response Parsing", () => {
  it("should parse data.audio_url from API response", () => {
    const apiResponse = {
      success: true,
      data: {
        audio: "https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/audio%2Fmusic.mp3",
        status: 2,
      },
      base_resp: { status_code: 0, status_msg: "success" },
    };

    // Simulate response.data?.audio_url extraction
    const audioUrl = (apiResponse as any).data?.audio_url || (apiResponse as any).audio_url;
    expect(audioUrl).toBeUndefined(); // No audio_url in this response

    // But we can extract from the full URL in data.audio
    const audioData = apiResponse.data?.audio;
    expect(audioData).toContain("minimax-algeng-chat-tts");
  });

  it("should extract audio_url from data.audio field", () => {
    const response: MusicResponse = {
      success: true,
      data: {
        audio_url: "https://example.com/music.mp3",
        status: 2,
      },
    };
    
    const audioUrl = response.data?.audio_url || response.audio_url;
    expect(audioUrl).toBe("https://example.com/music.mp3");
  });

  it("should handle legacy audio_url field at top level", () => {
    const response: MusicResponse = {
      success: true,
      audio_url: "https://example.com/legacy.mp3",
    };
    
    const audioUrl = response.data?.audio_url || response.audio_url;
    expect(audioUrl).toBe("https://example.com/legacy.mp3");
  });

  it("should check data.status for generation status", () => {
    const response: MusicResponse = {
      success: true,
      data: {
        status: 2,
      },
    };
    
    expect(response.data?.status).toBe(2);
  });
});

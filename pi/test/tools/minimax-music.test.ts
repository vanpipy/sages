import { describe, it, expect } from "bun:test";
import {
  MUSIC_MODELS,
  type MusicGenerateRequest,
  type MusicResponse,
} from "../../src/tools/minimax/types.js";

describe("MiniMax Music Module", () => {
  describe("MUSIC_MODELS constants", () => {
    it("should use lowercase model name music-2.6", () => {
      expect(MUSIC_MODELS.MUSIC_26).toBe("music-2.6");
    });

    it("should include music-2.5+ model", () => {
      expect(MUSIC_MODELS.MUSIC_25_PLUS).toBe("music-2.5+");
    });

    it("should include music-2.5 model", () => {
      expect(MUSIC_MODELS.MUSIC_25).toBe("music-2.5");
    });
  });

  describe("MusicGenerateRequest interface", () => {
    it("should accept required prompt field", () => {
      const request: MusicGenerateRequest = {
        prompt: "Peaceful ambient sleep music",
      };
      expect(request.prompt).toBe("Peaceful ambient sleep music");
    });

    it("should accept is_instrumental boolean", () => {
      const request: MusicGenerateRequest = {
        prompt: "Instrumental piano",
        is_instrumental: true,
      };
      expect(request.is_instrumental).toBe(true);
    });

    it("should accept lyrics_optimizer boolean", () => {
      const request: MusicGenerateRequest = {
        prompt: "Upbeat pop",
        lyrics_optimizer: true,
      };
      expect(request.lyrics_optimizer).toBe(true);
    });

    it("should accept output_format url or hex", () => {
      const request: MusicGenerateRequest = {
        prompt: "Test",
        output_format: "url",
      };
      expect(request.output_format).toBe("url");

      const request2: MusicGenerateRequest = {
        prompt: "Test",
        output_format: "hex",
      };
      expect(request2.output_format).toBe("hex");
    });

    it("should accept audio_setting with format, sample_rate, bitrate", () => {
      const request: MusicGenerateRequest = {
        prompt: "Test",
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

    it("should support instrumental as legacy alias", () => {
      const request: MusicGenerateRequest = {
        prompt: "Test",
        instrumental: true,
      };
      expect(request.instrumental).toBe(true);
    });
  });

  describe("MusicResponse interface", () => {
    it("should have data.audio for hex encoded audio", () => {
      const response: MusicResponse = {
        success: true,
        data: {
          audio: "hex_encoded_data_here",
          status: 2,
        },
      };
      expect(response.data?.audio).toBe("hex_encoded_data_here");
    });

    it("should have data.audio_url for URL response", () => {
      const response: MusicResponse = {
        success: true,
        data: {
          audio_url: "https://example.com/music.mp3",
          status: 2,
        },
      };
      expect(response.data?.audio_url).toBe("https://example.com/music.mp3");
    });

    it("should have data.status for generation status", () => {
      const response: MusicResponse = {
        success: true,
        data: {
          status: 2,
        },
      };
      expect(response.data?.status).toBe(2);
    });

    it("should support legacy top-level audio_url", () => {
      const response: MusicResponse = {
        success: true,
        audio_url: "https://example.com/legacy.mp3",
      };
      expect(response.audio_url).toBe("https://example.com/legacy.mp3");
    });
  });

  describe("createMiniMax function", () => {
    it("should export createMiniMax function", async () => {
      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      expect(typeof createMiniMax).toBe("function");
    });

    it("should export initMiniMaxSkill function", async () => {
      const { initMiniMaxSkill } = await import("../../src/tools/minimax/index.js");
      expect(typeof initMiniMaxSkill).toBe("function");
    });
  });
});

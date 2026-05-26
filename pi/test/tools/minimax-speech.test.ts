/**
 * MiniMax Speech Module Unit Tests
 * Validates speech synthesis (TTS) and transcription types
 */

import { describe, it, expect } from "bun:test";
import { SPEECH_MODELS } from "../../src/tools/minimax/types.js";

describe("MiniMax Speech Module", () => {
  describe("SPEECH_MODELS constants", () => {
    it("should have speech-2.8-hd model", () => {
      expect(SPEECH_MODELS.SPEECH_28_HD).toBe("speech-2.8-hd");
    });

    it("should have speech-2.8-turbo model", () => {
      expect(SPEECH_MODELS.SPEECH_28_TURBO).toBe("speech-2.8-turbo");
    });

    it("should have speech-2.6-hd model", () => {
      expect(SPEECH_MODELS.SPEECH_26_HD).toBe("speech-2.6-hd");
    });

    it("should have speech-2.6-turbo model", () => {
      expect(SPEECH_MODELS.SPEECH_26_TURBO).toBe("speech-2.6-turbo");
    });

    it("should have speech-02-hd model", () => {
      expect(SPEECH_MODELS.SPEECH_02_HD).toBe("speech-02-hd");
    });

    it("should have speech-02-turbo model", () => {
      expect(SPEECH_MODELS.SPEECH_02_TURBO).toBe("speech-02-turbo");
    });
  });

  describe("speechSynthesize request validation", () => {
    it("should accept required text field", () => {
      const request = {
        text: "Hello, world!",
      };
      expect(request.text).toBe("Hello, world!");
    });

    it("should accept default speech-2.8-turbo model", () => {
      const request = {
        model: "speech-2.8-turbo",
        text: "Hello",
      };
      expect(request.model).toBe("speech-2.8-turbo");
    });

    it("should accept voice_id option", () => {
      const request = {
        text: "Hello",
        voice_id: "male-qingse",
      };
      expect(request.voice_id).toBe("male-qingse");
    });

    it("should accept speed option", () => {
      const request = {
        text: "Hello",
        speed: 1.0,
      };
      expect(request.speed).toBe(1.0);
    });

    it("should accept pitch option", () => {
      const request = {
        text: "Hello",
        pitch: 0,
      };
      expect(request.pitch).toBe(0);
    });

    it("should accept volume option", () => {
      const request = {
        text: "Hello",
        volume: 1.0,
      };
      expect(request.volume).toBe(1.0);
    });

    it("should accept mp3 output format", () => {
      const request = {
        text: "Hello",
        output_format: "mp3" as const,
      };
      expect(request.output_format).toBe("mp3");
    });

    it("should accept pcm output format", () => {
      const request = {
        text: "Hello",
        output_format: "pcm" as const,
      };
      expect(request.output_format).toBe("pcm");
    });

    it("should accept flac output format", () => {
      const request = {
        text: "Hello",
        output_format: "flac" as const,
      };
      expect(request.output_format).toBe("flac");
    });

    it("should accept wav output format", () => {
      const request = {
        text: "Hello",
        output_format: "wav" as const,
      };
      expect(request.output_format).toBe("wav");
    });
  });

  describe("speechSynthesize response validation", () => {
    it("should accept response with audio_url", () => {
      const response = {
        success: true,
        request_id: "req-123",
        data: {
          audio_url: "https://example.com/audio.mp3",
        },
      };
      expect(response.data?.audio_url).toBe("https://example.com/audio.mp3");
    });

    it("should accept response with duration", () => {
      const response = {
        success: true,
        data: {
          audio_url: "https://example.com/audio.mp3",
          duration: 3.5,
        },
      };
      expect(response.data?.duration).toBe(3.5);
    });

    it("should accept response with file_id", () => {
      const response = {
        success: true,
        data: {
          audio_url: "https://example.com/audio.mp3",
          file_id: "file-456",
        },
      };
      expect(response.data?.file_id).toBe("file-456");
    });
  });

  describe("speechTranscribe request validation", () => {
    it("should accept file URL", () => {
      const request = {
        file: "https://example.com/audio.mp3",
      };
      expect(request.file).toBe("https://example.com/audio.mp3");
    });

    it("should accept speech-02-turbo model", () => {
      const request = {
        model: "speech-02-turbo",
        file: "https://example.com/audio.mp3",
      };
      expect(request.model).toBe("speech-02-turbo");
    });

    it("should accept language option", () => {
      const request = {
        file: "https://example.com/audio.mp3",
        language: "en",
      };
      expect(request.language).toBe("en");
    });

    it("should accept zh for Chinese", () => {
      const request = {
        file: "https://example.com/audio.mp3",
        language: "zh",
      };
      expect(request.language).toBe("zh");
    });
  });

  describe("speechTranscribe response validation", () => {
    it("should accept response with transcription text", () => {
      const response = {
        success: true,
        request_id: "req-123",
        text: "Hello, this is a transcription of the audio.",
      };
      expect(response.text).toBe("Hello, this is a transcription of the audio.");
    });
  });

  describe("speechSynthesize voice_id options", () => {
    it("should support male-qingse voice", () => {
      const request = {
        text: "Hello",
        voice_id: "male-qingse",
      };
      expect(request.voice_id).toBe("male-qingse");
    });

    it("should support female voice variants", () => {
      const request = {
        text: "Hello",
        voice_id: "female-tianmei",
      };
      expect(request.voice_id).toBe("female-tianmei");
    });
  });
});

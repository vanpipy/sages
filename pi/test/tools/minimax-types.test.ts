/**
 * MiniMax Types Unit Tests
 * Validates TypeScript type definitions and constants
 */

import { describe, it, expect } from "bun:test";
import {
  TEXT_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  SPEECH_MODELS,
  MUSIC_MODELS,
  KNOWN_API_HOSTS,
  type MiniMaxConfig,
  type ChatMessage,
  type ChatCompletionRequest,
  type VideoGenerateRequest,
  type VideoResponse,
  type SpeechSynthesizeRequest,
  type SpeechResponse,
  type SpeechTranscribeRequest,
  type TranscriptionResponse,
  type VisionRequest,
  type VisionResponse,
  type VisionContent,
  type SearchRequest,
  type SearchResponse,
} from "../../src/tools/minimax/types.js";

describe("MiniMax Types", () => {
  describe("TEXT_MODELS", () => {
    it("should have M2_7 model", () => {
      expect(TEXT_MODELS.M2_7).toBe("MiniMax-M2.7");
    });

    it("should have M2_7_HIGHSPEED model", () => {
      expect(TEXT_MODELS.M2_7_HIGHSPEED).toBe("MiniMax-M2.7-highspeed");
    });

    it("should have M2_5 model", () => {
      expect(TEXT_MODELS.M2_5).toBe("MiniMax-M2.5");
    });

    it("should have M2_1 model", () => {
      expect(TEXT_MODELS.M2_1).toBe("MiniMax-M2.1");
    });

    it("should have M2 model", () => {
      expect(TEXT_MODELS.M2).toBe("MiniMax-M2");
    });
  });

  describe("IMAGE_MODELS", () => {
    it("should have IMAGE_01 model", () => {
      expect(IMAGE_MODELS.IMAGE_01).toBe("image-01");
    });

    it("should have IMAGE_01_PRO model", () => {
      expect(IMAGE_MODELS.IMAGE_01_PRO).toBe("image-01-pro");
    });
  });

  describe("VIDEO_MODELS", () => {
    it("should have HAILUO_23 model", () => {
      expect(VIDEO_MODELS.HAILUO_23).toBe("Hailuo-2.3");
    });

    it("should have HAILUO_23_FAST model", () => {
      expect(VIDEO_MODELS.HAILUO_23_FAST).toBe("Hailuo-2.3-Fast");
    });
  });

  describe("SPEECH_MODELS", () => {
    it("should have speech-2.8-hd model", () => {
      expect(SPEECH_MODELS.SPEECH_28_HD).toBe("speech-2.8-hd");
    });

    it("should have speech-2.8-turbo model", () => {
      expect(SPEECH_MODELS.SPEECH_28_TURBO).toBe("speech-2.8-turbo");
    });

    it("should have speech-2.6-hd model", () => {
      expect(SPEECH_MODELS.SPEECH_26_HD).toBe("speech-2.6-hd");
    });

    it("should have speech-02-turbo model", () => {
      expect(SPEECH_MODELS.SPEECH_02_TURBO).toBe("speech-02-turbo");
    });
  });

  describe("MUSIC_MODELS", () => {
    it("should have music-2.6 model", () => {
      expect(MUSIC_MODELS.MUSIC_26).toBe("music-2.6");
    });

    it("should have music-2.5+ model", () => {
      expect(MUSIC_MODELS.MUSIC_25_PLUS).toBe("music-2.5+");
    });

    it("should have music-2.5 model", () => {
      expect(MUSIC_MODELS.MUSIC_25).toBe("music-2.5");
    });
  });

  describe("KNOWN_API_HOSTS", () => {
    it("should include CN platform host", () => {
      expect(KNOWN_API_HOSTS).toContain("https://api.minimaxi.com");
    });

    it("should include Global platform host", () => {
      expect(KNOWN_API_HOSTS).toContain("https://api.minimax.io");
    });

    it("should include legacy CN redirect host", () => {
      expect(KNOWN_API_HOSTS).toContain("https://api.minimax.chat");
    });
  });

  describe("MiniMaxConfig interface", () => {
    it("should accept apiKey only", () => {
      const config: MiniMaxConfig = { apiKey: "sk-test" };
      expect(config.apiKey).toBe("sk-test");
      expect(config.groupId).toBeUndefined();
      expect(config.baseURL).toBeUndefined();
    });

    it("should accept apiKey with optional fields", () => {
      const config: MiniMaxConfig = {
        apiKey: "sk-test",
        groupId: "group-123",
        baseURL: "https://api.minimaxi.com",
        timeout: 60000,
      };
      expect(config.apiKey).toBe("sk-test");
      expect(config.groupId).toBe("group-123");
      expect(config.baseURL).toBe("https://api.minimaxi.com");
      expect(config.timeout).toBe(60000);
    });
  });

  describe("ChatMessage interface", () => {
    it("should accept user role", () => {
      const msg: ChatMessage = { role: "user", content: "Hello" };
      expect(msg.role).toBe("user");
    });

    it("should accept system role", () => {
      const msg: ChatMessage = { role: "system", content: "You are helpful" };
      expect(msg.role).toBe("system");
    });

    it("should accept assistant role", () => {
      const msg: ChatMessage = { role: "assistant", content: "Hi there" };
      expect(msg.role).toBe("assistant");
    });
  });

  describe("ChatCompletionRequest interface", () => {
    it("should accept required messages field", () => {
      const req: ChatCompletionRequest = {
        messages: [{ role: "user", content: "Hi" }],
      };
      expect(req.messages).toHaveLength(1);
    });

    it("should accept optional model field", () => {
      const req: ChatCompletionRequest = {
        model: "MiniMax-M2.7",
        messages: [{ role: "user", content: "Hi" }],
      };
      expect(req.model).toBe("MiniMax-M2.7");
    });

    it("should accept streaming option", () => {
      const req: ChatCompletionRequest = {
        model: "MiniMax-M2.7",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      };
      expect(req.stream).toBe(true);
    });
  });

  describe("VideoGenerateRequest interface", () => {
    it("should accept required prompt field", () => {
      const req: VideoGenerateRequest = {
        prompt: "A cat playing piano",
      };
      expect(req.prompt).toBe("A cat playing piano");
    });

    it("should accept optional model field", () => {
      const req: VideoGenerateRequest = {
        model: "Hailuo-2.3",
        prompt: "A cat playing piano",
      };
      expect(req.model).toBe("Hailuo-2.3");
    });

    it("should accept duration in seconds", () => {
      const req: VideoGenerateRequest = {
        prompt: "A cat playing piano",
        duration: 6,
      };
      expect(req.duration).toBe(6);
    });

    it("should accept fps option", () => {
      const req: VideoGenerateRequest = {
        prompt: "A cat playing piano",
        fps: 24,
      };
      expect(req.fps).toBe(24);
    });

    it("should accept resolution option", () => {
      const req720p: VideoGenerateRequest = {
        prompt: "A cat playing piano",
        resolution: "720p",
      };
      expect(req720p.resolution).toBe("720p");

      const req1080p: VideoGenerateRequest = {
        prompt: "A cat playing piano",
        resolution: "1080p",
      };
      expect(req1080p.resolution).toBe("1080p");
    });
  });

  describe("VideoResponse interface", () => {
    it("should accept task_id", () => {
      const resp: VideoResponse = {
        success: true,
        task_id: "task-123",
      };
      expect(resp.task_id).toBe("task-123");
    });

    it("should accept video_url", () => {
      const resp: VideoResponse = {
        success: true,
        video_url: "https://example.com/video.mp4",
      };
      expect(resp.video_url).toBe("https://example.com/video.mp4");
    });

    it("should accept status", () => {
      const resp: VideoResponse = {
        success: true,
        status: "completed",
      };
      expect(resp.status).toBe("completed");
    });
  });

  describe("SpeechSynthesizeRequest interface", () => {
    it("should accept required text field", () => {
      const req: SpeechSynthesizeRequest = {
        text: "Hello, world!",
      };
      expect(req.text).toBe("Hello, world!");
    });

    it("should accept voice_id option", () => {
      const req: SpeechSynthesizeRequest = {
        text: "Hello",
        voice_id: "male-qingse",
      };
      expect(req.voice_id).toBe("male-qingse");
    });

    it("should accept speed option", () => {
      const req: SpeechSynthesizeRequest = {
        text: "Hello",
        speed: 1.0,
      };
      expect(req.speed).toBe(1.0);
    });

    it("should accept output_format option", () => {
      const mp3Req: SpeechSynthesizeRequest = {
        text: "Hello",
        output_format: "mp3",
      };
      expect(mp3Req.output_format).toBe("mp3");

      const pcmReq: SpeechSynthesizeRequest = {
        text: "Hello",
        output_format: "pcm",
      };
      expect(pcmReq.output_format).toBe("pcm");

      const flacReq: SpeechSynthesizeRequest = {
        text: "Hello",
        output_format: "flac",
      };
      expect(flacReq.output_format).toBe("flac");

      const wavReq: SpeechSynthesizeRequest = {
        text: "Hello",
        output_format: "wav",
      };
      expect(wavReq.output_format).toBe("wav");
    });
  });

  describe("SpeechResponse interface", () => {
    it("should accept data with audio_url", () => {
      const resp: SpeechResponse = {
        success: true,
        data: {
          audio_url: "https://example.com/audio.mp3",
        },
      };
      expect(resp.data?.audio_url).toBe("https://example.com/audio.mp3");
    });

    it("should accept data with duration", () => {
      const resp: SpeechResponse = {
        success: true,
        data: {
          audio_url: "https://example.com/audio.mp3",
          duration: 5.5,
        },
      };
      expect(resp.data?.duration).toBe(5.5);
    });
  });

  describe("SpeechTranscribeRequest interface", () => {
    it("should accept file field", () => {
      const req: SpeechTranscribeRequest = {
        file: "https://example.com/audio.mp3",
      };
      expect(req.file).toBe("https://example.com/audio.mp3");
    });

    it("should accept language option", () => {
      const req: SpeechTranscribeRequest = {
        file: "https://example.com/audio.mp3",
        language: "en",
      };
      expect(req.language).toBe("en");
    });
  });

  describe("TranscriptionResponse interface", () => {
    it("should accept text field", () => {
      const resp: TranscriptionResponse = {
        success: true,
        text: "Hello, this is a transcription",
      };
      expect(resp.text).toBe("Hello, this is a transcription");
    });
  });

  describe("VisionContent interface", () => {
    it("should accept text content type", () => {
      const content: VisionContent = {
        type: "text",
        text: "What is in this image?",
      };
      expect(content.type).toBe("text");
      expect(content.text).toBe("What is in this image?");
    });

    it("should accept image_url content type", () => {
      const content: VisionContent = {
        type: "image_url",
        image_url: {
          url: "https://example.com/image.jpg",
        },
      };
      expect(content.type).toBe("image_url");
      expect(content.image_url?.url).toBe("https://example.com/image.jpg");
    });

    it("should accept image_url with detail option", () => {
      const content: VisionContent = {
        type: "image_url",
        image_url: {
          url: "https://example.com/image.jpg",
          detail: "high",
        },
      };
      expect(content.image_url?.detail).toBe("high");
    });
  });

  describe("VisionRequest interface", () => {
    it("should accept messages array", () => {
      const req: VisionRequest = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
      };
      expect(req.messages).toHaveLength(1);
      expect(req.messages[0].content).toHaveLength(2);
    });

    it("should accept optional max_tokens", () => {
      const req: VisionRequest = {
        model: "MiniMax-VL-01",
        messages: [{ role: "user", content: [{ type: "text", text: "?" }] }],
        max_tokens: 2048,
      };
      expect(req.max_tokens).toBe(2048);
    });
  });

  describe("VisionResponse interface", () => {
    it("should accept choices array", () => {
      const resp: VisionResponse = {
        success: true,
        id: "vision-123",
        model: "MiniMax-VL-01",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "This is a cat image.",
            },
            finish_reason: "stop",
          },
        ],
      };
      expect(resp.choices).toHaveLength(1);
      expect(resp.choices[0].message.content).toBe("This is a cat image.");
    });
  });

  describe("SearchRequest interface", () => {
    it("should accept required query field", () => {
      const req: SearchRequest = {
        query: "MiniMax AI latest news",
      };
      expect(req.query).toBe("MiniMax AI latest news");
    });

    it("should accept optional num_results", () => {
      const req: SearchRequest = {
        query: "MiniMax AI",
        num_results: 10,
      };
      expect(req.num_results).toBe(10);
    });
  });

  describe("SearchResponse interface", () => {
    it("should accept organic results", () => {
      const resp: SearchResponse = {
        success: true,
        organic: [
          {
            title: "MiniMax AI",
            link: "https://minimax.io",
            snippet: "MiniMax is an AI company",
            date: "2024-01-01",
          },
        ],
      };
      expect(resp.organic).toHaveLength(1);
      expect(resp.organic?.[0].title).toBe("MiniMax AI");
    });

    it("should accept related searches", () => {
      const resp: SearchResponse = {
        success: true,
        related_searches: [
          { query: "MiniMax video generation" },
          { query: "MiniMax speech synthesis" },
        ],
      };
      expect(resp.related_searches).toHaveLength(2);
    });
  });
});

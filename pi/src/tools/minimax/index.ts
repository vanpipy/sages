/**
 * MiniMax Skill for pi
 * All 7 capabilities: text, image, video, speech, music, vision, search
 * 
 * Supports:
 * - API Plan: Full API access
 * - Token Plan: MCP endpoints (search, vision) + M2.7 text models
 * 
 * Auto-detects the correct API host based on the API key.
 */

import { loadCredentials, cacheCredentials, getCredentials, detectApiHost, getApiHost } from "./auth.js";
import { MiniMaxError, parseAPIError } from "./errors.js";
import {
  TEXT_MODELS,
  MUSIC_MODELS,
  type MiniMaxConfig,
  type MiniMaxClient,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatStreamChunk,
  type ImageGenerateRequest,
  type ImageEditRequest,
  type ImageResponse,
  type VideoGenerateRequest,
  type VideoResponse,
  type SpeechSynthesizeRequest,
  type SpeechResponse,
  type SpeechTranscribeRequest,
  type TranscriptionResponse,
  type MusicGenerateRequest,
  type MusicResponse,
  type VisionRequest,
  type VisionResponse,
  type SearchRequest,
  type SearchResponse,
} from "./types.js";

/**
 * API endpoint paths
 */
const ENDPOINTS = {
  // Text
  TEXT_CHAT: "/v1/text/chatcompletion_v2",
  
  // Image
  IMAGE_GENERATION: "/v1/image_generation",
  IMAGE_EDITING: "/v1/image_editing",
  
  // Video
  VIDEO_GENERATION: "/v1/video_generation",
  
  // Speech
  SPEECH_T2A: "/v1/t2a_v2",
  SPEECH_ASYNC: "/v1/t2a_async",
  SPEECH_TRANSCRIBE: "/v1/audio/transcription",
  
  // Music
  MUSIC_GENERATION: "/v1/music_generation",
  
  // Vision
  VISION_CHAT: "/v1/vision/chatcompletion_v2",
  
  // Token Plan MCP endpoints
  SEARCH: "/v1/coding_plan/search",
  VLM: "/v1/coding_plan/vlm",
} as const;

/**
 * Internal API caller with auth and error handling
 */
async function apiCall<T>(
  endpoint: string,
  config: { baseURL: string; timeout?: number },
  body: unknown,
  apiKey: string,
  groupId?: string
): Promise<T> {
  const url = `${config.baseURL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "MM-API-Source": "pi-skill",
  };

  if (groupId) {
    headers["GroupId"] = groupId;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeout || 60000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new MiniMaxError("Request timeout", "timeout");
    }
    throw new MiniMaxError(
      error instanceof Error ? error.message : "Network error",
      "network"
    );
  }

  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    throw new MiniMaxError("Invalid JSON response from API", "parse");
  }

  // Check for API errors
  const baseResp = data.base_resp as { status_code?: number; status_msg?: string } | undefined;
  if (baseResp && baseResp.status_code !== 0) {
    throw parseAPIError(data);
  }

  if (!response.ok) {
    throw new MiniMaxError(
      `HTTP ${response.status}: ${baseResp?.status_msg || "Unknown error"}`,
      "http"
    );
  }

  return data as T;
}

/**
 * Stream API caller
 */
async function apiStreamCall(
  endpoint: string,
  config: { baseURL: string; timeout?: number },
  body: unknown,
  apiKey: string,
  groupId?: string,
  onChunk?: (chunk: ChatStreamChunk) => void
): Promise<void> {
  const url = `${config.baseURL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "MM-API-Source": "pi-skill",
  };

  if (groupId) {
    headers["GroupId"] = groupId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout || 120000),
  });

  if (!response.ok) {
    const data = await response.json() as Record<string, unknown>;
    const baseResp = data.base_resp as { status_code?: number; status_msg?: string } | undefined;
    throw new MiniMaxError(
      `HTTP ${response.status}: ${baseResp?.status_msg || "Unknown error"}`,
      "http"
    );
  }

  if (!response.body) {
    throw new MiniMaxError("No response body for streaming", "parse");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      const lines = text.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data) as ChatStreamChunk;
            // MiniMax streams content in delta.message.content
            if (chunk.choices?.[0]?.delta && !chunk.choices[0].delta.content) {
              // Copy message content to delta for consistency
              const message = chunk.choices[0].delta as Record<string, unknown>;
              if (message.message && typeof message.message === 'object') {
                const msgObj = message.message as Record<string, unknown>;
                chunk.choices[0].delta.content = msgObj.content as string || '';
              }
            }
            onChunk?.(chunk);
          } catch {
            // Skip malformed chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Create MiniMax client instance
 */
export function createMiniMax(config: MiniMaxConfig): MiniMaxClient {
  const baseURL = getApiHost(config.baseURL);

  return {
    // ============ TEXT (CHAT) ============
    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const body = {
        model: request.model || TEXT_MODELS.M2_7,
        messages: request.messages,
        max_tokens: request.max_tokens ?? 4096,
        temperature: request.temperature ?? 0.7,
        top_p: request.top_p ?? 0.95,
        stream: false,
      };

      return apiCall<ChatCompletionResponse>(
        ENDPOINTS.TEXT_CHAT,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    async chatStream(
      request: ChatCompletionRequest,
      onChunk: (chunk: ChatStreamChunk) => void
    ): Promise<void> {
      const body = {
        model: request.model || TEXT_MODELS.M2_7,
        messages: request.messages,
        max_tokens: request.max_tokens ?? 4096,
        temperature: request.temperature ?? 0.7,
        top_p: request.top_p ?? 0.95,
        stream: true,
      };

      await apiStreamCall(
        ENDPOINTS.TEXT_CHAT,
        { baseURL },
        body,
        config.apiKey,
        config.groupId,
        onChunk
      );
    },

    // ============ IMAGE ============
    async imageGenerate(request: ImageGenerateRequest): Promise<ImageResponse> {
      const body = {
        model: request.model || "image-01",
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        num_images: request.num_images ?? 1,
        sample: request.sample,
      };

      return apiCall<ImageResponse>(
        ENDPOINTS.IMAGE_GENERATION,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    async imageEdit(request: ImageEditRequest): Promise<ImageResponse> {
      const body = {
        model: request.model || "image-01",
        prompt: request.prompt,
        image: request.image,
        mask: request.mask,
        width: request.width,
        height: request.height,
        num_images: request.num_images ?? 1,
        sample: request.sample,
      };

      return apiCall<ImageResponse>(
        ENDPOINTS.IMAGE_EDITING,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    // ============ VIDEO ============
    async videoGenerate(request: VideoGenerateRequest): Promise<VideoResponse> {
      const body = {
        model: request.model || "Hailuo-2.3",
        prompt: request.prompt,
        duration: request.duration ?? 6,
        fps: request.fps ?? 24,
        resolution: request.resolution ?? "768p",
      };

      return apiCall<VideoResponse>(
        ENDPOINTS.VIDEO_GENERATION,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    // ============ SPEECH (TTS) ============
    async speechSynthesize(request: SpeechSynthesizeRequest): Promise<SpeechResponse> {
      const body = {
        model: request.model || "speech-2.8-turbo",
        text: request.text,
        voice_setting: {
          voice_id: request.voice_id || "male-qingse",
          speed: request.speed ?? 1.0,
          pitch: request.pitch ?? 0,
          volume: request.volume ?? 1.0,
        },
        output_format: request.output_format || "mp3",
      };

      return apiCall<SpeechResponse>(
        ENDPOINTS.SPEECH_T2A,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    async speechTranscribe(request: SpeechTranscribeRequest): Promise<TranscriptionResponse> {
      const body = {
        model: request.model || "speech-02-turbo",
        file: request.file,
        language: request.language,
      };

      return apiCall<TranscriptionResponse>(
        ENDPOINTS.SPEECH_TRANSCRIBE,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    // ============ MUSIC ============
    async musicGenerate(request: MusicGenerateRequest): Promise<MusicResponse> {
      // Handle both instrumental (boolean) and is_instrumental
      const isInstrumental = request.is_instrumental ?? request.instrumental ?? false;
      
      // For instrumental music, provide default lyrics structure if not supplied
      let lyrics = request.lyrics;
      if (isInstrumental && !lyrics && !request.lyrics_optimizer) {
        lyrics = "[intro] [outro]";
      }

      const body = {
        model: request.model || MUSIC_MODELS.MUSIC_26, // Use lowercase model name
        prompt: request.prompt || "",
        duration: request.duration,
        lyrics: lyrics,
        is_instrumental: isInstrumental,
        lyrics_optimizer: request.lyrics_optimizer,
        output_format: request.output_format || "url",
        audio_setting: request.audio_setting || {
          format: "mp3",
          sample_rate: 44100,
          bitrate: 256000,
        },
      };

      return apiCall<MusicResponse>(
        ENDPOINTS.MUSIC_GENERATION,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    // ============ VISION ============
    async vision(request: VisionRequest): Promise<VisionResponse> {
      const body = {
        model: request.model || "MiniMax-VL-01",
        messages: request.messages,
        max_tokens: request.max_tokens ?? 4096,
      };

      return apiCall<VisionResponse>(
        ENDPOINTS.VISION_CHAT,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },

    // ============ SEARCH (Token Plan MCP) ============
    async search(request: SearchRequest): Promise<SearchResponse> {
      const body = {
        q: request.query,
        num_results: request.num_results ?? 10,
      };

      return apiCall<SearchResponse>(
        ENDPOINTS.SEARCH,
        { baseURL },
        body,
        config.apiKey,
        config.groupId
      );
    },
  };
}

// ============ Convenience Exports ============

export { loadCredentials, cacheCredentials, getCredentials, detectApiHost, getApiHost } from "./auth.js";
export {
  MiniMaxError,
  AuthenticationError,
  RateLimitError,
  ValidationError,
  APIError,
  NetworkError,
} from "./errors.js";
export * from "./types.js";

// ============ Skill Entry Point ============

/**
 * Initialize MiniMax skill with auto-auth and auto-detection
 * Use this as the main entry point for pi skill integration
 */
export async function initMiniMaxSkill(
  promptFn?: (message: string) => Promise<string>
): Promise<MiniMaxClient> {
  const authResult = await getCredentials(promptFn);

  // Auto-detect API host if not already set
  let apiHost = authResult.apiHost;
  if (!apiHost) {
    apiHost = await detectApiHost(authResult.credentials.apiKey);
  }

  return createMiniMax({
    apiKey: authResult.credentials.apiKey,
    groupId: authResult.credentials.groupId,
    baseURL: apiHost || getApiHost(),
  });
}

export default { createMiniMax, initMiniMaxSkill };

/**
 * MiniMax Skill for pi
 * All 7 capabilities: text, image, video, speech, music, vision, search
 */

import { loadCredentials, cacheCredentials, getCredentials } from "./auth";
import { MiniMaxError, parseAPIError } from "./errors";
import type {
  MiniMaxConfig,
  MiniMaxClient,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatStreamChunk,
  ImageGenerateRequest,
  ImageEditRequest,
  ImageResponse,
  VideoGenerateRequest,
  VideoResponse,
  SpeechSynthesizeRequest,
  SpeechResponse,
  SpeechTranscribeRequest,
  TranscriptionResponse,
  MusicGenerateRequest,
  MusicResponse,
  VisionRequest,
  VisionResponse,
  SearchRequest,
  SearchResponse,
} from "./types";

const DEFAULT_BASE_URL = "https://api.minimax.chat/v1";

/**
 * Internal API caller with auth and error handling
 */
async function apiCall<T>(
  endpoint: string,
  config: MiniMaxConfig,
  body: unknown
): Promise<T> {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new MiniMaxError("No credentials available");
  }

  const url = `${config.baseURL || DEFAULT_BASE_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${credentials.credentials.apiKey}`,
  };

  if (credentials.credentials.groupId) {
    headers["GroupId"] = credentials.credentials.groupId;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeout || 60000),
    });

    const data = await response.json() as { msg?: string; code?: number; status_code?: number };

    if (!response.ok) {
      throw parseAPIError(data);
    }

    return data as T;
  } catch (error) {
    if (error instanceof MiniMaxError) {
      throw error;
    }
    throw new MiniMaxError(
      error instanceof Error ? error.message : "Request failed"
    );
  }
}

/**
 * Stream API caller
 */
async function apiStreamCall(
  endpoint: string,
  config: MiniMaxConfig,
  body: unknown,
  onChunk: (chunk: ChatStreamChunk) => void
): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new MiniMaxError("No credentials available");
  }

  const url = `${config.baseURL || DEFAULT_BASE_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${credentials.credentials.apiKey}`,
  };

  if (credentials.credentials.groupId) {
    headers["GroupId"] = credentials.credentials.groupId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout || 120000),
  });

  if (!response.ok) {
    const data = await response.json() as { msg?: string; code?: number; status_code?: number };
    throw parseAPIError(data);
  }

  if (!response.body) {
    throw new MiniMaxError("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      const lines = text.split("\n").filter((line: string) => line.trim());

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data);
            onChunk(chunk);
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
  return {
    // ============ TEXT (CHAT) ============
    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      return apiCall<ChatCompletionResponse>("/text/chatcompletion_v2", config, request);
    },

    async chatStream(
      request: ChatCompletionRequest,
      onChunk: (chunk: ChatStreamChunk) => void
    ): Promise<void> {
      await apiStreamCall("/text/chatcompletion_v2", config, request, onChunk);
    },

    // ============ IMAGE ============
    async imageGenerate(request: ImageGenerateRequest): Promise<ImageResponse> {
      return apiCall<ImageResponse>("/image_generation", config, request);
    },

    async imageEdit(request: ImageEditRequest): Promise<ImageResponse> {
      return apiCall<ImageResponse>("/image_editing", config, request);
    },

    // ============ VIDEO ============
    async videoGenerate(request: VideoGenerateRequest): Promise<VideoResponse> {
      return apiCall<VideoResponse>("/video_generation", config, request);
    },

    // ============ SPEECH (TTS) ============
    async speechSynthesize(request: SpeechSynthesizeRequest): Promise<SpeechResponse> {
      return apiCall<SpeechResponse>("/t2a_v2", config, request);
    },

    async speechTranscribe(request: SpeechTranscribeRequest): Promise<TranscriptionResponse> {
      return apiCall<TranscriptionResponse>("/audio/transcription", config, request);
    },

    // ============ MUSIC ============
    async musicGenerate(request: MusicGenerateRequest): Promise<MusicResponse> {
      return apiCall<MusicResponse>("/music_generation", config, request);
    },

    // ============ VISION ============
    async vision(request: VisionRequest): Promise<VisionResponse> {
      return apiCall<VisionResponse>("/vision/chatcompletion_v2", config, request);
    },

    // ============ SEARCH ============
    async search(request: SearchRequest): Promise<SearchResponse> {
      return apiCall<SearchResponse>("/search", config, request);
    },
  };
}

// ============ Convenience Exports ============

export { loadCredentials, cacheCredentials, getCredentials } from "./auth.js";
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
 * Initialize MiniMax skill with auto-auth
 * Use this as the main entry point for pi skill integration
 */
export async function initMiniMaxSkill(
  promptFn?: (message: string) => Promise<string>
): Promise<MiniMaxClient> {
  const authResult = await getCredentials(promptFn);

  return createMiniMax({
    apiKey: authResult.credentials.apiKey,
    groupId: authResult.credentials.groupId,
  });
}

export default { createMiniMax, initMiniMaxSkill };

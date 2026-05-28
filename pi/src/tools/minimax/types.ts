/**
 * MiniMax TypeScript Interfaces
 * All 7 capabilities: text, image, video, speech, music, vision, search
 * 
 * Supports both API Plan and Token Plan:
 * - API Plan: Full API access (chat, image, video, speech, music)
 * - Token Plan: MCP endpoints (search, vision) + M2.7 text models
 */

// ============ Known API Hosts ============

export const KNOWN_API_HOSTS = [
  "https://api.minimaxi.com",     // CN Platform (primary for CN keys)
  "https://api.minimax.io",       // Global Platform
  "https://api.minimax.chat",    // Legacy CN redirect
] as const;

export type KnownApiHost = typeof KNOWN_API_HOSTS[number];

// ============ Supported Models ============

export const TEXT_MODELS = {
  M2_7: "MiniMax-M2.7",
  M2_7_HIGHSPEED: "MiniMax-M2.7-highspeed",
  M2_5: "MiniMax-M2.5",
  M2_5_HIGHSPEED: "MiniMax-M2.5-highspeed",
  M2_1: "MiniMax-M2.1",
  M2_1_HIGHSPEED: "MiniMax-M2.1-highspeed",
  M2: "MiniMax-M2",
} as const;

export const IMAGE_MODELS = {
  IMAGE_01: "image-01",
  IMAGE_01_PRO: "image-01-pro",
} as const;

export const VIDEO_MODELS = {
  HAILUO_23: "Hailuo-2.3",
  HAILUO_23_FAST: "Hailuo-2.3-Fast",
} as const;

export const SPEECH_MODELS = {
  SPEECH_28_HD: "speech-2.8-hd",
  SPEECH_28_TURBO: "speech-2.8-turbo",
  SPEECH_26_HD: "speech-2.6-hd",
  SPEECH_26_TURBO: "speech-2.6-turbo",
  SPEECH_02_HD: "speech-02-hd",
  SPEECH_02_TURBO: "speech-02-turbo",
} as const;

export const MUSIC_MODELS = {
  MUSIC_26: "music-2.6",
  MUSIC_25_PLUS: "music-2.5+",
  MUSIC_25: "music-2.5",
} as const;

// ============ Common Types ============

export interface BaseResponse {
  success: boolean;
  request_id?: string;
  cost?: number;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

export interface MiniMaxConfig {
  apiKey: string;
  groupId?: string;
  baseURL?: string;
  timeout?: number;
}

export interface MiniMaxCredentials {
  apiKey: string;
  groupId?: string;
}

// ============ Text (Chat) Types ============

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse extends BaseResponse {
  id: string;
  model: string;
  object: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason?: string;
  }>;
}

// ============ Image Types ============

export interface ImageGenerateRequest {
  model?: string;
  prompt: string;
  width?: number;
  height?: number;
  num_images?: number;
  sample?: number;
}

export interface ImageResponse extends BaseResponse {
  image_list?: Array<{
    url?: string;
    base64?: string;
  }>;
}

export interface ImageEditRequest extends ImageGenerateRequest {
  image?: string; // base64 or URL
  mask?: string;
}

// ============ Video Types ============

export interface VideoGenerateRequest {
  model?: string;
  prompt: string;
  duration?: number; // seconds, max 10
  fps?: number;
  resolution?: "720p" | "1080p";
}

export interface VideoResponse extends BaseResponse {
  task_id?: string;
  status?: string;
  video_url?: string;
}

// ============ Speech (TTS) Types ============

export interface SpeechSynthesizeRequest {
  model?: string;
  text: string;
  voice_id?: string;
  speed?: number;
  pitch?: number;
  volume?: number;
  output_format?: "mp3" | "pcm" | "flac" | "wav";
}

export interface SpeechResponse extends BaseResponse {
  data?: {
    audio_url?: string;
    duration?: number;
    file_id?: string;
  };
}

export interface SpeechTranscribeRequest {
  model?: string;
  file?: string; // file path or URL
  language?: string;
}

export interface TranscriptionResponse extends BaseResponse {
  text?: string;
}

// ============ Music Types ============

export interface MusicGenerateRequest {
  model?: string;
  prompt?: string;
  lyrics?: string;
  is_instrumental?: boolean;
  lyrics_optimizer?: boolean;
  duration?: number;
  output_format?: "url" | "hex";
  audio_setting?: {
    format?: string;
    sample_rate?: number;
    bitrate?: number;
    channel?: number;
  };
  instrumental?: boolean; // legacy alias for is_instrumental
}

export interface MusicResponse extends BaseResponse {
  task_id?: string;
  status?: string;
  audio_url?: string;
  file_id?: string;
  data?: {
    audio?: string;      // hex-encoded audio data
    audio_url?: string;  // URL to audio file
    status?: number;      // generation status
  };
}

// ============ Vision Types ============

export interface VisionContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

export interface VisionMessage {
  role: "user" | "assistant";
  content: VisionContent[];
}

export interface VisionRequest {
  model?: string;
  messages: VisionMessage[];
  max_tokens?: number;
}

// Token Plan VLM response format
export interface VLMResponse {
  content: string;
  success?: boolean;  // Computed from base_resp.status_code
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

// Legacy API Plan Vision response (deprecated)
export interface VisionResponse extends BaseResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
}

// ============ Search Types (Token Plan MCP) ============

export interface SearchRequest {
  query: string;
  num_results?: number;
}

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  date?: string;
}

export interface RelatedSearch {
  query: string;
}

export interface SearchResponse extends BaseResponse {
  organic?: SearchResult[];
  related_searches?: RelatedSearch[];
}

// ============ MiniMax Client Interface ============

export interface MiniMaxClient {
  // Text
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatStream(
    request: ChatCompletionRequest,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<void>;

  // Image
  imageGenerate(request: ImageGenerateRequest): Promise<ImageResponse>;
  imageEdit(request: ImageEditRequest): Promise<ImageResponse>;

  // Video
  videoGenerate(request: VideoGenerateRequest): Promise<VideoResponse>;

  // Speech
  speechSynthesize(request: SpeechSynthesizeRequest): Promise<SpeechResponse>;
  speechTranscribe(
    request: SpeechTranscribeRequest
  ): Promise<TranscriptionResponse>;

  // Music
  musicGenerate(request: MusicGenerateRequest): Promise<MusicResponse>;

  // Vision (Token Plan VLM)
  vision(request: VisionRequest): Promise<VLMResponse>;

  // Search (Token Plan MCP)
  search(request: SearchRequest): Promise<SearchResponse>;
}

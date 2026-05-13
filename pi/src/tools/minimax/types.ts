/**
 * MiniMax TypeScript Interfaces
 * All 7 capabilities: text, image, video, speech, music, vision, search
 */

// ============ Common Types ============

export interface BaseResponse {
  success: boolean;
  request_id?: string;
  cost?: number;
}

export interface MiniMaxConfig {
  apiKey: string;
  groupId?: string;
  baseURL?: string;
  timeout?: number;
}

// ============ Text (Chat) Types ============

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
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
  model: string;
  prompt: string;
  width?: number;
  height?: number;
  num?: number;
  sample?: number;
}

export interface ImageResponse extends BaseResponse {
  data?: Array<{
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
  model: string;
  prompt: string;
  duration?: number; // seconds, max 10
  fps?: number;
}

export interface VideoResponse extends BaseResponse {
  task_id?: string;
  status?: string;
  video_url?: string;
}

// ============ Speech (TTS) Types ============

export interface SpeechSynthesizeRequest {
  model: string;
  text: string;
  voice_setting?: {
    voice_id?: string;
    speed?: number;
    pitch?: number;
    volume?: number;
  };
}

export interface SpeechResponse extends BaseResponse {
  data?: {
    audio_url?: string;
    duration?: number;
  };
}

export interface SpeechTranscribeRequest {
  model: string;
  file?: string; // file path or URL
  language?: string;
}

export interface TranscriptionResponse extends BaseResponse {
  text?: string;
}

// ============ Music Types ============

export interface MusicGenerateRequest {
  model: string;
  prompt: string;
  duration?: number;
  make_instrumental?: boolean;
}

export interface MusicResponse extends BaseResponse {
  task_id?: string;
  status?: string;
  audio_url?: string;
}

// ============ Vision Types ============

export interface VisionMessage {
  role: "user" | "assistant";
  content: Array<{
    type: "text" | "image_url";
    text?: string;
    image_url?: {
      url: string;
      detail?: "low" | "high" | "auto";
    };
  }>;
}

export interface VisionRequest {
  model: string;
  messages: VisionMessage[];
  max_tokens?: number;
}

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

// ============ Search Types ============

export interface SearchRequest {
  query: string;
  num_results?: number;
  search_result_type?: "news" | "web" | "video";
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export interface SearchResponse extends BaseResponse {
  results: SearchResult[];
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

  // Vision
  vision(request: VisionRequest): Promise<VisionResponse>;

  // Search
  search(request: SearchRequest): Promise<SearchResponse>;
}

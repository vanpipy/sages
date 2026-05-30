/**
 * MiniMax Tools - Exposed as pi tools for easy discovery and use
 * 
 * Provides:
 * - minimax-search: Web search using MiniMax (Token Plan)
 * - minimax-chat: Chat completion (M2.7 default)
 * - minimax-image: Image generation
 * - minimax-vision: Image understanding
 * - minimax-speech: Text-to-speech
 * - minimax-music: Music generation
 * - minimax-video: Video generation
 * - minimax-voices: List available voices
 * - minimax-video-task: Query video task status
 * - minimax-quota: Display usage quotas
 * - minimax-file-list: List uploaded files
 * - minimax-file-upload: Upload a file
 * - minimax-file-delete: Delete an uploaded file
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { initMiniMaxSkill } from "./minimax/index.js";
import type { SearchResponse, ChatCompletionResponse, ImageResponse, VisionResponse, MusicResponse, VideoResponse, SpeechResponse, VideoTaskResponse, VoiceListResponse, QuotaResponse, FileListResponse, FileUploadResponse, FileDeleteResponse } from "./minimax/types.js";
import { toDataUri } from "./minimax/image-utils.js";

// ===========================================================================
// Tool Schemas (T3 Schema with TypeBox)
// ===========================================================================

const MinimaxSearchSchema = Type.Object({
  query: Type.String({ description: "Search query (e.g., 'site:arxiv.org agentic AI')" }),
  num_results: Type.Optional(Type.Number({ description: "Number of results (default: 10, max: 20)", default: 10 })),
});

const MinimaxChatSchema = Type.Object({
  message: Type.String({ description: "User message to send" }),
  model: Type.Optional(Type.String({ description: "Model: MiniMax-M2.7 (default), MiniMax-M2.5, MiniMax-M2.1" })),
  system: Type.Optional(Type.String({ description: "System prompt" })),
  temperature: Type.Optional(Type.Number({ description: "Temperature 0-1 (default: 0.7)" })),
  stream: Type.Optional(Type.Boolean({ description: "Enable streaming (default: false)" })),
});

const MinimaxImageSchema = Type.Object({
  prompt: Type.String({ description: "Image description/prompt" }),
  num_images: Type.Optional(Type.Number({ description: "Number of images (default: 1, max: 4)" })),
  width: Type.Optional(Type.Number({ description: "Width in pixels (default: 1024)" })),
  height: Type.Optional(Type.Number({ description: "Height in pixels (default: 1024)" })),
});

const MinimaxVisionSchema = Type.Object({
  image_url: Type.String({ description: "URL of image to analyze" }),
  message: Type.Optional(Type.String({ description: "Question about the image" })),
});

const MinimaxSpeechSchema = Type.Object({
  text: Type.String({ description: "Text to synthesize" }),
  voice_id: Type.Optional(Type.String({ description: "Voice ID (default: male-qingse)" })),
  speed: Type.Optional(Type.Number({ description: "Speed 0.5-2.0 (default: 1.0)" })),
  format: Type.Optional(Type.String({ description: "Output format: mp3 (default), pcm, flac, wav" })),
});

const MinimaxMusicSchema = Type.Object({
  prompt: Type.String({ description: "Music description/prompt" }),
  duration: Type.Optional(Type.Number({ description: "Duration in seconds (default: 60)" })),
  lyrics: Type.Optional(Type.String({ description: "Song lyrics (for singing)" })),
  instrumental: Type.Optional(Type.Boolean({ description: "Generate instrumental music without vocals (default: false)" })),
});

const MinimaxVideoSchema = Type.Object({
  prompt: Type.String({ description: "Video description" }),
  duration: Type.Optional(Type.Number({ description: "Duration in seconds (default: 6, max: 10)" })),
  resolution: Type.Optional(Type.String({ description: "Quality: 720p (default), 1080p" })),
});

const MinimaxVoicesSchema = Type.Object({
  language: Type.Optional(Type.String({ description: "Filter voices by language (e.g. english, korean, japanese)" })),
});

const MinimaxVideoTaskSchema = Type.Object({
  task_id: Type.String({ description: "Video generation task ID" }),
});

const MinimaxQuotaSchema = Type.Object({});

const MinimaxFileListSchema = Type.Object({});

const MinimaxFileUploadSchema = Type.Object({
  file_path: Type.String({ description: "Path to the file to upload" }),
  purpose: Type.Optional(Type.String({ description: "Purpose: music, video, or other (default: music)" })),
});

const MinimaxFileDeleteSchema = Type.Object({
  file_id: Type.String({ description: "File ID to delete" }),
});

// ===========================================================================
// Tool Implementations
// ===========================================================================

/**
 * minimax-search - Web search using MiniMax
 * Usage: /minimax-search "query" [num_results]
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxSearch(
  _id: string,
  params: { query: string; num_results?: number },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const results = await mmx.search({
      query: params.query,
      num_results: params.num_results ?? 10,
    });

    const output = formatSearchResults(params.query, results);
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: String(error) }) }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-chat - Chat with MiniMax LLM
 * Usage: /minimax-chat "Hello, how are you?"
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxChat(
  _id: string,
  params: { message: string; model?: string; system?: string; temperature?: number; stream?: boolean },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    
    const messages = [];
    if (params.system) {
      messages.push({ role: "system" as const, content: params.system });
    }
    messages.push({ role: "user" as const, content: params.message });

    const response = await mmx.chat({
      model: params.model,
      messages,
      temperature: params.temperature,
    });

    const reply = response.choices?.[0]?.message?.content || "No response";
    return { content: [{ type: "text", text: reply }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-image - Generate image
 * Usage: /minimax-image "A cute cat" [--num 2] [--width 1024] [--height 1024]
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxImage(
  _id: string,
  params: { prompt: string; num_images?: number; width?: number; height?: number },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.imageGenerate({
      prompt: params.prompt,
      num_images: params.num_images ?? 1,
      width: params.width ?? 1024,
      height: params.height ?? 1024,
    });

    const images = response.image_list || [];
    if (images.length === 0) {
      return { content: [{ type: "text", text: "No images generated" }] };
    }

    let output = `Generated ${images.length} image(s):\n\n`;
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (img.url) {
        output += `${i + 1}. ${img.url}`;
      } else if (img.base64) {
        output += `${i + 1}. [Base64 image - ${img.base64.substring(0, 50)}...]`;
      }
      output += "\n";
    }
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-vision - Analyze image
 * Usage: /minimax-vision "https://example.com/image.jpg" "What is in this image?"
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxVision(
  _id: string,
  params: { image_url: string; message?: string },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    // Convert local files and HTTP URLs to base64 data URIs
    // This is required because the MiniMax VLM endpoint cannot access
    // local files or non-public URLs directly
    const imageDataUri = await toDataUri(params.image_url);

    const mmx = await initMiniMaxSkill();
    const response = await mmx.vision({
      messages: [{
        role: "user",
        content: [
          { type: "image_url" as const, image_url: { url: imageDataUri } },
          { type: "text" as const, text: params.message || "Describe this image" },
        ],
      }],
    });

    const reply = response.content || "No response";
    return { content: [{ type: "text", text: reply }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-speech - Text-to-speech
 * Usage: /minimax-speech "Hello world" [--voice male-qingse] [--speed 1.0]
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxSpeech(
  _id: string,
  params: { text: string; voice_id?: string; speed?: number; format?: string },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.speechSynthesize({
      text: params.text,
      voice_id: params.voice_id,
      speed: params.speed,
      output_format: params.format as any,
    });

    const audioUrl = response.data?.audio_url;
    if (audioUrl) {
      return { content: [{ type: "text", text: `Audio generated: ${audioUrl}` }] };
    }
    return { content: [{ type: "text", text: "Audio generated but no URL returned" }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-music - Generate music
 * Usage: /minimax-music "Upbeat pop song about summer" [--duration 60]
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxMusic(
  _id: string,
  params: { prompt: string; duration?: number; lyrics?: string; instrumental?: boolean },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.musicGenerate({
      model: "music-2.6",
      prompt: params.prompt,
      duration: params.duration,
      lyrics: params.lyrics,
      is_instrumental: params.instrumental,
      output_format: "url", // Request URL response for easier handling
    });

    // Check data.audio first (API returns audio URL in data.audio), then fall back to audio_url
    const audioUrl = response.data?.audio || response.audio_url;
    if (audioUrl) {
      return { content: [{ type: "text", text: `Music generated: ${audioUrl}` }] };
    }
    return { content: [{ type: "text", text: `Music generated: task_id=${response.task_id}, status=${response.data?.status || response.status}` }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-video - Generate video
 * Usage: /minimax-video "A robot walking" [--duration 6] [--resolution 720p]
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxVideo(
  _id: string,
  params: { prompt: string; duration?: number; resolution?: string },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.videoGenerate({
      prompt: params.prompt,
      duration: params.duration,
      resolution: params.resolution as any,
    });

    const videoUrl = response.video_url;
    if (videoUrl) {
      return { content: [{ type: "text", text: `Video generated: ${videoUrl}` }] };
    }
    return { content: [{ type: "text", text: `Video queued: task_id=${response.task_id}, status=${response.status}` }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-voices - List available system voices
 * Usage: /minimax-voices [--language english]
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxVoices(
  _id: string,
  params: { language?: string },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.voices(params.language);

    const voices = response.system_voice || [];
    if (voices.length === 0) {
      return { content: [{ type: "text", text: "No voices found." }] };
    }

    let output = `🎤 Available Voices (${voices.length}):\n\n`;
    voices.forEach((voice, i) => {
      output += `${i + 1}. **${voice.voice_name}** (${voice.voice_id})\n`;
      if (voice.description && voice.description.length > 0) {
        output += `   ${voice.description.join(", ")}\n`;
      }
      output += "\n";
    });
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-video-task - Query video task status
 * Usage: /minimax-video-task --task-id <id>
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxVideoTask(
  _id: string,
  params: { task_id: string },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.videoTask(params.task_id);

    let output = `🎬 Video Task Status\n`;
    output += `Task ID: ${response.task_id}\n`;
    output += `Status: ${response.status}\n`;
    if (response.file_id) {
      output += `File ID: ${response.file_id}\n`;
    }
    if (response.video_width && response.video_height) {
      output += `Resolution: ${response.video_width}x${response.video_height}\n`;
    }
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-quota - Display Token Plan usage and remaining quotas
 * Usage: /minimax-quota
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxQuota(
  _id: string,
  _params: Record<string, never>,
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.quota();

    const models = response.model_remains || [];
    if (models.length === 0) {
      return { content: [{ type: "text", text: "No quota information available." }] };
    }

    let output = `📊 Token Plan Quotas\n\n`;
    models.forEach((model) => {
      const remaining = model.current_interval_total_count - model.current_interval_usage_count;
      const percentage = model.current_interval_total_count > 0
        ? Math.round((model.current_interval_usage_count / model.current_interval_total_count) * 100)
        : 0;

      output += `${model.model_name}\n`;
      output += `  Used: ${model.current_interval_usage_count} / ${model.current_interval_total_count} (${percentage}%)\n`;
      output += `  Remaining: ${remaining}\n\n`;
    });
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-file-list - List uploaded files in MiniMax storage
 * Usage: /minimax-file-list
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxFileList(
  _id: string,
  _params: Record<string, never>,
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.fileList();

    const files = response.files || [];
    if (files.length === 0) {
      return { content: [{ type: "text", text: "No files found." }] };
    }

    let output = `📁 Uploaded Files (${files.length}):\n\n`;
    files.forEach((file, i) => {
      const sizeKB = (file.bytes / 1024).toFixed(1);
      const date = new Date(file.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ');
      output += `${i + 1}. ${file.filename}\n`;
      output += `   ID: ${file.file_id}\n`;
      output += `   Size: ${sizeKB} KB | Purpose: ${file.purpose} | Created: ${date}\n\n`;
    });
    return { content: [{ type: "text", text: output }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-file-upload - Upload a file to MiniMax storage
 * Usage: /minimax-file-upload --file-path <path> [--purpose music]
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxFileUpload(
  _id: string,
  params: { file_path: string; purpose?: string },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.fileUpload(params.file_path, params.purpose);

    if (response.file) {
      return {
        content: [{
          type: "text",
          text: `✅ File uploaded successfully!\nFile ID: ${response.file.file_id}\nFilename: ${response.file.filename}\nSize: ${(response.file.bytes / 1024).toFixed(1)} KB\nPurpose: ${response.file.purpose}`
        }]
      };
    }
    return { content: [{ type: "text", text: "File uploaded but no file info returned." }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

/**
 * minimax-file-delete - Delete an uploaded file from MiniMax storage
 * Usage: /minimax-file-delete --file-id <id>
 */
// @ts-ignore - Tool signature mismatch with internal function
export async function minimaxFileDelete(
  _id: string,
  params: { file_id: string },
  _signal?: AbortSignal,
  _onUpdate?: any,
  _ctx?: any
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.fileDelete(params.file_id);

    return {
      content: [{
        type: "text",
        text: `🗑️ File deleted successfully!\nFile ID: ${response.file_id}`
      }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
    } as any;
  }
}

// ===========================================================================
// Formatters
// ===========================================================================

function formatSearchResults(query: string, results: SearchResponse): string {
  const lines: string[] = [];
  lines.push(`🔍 Search: "${query}"\n`);

  if (results.organic && results.organic.length > 0) {
    results.organic.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.title}`);
      lines.push(`   → ${item.link}`);
      if (item.snippet) {
        lines.push(`   ${item.snippet.substring(0, 150)}${item.snippet.length > 150 ? "..." : ""}`);
      }
      if (item.date) {
        lines.push(`   📅 ${item.date}`);
      }
      lines.push("");
    });
  } else {
    lines.push("No results found.");
  }

  if (results.related_searches && results.related_searches.length > 0) {
    lines.push("\n💡 Related searches:");
    results.related_searches.slice(0, 5).forEach(rs => {
      lines.push(`   • ${rs.query}`);
    });
  }

  return lines.join("\n");
}

// ===========================================================================
// Tool Registration
// ===========================================================================

export function registerMiniMaxTools(pi: ExtensionAPI): void {
  // Search tool
  pi.registerTool({
    name: "minimax_search",
    description: "🔍 Search the web using MiniMax AI\n\n" +
      "Perfect for:\n" +
      "  • Searching arxiv papers: `site:arxiv.org agentic AI`\n" +
      "  • Finding documentation: `react useeffect docs`\n" +
      "  • News and updates: `minimax latest`\n\n" +
      "Examples:\n" +
      "  /minimax-search \"site:arxiv.org agentic process\" --num 10\n" +
      "  /minimax-search \"typescript error handling best practices\"",
    parameters: MinimaxSearchSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxSearch,
  });

  // Chat tool
  pi.registerTool({
    name: "minimax_chat",
    description: "💬 Chat with MiniMax LLM (MiniMax-M2.7)\n\n" +
      "Examples:\n" +
      "  /minimax-chat \"Explain quantum computing\"\n" +
      "  /minimax-chat \"Write a hello world in Go\" --model MiniMax-M2.5",
    parameters: MinimaxChatSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxChat,
  });

  // Image generation
  pi.registerTool({
    name: "minimax_image",
    description: "🎨 Generate images with MiniMax\n\n" +
      "Examples:\n" +
      "  /minimax-image \"A serene mountain landscape at sunset\"\n" +
      "  /minimax-image \"Cute robot\" --num 4 --width 1024 --height 1024",
    parameters: MinimaxImageSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxImage,
  });

  // Vision
  pi.registerTool({
    name: "minimax_vision",
    description: "👁️ Analyze images with MiniMax VL\n\n" +
      "Examples:\n" +
      "  /minimax-vision \"https://example.com/chart.png\" \"What data is shown?\"\n" +
      "  /minimax-vision \"https://example.com/meme.jpg\"",
    parameters: MinimaxVisionSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxVision,
  });

  // Speech synthesis
  pi.registerTool({
    name: "minimax_speech",
    description: "🔊 Text-to-speech synthesis\n\n" +
      "Examples:\n" +
      "  /minimax-speech \"Hello, this is a test\" --voice male-qingse --speed 1.0\n" +
      "  /minimax-speech \"Welcome to our service\" --format mp3",
    parameters: MinimaxSpeechSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxSpeech,
  });

  // Music generation
  pi.registerTool({
    name: "minimax_music",
    description: "🎵 Generate music with AI\n\n" +
      "Examples:\n" +
      "  /minimax-music \"Upbeat electronic dance music\"\n" +
      "  /minimax-music \"Calm piano melody\" --duration 30",
    parameters: MinimaxMusicSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxMusic,
  });

  // Video generation
  pi.registerTool({
    name: "minimax_video",
    description: "🎬 Generate videos with AI (Hailuo-2.3)\n\n" +
      "Examples:\n" +
      "  /minimax-video \"A cat playing piano\"\n" +
      "  /minimax-video \"Robot working\" --duration 10 --resolution 1080p",
    parameters: MinimaxVideoSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxVideo,
  });

  // Voices list
  pi.registerTool({
    name: "minimax_voices",
    description: "🎤 List available system voices\n\n" +
      "Examples:\n" +
      "  /minimax-voices\n" +
      "  /minimax-voices --language english",
    parameters: MinimaxVoicesSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxVoices,
  });

  // Video task status
  pi.registerTool({
    name: "minimax_video_task",
    description: "🎬 Query video task status\n\n" +
      "Examples:\n" +
      "  /minimax-video-task --task-id 106916112212032",
    parameters: MinimaxVideoTaskSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxVideoTask,
  });

  // Quota
  pi.registerTool({
    name: "minimax_quota",
    description: "📊 Display Token Plan usage and remaining quotas\n\n" +
      "Examples:\n" +
      "  /minimax-quota",
    parameters: MinimaxQuotaSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxQuota,
  });

  // File list
  pi.registerTool({
    name: "minimax_file_list",
    description: "📁 List uploaded files in MiniMax storage\n\n" +
      "Examples:\n" +
      "  /minimax-file-list",
    parameters: MinimaxFileListSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxFileList,
  });

  // File upload
  pi.registerTool({
    name: "minimax_file_upload",
    description: "📤 Upload a file to MiniMax storage\n\n" +
      "Examples:\n" +
      "  /minimax-file-upload --file-path ./audio.mp3\n" +
      "  /minimax-file-upload --file-path ./video.mp4 --purpose video",
    parameters: MinimaxFileUploadSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxFileUpload,
  });

  // File delete
  pi.registerTool({
    name: "minimax_file_delete",
    description: "🗑️ Delete an uploaded file from MiniMax storage\n\n" +
      "Examples:\n" +
      "  /minimax-file-delete --file-id file_123",
    parameters: MinimaxFileDeleteSchema,
    // @ts-ignore - Parameter order differs between schema and function
    execute: minimaxFileDelete,
  });
}

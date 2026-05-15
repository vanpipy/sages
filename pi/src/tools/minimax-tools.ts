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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { initMiniMaxSkill } from "./minimax/index.js";
import type { SearchResponse, ChatCompletionResponse, ImageResponse, VisionResponse, MusicResponse, VideoResponse, SpeechResponse } from "./minimax/types.js";

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
});

const MinimaxVideoSchema = Type.Object({
  prompt: Type.String({ description: "Video description" }),
  duration: Type.Optional(Type.Number({ description: "Duration in seconds (default: 6, max: 10)" })),
  resolution: Type.Optional(Type.String({ description: "Quality: 720p (default), 1080p" })),
});

// ===========================================================================
// Tool Implementations
// ===========================================================================

/**
 * minimax-search - Web search using MiniMax
 * Usage: /minimax-search "query" [num_results]
 */
async function minimaxSearch(
  _id: string,
  params: { query: string; num_results?: number }
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
async function minimaxChat(
  _id: string,
  params: { message: string; model?: string; system?: string; temperature?: number; stream?: boolean }
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
async function minimaxImage(
  _id: string,
  params: { prompt: string; num_images?: number; width?: number; height?: number }
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
async function minimaxVision(
  _id: string,
  params: { image_url: string; message?: string }
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.vision({
      messages: [{
        role: "user",
        content: [
          { type: "image_url" as const, image_url: { url: params.image_url } },
          { type: "text" as const, text: params.message || "Describe this image" },
        ],
      }],
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
 * minimax-speech - Text-to-speech
 * Usage: /minimax-speech "Hello world" [--voice male-qingse] [--speed 1.0]
 */
async function minimaxSpeech(
  _id: string,
  params: { text: string; voice_id?: string; speed?: number; format?: string }
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
async function minimaxMusic(
  _id: string,
  params: { prompt: string; duration?: number; lyrics?: string }
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    const mmx = await initMiniMaxSkill();
    const response = await mmx.musicGenerate({
      prompt: params.prompt,
      duration: params.duration,
      lyrics: params.lyrics,
    });

    const audioUrl = response.audio_url;
    if (audioUrl) {
      return { content: [{ type: "text", text: `Music generated: ${audioUrl}` }] };
    }
    return { content: [{ type: "text", text: `Music generated: task_id=${response.task_id}, status=${response.status}` }] };
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
async function minimaxVideo(
  _id: string,
  params: { prompt: string; duration?: number; resolution?: string }
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
    execute: minimaxVideo,
  });
}

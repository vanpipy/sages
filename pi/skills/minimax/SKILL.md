---
description: Integrate MiniMax AI for text, image, video, speech, music, vision, and search capabilities.
---

# MiniMax Skill

Integrates MiniMax AI capabilities into pi with programmatic, function-based interface.

## Features

- **Auto-detection**: Automatically detects the correct API host (CN/Global) based on your API key
- **Dual Platform Support**: Works with both CN (`api.minimaxi.com`) and Global (`api.minimax.io`) platforms
- **All Capabilities**: Text, Image, Video, Speech, Music, Vision, Search

## Capabilities

| Capability | Description | Models |
|------------|-------------|--------|
| **Text** | Chat completion with streaming | MiniMax-M2.7, M2.5, M2.1, M2 |
| **Image** | Generate and edit images | image-01 |
| **Video** | Generate videos from text | Hailuo-2.3 |
| **Speech** | Text-to-speech synthesis | speech-2.8, speech-2.6, speech-02 |
| **Music** | Generate music from text | Music-2.6 |
| **Vision** | Image understanding chat | MiniMax-VL-01 |
| **Search** | Web search (Token Plan) | coding_plan |

## Authentication

The skill auto-detects credentials from multiple sources:

1. **Environment Variables**: `MINIMAX_API_KEY`, `MINIMAX_API_HOST`
2. **CLI Config**: `~/.mmx/config.json` (from `mmx auth login`)
3. **Cache**: `~/.mmx/auth-cache.json`

### Quick Setup

```bash
# Install CLI and login
npm install -g mmx-cli
mmx auth login

# Or set environment variable
export MINIMAX_API_KEY="your-key-here"
export MINIMAX_API_HOST="https://api.minimaxi.com"  # or api.minimax.io
```

## Usage

```typescript
import { createMiniMax, initMiniMaxSkill } from "./tools/minimax/index";

// Auto-auth (uses environment or CLI config)
const mmx = await initMiniMaxSkill();

// Or explicit config
const mmx = createMiniMax({
  apiKey: "your-key",
  baseURL: "https://api.minimaxi.com", // auto-detected if omitted
});

// Text chat (default: MiniMax-M2.7)
const response = await mmx.chat({
  messages: [{ role: "user", content: "Hello!" }],
});

// Image generation
const image = await mmx.imageGenerate({
  prompt: "A cute cat",
  num_images: 2,
});

// Web search (Token Plan)
const results = await mmx.search({
  query: "MiniMax latest news",
});

// Vision (image understanding)
const vision = await mmx.vision({
  messages: [{
    role: "user",
    content: [{
      type: "image_url",
      image_url: { url: "https://example.com/image.jpg" }
    }]
  }]
});
```

## API Hosts

| Platform | Host | Notes |
|----------|------|-------|
| **CN (Primary)** | `https://api.minimaxi.com` | For CN platform keys |
| **Global** | `https://api.minimax.io` | For global platform keys |
| **Legacy** | `https://api.minimax.chat` | Redirects to CN |

The skill auto-detects the correct host by probing all known endpoints.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | MiniMaxClient factory, auto-detection |
| `auth.ts` | Authentication, API host detection |
| `types.ts` | TypeScript interfaces, model constants |
| `errors.ts` | Error hierarchy |

## Tests

```bash
bun test ./pi/src/tools/minimax/test/
```

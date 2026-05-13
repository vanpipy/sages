# MiniMax Skill

Integrates MiniMax AI capabilities into pi with programmatic, function-based interface.

## Capabilities

| Capability | Description |
|------------|-------------|
| **Text** | Chat completion with streaming |
| **Image** | Generate and edit images |
| **Video** | Generate videos from text |
| **Speech** | Text-to-speech synthesis |
| **Music** | Generate music from text |
| **Vision** | Image understanding chat |
| **Search** | Web and news search |

## Usage

```typescript
import { createMiniMax, initMiniMaxSkill } from "./tools/minimax/index";

// Auto-auth
const mmx = await initMiniMaxSkill(async (msg) => readline.question(msg));

// Explicit config
const mmx = createMiniMax({ apiKey: "your-key" });

// Text chat
const response = await mmx.chat({
  model: "MiniMax-Text-01",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Files

| File | Purpose |
|------|---------|
| `index.ts` | MiniMaxClient factory |
| `auth.ts` | Authentication (config → cache → prompt) |
| `errors.ts` | Error hierarchy |
| `types.ts` | TypeScript interfaces |

## Tests

```bash
bun test ./pi/src/tools/minimax/test/
```

---
description: Tool priority nudge — prefer serena_*/codebase_memory_*/graphify_* over builtin grep/read
---

# pi-semantic-nudge — Tool Priority Enforcer

**The problem**: in long-running tasks (20+ turns), the LLM reverts to `grep`/`read` because those are deeply familiar in training data. The semantic tools (`serena_find_symbol`, `codebase_memory_trace_path`, `graphify_query`) give better answers but require the LLM to "remember" them exist.

**This extension** enforces priority via 3 layered mechanisms (5 → 1 is weakest):

## 1. Tool description prefix (`[PREFERRED — ...]`)

When MCP servers bootstrap, this extension auto-patches `~/.pi/agent/mcp-cache.json`:

- Prepends `[PREFERRED over grep for X]` to 28 serena tools, 14 codebase-memory tools, 10 graphify tools
- LLM reads these descriptions every tool-selection → high attention weight
- Survives cache regeneration (extension re-patches on session_start)

## 2. Conditional `before_agent_start` system-prompt injection

Tracks a sliding window of last 5 tool calls:

- Trigger if ≥3 are builtins (`grep`/`read`/`find`/`ls`) AND 0 are semantic
- Injects `<nudge>...</nudge>` into system prompt asking LLM to consider semantic alternatives
- Suppresses for 5 turns after a nudge (no reminder fatigue)
- Cost: ~10 tokens, fires at most once per 5 turns

## 3. `before_agent_start` hook (always available)

Even when trigger condition isn't met, the hook is registered. Other extensions (or future ones) can compose.

## Configuration (defaults in `src/index.ts`)

| Knob | Default | What it does |
|------|---------|--------------|
| `WINDOW_SIZE` | 5 | sliding window for drift detection |
| `DRIFT_THRESHOLD` | 3 | ≥3 builtin calls in window → nudge |
| `SUPPRESS_TURNS` | 5 | turns to suppress after a nudge |

## When to manually trigger a re-patch

If you see `serena_find_symbol` description lacking the `[PREFERRED]` prefix:

```bash
python3 ~/.pi/packages/pi-semantic-nudge/scripts/patch_tool_descriptions.py
```

The extension does this automatically on session_start, but the script is useful for one-off fixes.

## Performance & cost

- **Tokens per nudge**: ~10 (one paragraph in `<nudge>` tags)
- **Frequency**: ≤ 1 nudge per 5 turns (suppression)
- **Startup cost**: <10ms (small JSON read + scan)
- **No external network calls**

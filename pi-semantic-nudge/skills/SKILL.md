---
description: Tool priority nudge — prefer sages_*/codebase_memory_*/graphify_* over builtin grep/read
---

# pi-semantic-nudge — Tool Priority Enforcer

**The problem**: in long-running tasks (20+ turns), the LLM reverts to `grep`/`read` because those descriptions match user task wording better than the semantic tools. The sage wrappers (`sages_read_file`, `sages_replace_symbol`), the graph layer (`codebase_memory_trace_path`, `graphify_query`) all give better answers but require the LLM to "remember" they exist.

**This extension** enforces priority via 2 layered mechanisms:

## 1. Conditional `before_agent_start` system-prompt injection

Tracks a sliding window of last 5 tool calls:

- Trigger if ≥3 are builtins (`grep`/`read`/`find`/`ls`) AND 0 are semantic
- Injects `<nudge>...</nudge>` into system prompt asking LLM to consider semantic alternatives
- Suppresses for 5 turns after a nudge (prevent repetition)
- Cost: ~10 tokens, fires at most once per 5 turns

**The semantic set (post-AFT migration, 2026-07-19):**

| Tool family | Status | Why |
|---|---|---|
| `sages_*` (9) | **Primary** | Direct sage wrappers — AFT-backed + auto-snapshot to `.sages/snapshots/` |
| `codebase_memory_*` (14) | Fallback | Cross-project graph queries |
| `graphify_*` (10) | Fallback | Concept-graph traversal |
| `serena_*` (9) | **Removed** | Serena uninstalled in commit 08464ef |

## 2. `before_agent_start` hook (always available)

Even when trigger condition isn't met, the hook is registered. Other extensions (or future ones) can compose.

## Configuration (defaults in `src/nudge.ts`)

| Knob | Default | What it does |
|------|---------|--------------|
| `WINDOW_SIZE` | 5 | sliding window for drift detection |
| `DRIFT_THRESHOLD` | 3 | ≥3 builtin calls in window → nudge |
| `SUPPRESS_TURNS` | 5 | turns to suppress after a nudge |

## Removed: `[PREFERRED]` description-prefix patch

The pre-AFT version shipped a Python script (`patch_tool_descriptions.py`)
that mutated `~/.pi/agent/mcp-cache.json` to prepend `[PREFERRED over grep]`
prefixes to MCP tool descriptions. That mechanism targeted `serena_*` /
`codebase_memory_*` / `graphify_*` descriptions cached in the MCP config.

Post-AFT, the sage wrappers are registered directly via `pi.registerTool`
with rich descriptions — they never go through MCP caching. Their salience
is carried by:

1. The sage `skills/fuxi|SKILL.md` (and qiaochui/luban/gaoyao) loaded at startup
2. The `sages_*` rows in `pi/templates/SYSTEM.md`'s tool-priority table
3. The 4 sage role tools (`fuxi_design`, etc.) calling out `sages_*` in
   their `buildIntent` strings

So the python patcher no longer adds value. It was deleted.

## Performance & cost

- **Tokens per nudge**: ~10 (one paragraph in `<nudge>` tags)
- **Frequency**: ≤ 1 nudge per 5 turns (suppression)
- **Startup cost**: <1ms (in-memory check, no FS access)
- **No external network calls**
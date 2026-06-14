---
description: pi-minimax - shell-out wrapper for mmx-cli (MiniMax AI Platform) - 3 tools for auth/exec/search
---

# pi-minimax — mmx-cli integration for pi

> Thin shell-out wrapper that exposes 3 pi tools over the globally-installed
> `mmx` CLI. **No daemon, no auth duplication** — mmx-cli owns credentials,
> region detection, and the API surface.

## When to use which tool

```
User asks for:                                    → Tool to use:
─────────────────────────────────────────────────────────────────────
"check auth / am I logged in / auth status"       → minimax_auth_status
"search the web for X"                            → minimax_search_query
"send a chat message / generate image / …"        → minimax_exec
                                                   (command: "text chat",
                                                    args: {message: "…"})
"trigger video gen / quota / speech / music / …"  → minimax_exec
"create a file / upload / list files"             → minimax_exec
```

**Rule of thumb**: dedicated tool → escape hatch. If a dedicated tool exists
(`minimax_auth_status`, `minimax_search_query`), use it (LLM gets TypeBox-typed
params). Otherwise, route through `minimax_exec`.

## 3 tools

| Layer | Tool | Purpose |
|---|---|---|
| L0 | `minimax_auth_status` | Check mmx auth state; auto-bootstraps from `MINIMAX_API_KEY` env |
| L1 | `minimax_exec` | Escape hatch — runs any mmx subcommand with structured args |
| L2 | `minimax_search_query` | Web search via `mmx search query --q <query>` |

## Auto-auth behavior

If `mmx auth status --output json` reports unauthenticated AND
`MINIMAX_API_KEY` env var is set, **pi-minimax silently runs
`mmx auth login --api-key $KEY` on the first tool call**. The bootstrap is
announced via `onUpdate` so it's visible to the user.

Existing OAuth/api-key sessions are **never overwritten** — bootstrap only
fires when status reports unauthenticated.

## Flag reference

**For mmx flags** (`--output`, `--quiet`, `--non-interactive`, `--api-key`,
modality-specific flags like `--q`, `--prompt`, `--model`): see the canonical
mmx-cli skill:

- If installed globally: `~/.pi/packages/mmx-cli/skill/SKILL.md` (path may vary)
- Or run `mmx <command> --help` for in-CLI flag reference

We do NOT duplicate mmx flag docs here (single source of truth).

## Error codes

All tools return structured errors with these codes:

| Code | Meaning | Action |
|---|---|---|
| `MMX_NOT_FOUND` | mmx binary not on PATH | Run `npm install -g mmx-cli` |
| `NOT_AUTHED` | mmx has no credentials AND no `MINIMAX_API_KEY` env | Run `mmx auth login`, or `export MINIMAX_API_KEY=sk-…` |
| `AUTH_STATUS_PARSE_ERROR` | mmx auth status JSON malformed | Open issue; mmx-cli regression |
| `UNKNOWN` | Other failure (mmx exit non-zero, parse error, etc.) | Inspect `error.message` |

## Examples

### Search
```ts
minimax_search_query({ query: "MiniMax AI latest release" })
// → {success: true, query: "MiniMax AI latest release", results: [{title, link, snippet, date}]}
```

### Auth check
```ts
minimax_auth_status({})
// → {success: true, method: "api-key", source: "config.json", key: "sk-xxxx…"}
// or {success: false, error: {code: "NOT_AUTHED", message: "…"}}
```

### Text chat (via escape hatch)
```ts
minimax_exec({
  command: "text chat",
  args: { message: "Write a haiku about Rust", model: "MiniMax-M2.7-highspeed" },
})
```

### Video gen (async)
```ts
minimax_exec({
  command: "video generate",
  args: { prompt: "Ocean waves at sunset", async: true },
})
// → {success: true, exitCode: 0, parsed: {taskId: "…"}, …}
```

### Per-call token override
```ts
minimax_exec({ command: "quota show", apiKey: "sk-alt-account" })
```

## Install (for the user, not the LLM)

```bash
# 1. Install mmx-cli (the upstream CLI)
npm install -g mmx-cli

# 2. Authenticate (one-time)
mmx auth login --api-key sk-xxxxx
# OR just export the env var (pi-minimax will auto-bootstrap on first call):
export MINIMAX_API_KEY=sk-xxxxx

# 3. Install pi-minimax (this extension)
cd ~/Project/sages/pi-minimax
./scripts/install.sh --force
# Then restart pi
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MMX_NOT_FOUND` | mmx not installed | `npm install -g mmx-cli` |
| `NOT_AUTHED` | No credentials | `mmx auth login` or `export MINIMAX_API_KEY=…` |
| All calls slow (~150ms) | mmx spawn overhead per call | Expected; can't avoid without SDK import |
| `OAuth session wiped` | — | Should not happen; bootstrap is gated by status check |
| Token leakage in logs | — | mmx-cli's `maskToken` prefixes only (`sk-xxxx…`); we don't log full keys |

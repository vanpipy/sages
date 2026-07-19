---
description: pi-minimax - thin pi extension wrapping mmx-cli (MiniMax AI Platform); exposes 2 typed tools (auth status, web search) and delegates all other modalities to the upstream mmx-cli skill.
---

# pi-minimax — mmx-cli integration for pi

> Thin shell-out wrapper that exposes **2 pi tools** over the globally-installed
> `mmx` CLI: `minimax_auth_status` (L0) and `minimax_search_query` (L2). All
> other mmx modalities (text/image/video/speech/music/vision/quota/file) are
> reached **directly** via the `mmx` binary — the LLM learns the full surface
> from the **`mmxc-cli` skill** installed at `~/.pi/agent/skills/mmxc-cli/SKILL.md`
> (the upstream mmx-cli skill, installed once by `npx skills add MiniMax-AI/cli -y -g`).

## When to use which tool

| User asks for                                          | Tool to use |
|---|---|
| "check auth / am I logged in / auth status"             | `minimax_auth_status` |
| "search the web for X"                                  | `minimax_search_query` |
| "generate an image / video / speech / music"            | `mmx image/video/speech/music …` (via bash) — see `mmxc-cli` skill |
| "send a chat message to MiniMax"                          | `mmx text chat --message "…"` (via bash) — see `mmxc-cli` skill |
| "show quota / list files / config"                       | `mmx quota/file/config …` (via bash) — see `mmxc-cli` skill |

**Rule of thumb**: dedicated tool → bash. If a typed tool exists
(`minimax_auth_status`, `minimax_search_query`), use it (LLM gets TypeBox-typed
params). For everything else, run `mmx <resource> <command> [flags]` via the
AFT-backed `bash` tool. The `mmxc-cli` skill (loaded automatically by pi) is
the canonical reference for mmx flags and command shape.

## 2 tools

| Layer | Tool | Purpose |
|---|---|---|
| L0 | `minimax_auth_status` | Check mmx auth state; auto-bootstraps from `MINIMAX_API_KEY` env |
| L2 | `minimax_search_query` | Web search via `mmx search query --q <query>` (returns parsed JSON) |

## Auto-auth behavior

If `mmx auth status --output json` reports unauthenticated AND `MINIMAX_API_KEY`
env var is set, **pi-minimax silently runs `mmx auth login --api-key $KEY` on the
first tool call**. The bootstrap is announced via `onUpdate` so it's visible.

Existing OAuth/api-key sessions are **never overwritten** — bootstrap only fires
when status reports unauthenticated.

## Flag reference

**For mmx flags** (`--output`, `--quiet`, `--non-interactive`, `--api-key`,
modality-specific flags like `--q`, `--prompt`, `--model`): see the canonical
mmx-cli skill at `~/.pi/agent/skills/mmxc-cli/SKILL.md` (single source of truth).

For in-CLI help, run `mmx <command> --help`.

## Error codes

| Code | Meaning | Action |
|---|---|---|
| `MMX_NOT_FOUND` | mmx binary not on PATH | Run `npm install -g mmx-cli` |
| `NOT_AUTHED` | mmx has no credentials AND no `MINIMAX_API_KEY` env | Run `mmx auth login`, or `export MINIMAX_API_KEY=sk-…` |
| `TIMEOUT` | mmx subprocess exceeded 60s | Use `mmx <cmd> --async` for long polls |
| `UNKNOWN` | Other failure (mmx exit non-zero, parse error) | Inspect `error.message` |

## Examples

### Search (typed tool)
```ts
minimax_search_query({ query: "MiniMax AI latest release" })
// → {success: true, query: "…", results: [{title, link, snippet, date}]}
```

#### If you get HTTP 404 from search — region=cn (auto-fixed)

mmx-cli 1.0.15/1.0.16 has a **base_url resolver bug for `region=cn`**:
the search endpoint double-prepends `/anthropic/v1/` → HTTP 404.

**pi-minimax auto-injects the workaround**: when `~/.mmx/config.json` has
`region: "cn"`, every mmx call gets `--base-url https://api.minimaxi.com`
(no `/anthropic/v1` suffix) appended transparently. You should NOT see 404
from search anymore. If you do, the config is missing or `region` is set
to something other than `"cn"`.

The `baseUrl` parameter on `minimax_search_query` is now an **explicit
override** (escape hatch) — only set it if you need a non-default endpoint.
For the bug workaround, do nothing: it's automatic.

Underlying: see `src/services/region-fix.ts` (auto-detection, cached) and
the `--base-url` injection logic in `src/services/exec.ts`.

### Auth check (typed tool)
```ts
minimax_auth_status({})
// → {success: true, method: "api-key", source: "config.json", key: "sk-xxxx…"}
```

### Other modalities (via bash + mmxc-cli skill)
```bash
# Always use these agent-friendly flags:
#   --output json  --quiet  --non-interactive
mmx text chat --message "Write a haiku about Rust" --output json --quiet --non-interactive
mmx image generate --prompt "A cat in a spacesuit" --n 1 --output json --quiet --non-interactive
mmx video generate --prompt "Ocean waves at sunset" --async --output json --quiet --non-interactive
mmx speech synthesize --text "Hello!" --out hello.mp3 --output json --quiet --non-interactive
mmx quota show --output json --quiet --non-interactive
```

## Timeouts and auth cache

- **60s exec timeout**: every `minimax_*` tool call has a hard 60-second
  timeout on the mmx subprocess. For long-running mmx commands (e.g.
  `mmx video generate` polling), run directly via bash with `--async` and
  poll separately.
- **5min auth cache TTL**: after successful auth bootstrap, the "ok" state
  is cached for 5 minutes. After expiry, the next tool call re-checks
  `mmx auth status` (catches mid-session OAuth expiry).

## Install (for the user, not the LLM)

```bash
# 1. Install mmx-cli (the upstream CLI)
npm install -g mmx-cli

# 2. Authenticate (one-time)
mmx auth login --api-key sk-xxxxx
# OR just export the env var (pi-minimax auto-bootstraps on first call):
export MINIMAX_API_KEY=sk-xxxxx

# 3. Install the agent skill (gives the LLM the full mmx command reference)
npx skills add MiniMax-AI/cli -y -g
# This writes ~/.pi/agent/skills/mmxc-cli/SKILL.md (or similar) — the LLM
# loads it automatically on next pi session start.

# 4. Install pi-minimax (this extension)
cd ~/Project/sages/pi-minimax
./scripts/install.sh --force
# Then restart pi
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MMX_NOT_FOUND` | mmx not installed | `npm install -g mmx-cli` |
| `NOT_AUTHED` | No credentials | `mmx auth login` or `export MINIMAX_API_KEY=…` |
| `TIMEOUT` (typed tool) | mmx subprocess exceeded 60s | Run via bash with `mmx <cmd> --async` |
| `UNKNOWN` with `HTTP 404` | mmx-cli region=cn base_url bug | **Auto-fixed** — verify `~/.mmx/config.json` has `region: "cn"`; if not, set it via `mmx config set --key region --value cn` |
| LLM doesn't know mmx commands | mmxc-cli skill not installed | `npx skills add MiniMax-AI/cli -y -g` |
| All calls slow (~150ms) | mmx spawn overhead per call | Expected; can't avoid without SDK import |
| `OAuth session wiped` | — | Should not happen; bootstrap is gated by status check |

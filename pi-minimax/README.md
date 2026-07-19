# pi-minimax

> **MiniMax AI Platform CLI wrapper for [pi](https://pi.dev)** — thin shell-out
> layer over the globally-installed [`mmx`](https://www.npmjs.com/package/mmx-cli) CLI.

Exposes **2 pi tools** (auth status, web search) that benefit from TypeBox-typed
schemas and auto-auth. **All other mmx modalities** (text / image / video / speech
/ music / vision / quota / file) are reached directly via the `mmx` binary — the
LLM learns the full surface from the **`mmxc-cli` skill** installed at
`~/.pi/agent/skills/mmxc-cli/SKILL.md` (the upstream mmx-cli skill, installed
once by `npx skills add MiniMax-AI/cli -y -g`).

**No daemon, no auth duplication, no SDK imports** — mmx-cli owns credentials,
region detection, and the API surface.

## ✨ 2 tools

| Layer | Tool | Purpose |
|---|---|---|
| L0 | `minimax_auth_status` | Check mmx auth state; auto-bootstrap from `MINIMAX_API_KEY` env |
| L2 | `minimax_search_query` | Web search via `mmx search query --q <query>` |

**All other mmx modalities** are reached via the AFT-backed `bash` tool
(`mmx text/image/video/speech/music/vision/quota/file …`) — see the `mmxc-cli`
skill for the full flag reference. Example:

```bash
mmx image generate --prompt "A cat in a spacesuit" --n 1 \
  --output json --quiet --non-interactive
mmx video generate --prompt "Ocean waves at sunset" --async \
  --output json --quiet --non-interactive
mmx speech synthesize --text "Hello!" --out hello.mp3 \
  --output json --quiet --non-interactive
```

## 📦 Install

### Prerequisites

You need `mmx-cli` installed and authenticated:

```bash
# Install mmx-cli (the upstream CLI)
npm install -g mmx-cli

# Authenticate (one-time)
mmx auth login --api-key sk-xxxxx
# …or just export the env var; pi-minimax auto-bootstraps on first call:
export MINIMAX_API_KEY=sk-xxxxx
```

### Install pi-minimax

```bash
# 1. Deploy to ~/.pi/packages/minimax
cd ~/Project/sages/pi-minimax
./scripts/install.sh --force

# 2. Restart pi
exit && pi
```

### Verify

In pi, say:

```
"check mmx auth"
"search the web for MiniMax AI"
"show quota"          # via bash + mmx (not a typed tool)
"generate an image of a cat"  # via bash + mmx image
```

## 🔧 Uninstall

```bash
./scripts/install.sh --uninstall
```

## 🏗️ How it works

```
pi agent
  ↓ LLM picks tool from SKILL.md routing
extensions/minimax-extension.ts
  ↓ registerTool
src/tools/{auth,search}.ts
  ↓ calls ensureAuth() (cached)
src/services/auth-bootstrap.ts
  ↓ if unauthed + MINIMAX_API_KEY env → mmx auth login --api-key $KEY
src/services/exec.ts → execMmx({command, args, apiKey})  (low-level helper, used by both tools)
  ↓ node:child_process.execFile("mmx", ...)
mmx-cli (already installed globally)
  ↓ HTTPS + ~/.mmx/{config,credentials}
api.minimax.io | api.minimaxi.com
```

For non-typed modalities, the LLM calls `mmx <resource> <command> [flags]`
directly via the AFT-backed `bash` tool. The `mmxc-cli` skill
(installed by `npx skills add MiniMax-AI/cli -y -g`) is the canonical
reference for mmx flags and command shape.

**Key design choices** (see `AGENTS.md` for full details):

- **Stateless shell-out**: each tool call spawns one `mmx` subprocess (~150ms overhead). mmx-cli handles all auth/region/streaming logic.
- **Auto-auth from env**: `MINIMAX_API_KEY` env triggers silent bootstrap on first call. Existing OAuth/api-key sessions are never overwritten.
- **Layered binary lookup**: `MMX_BIN` env → `npm prefix -g` → `which mmx`. Verified by `mmx --version`. Cached for session.
- **Structured errors**: all tools return `{success, error: {code, message}}` with codes `MMX_NOT_FOUND`, `NOT_AUTHED`, `AUTH_STATUS_PARSE_ERROR`, `UNKNOWN`.

## 🔍 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MMX_NOT_FOUND` | mmx not installed | `npm install -g mmx-cli` |
| `NOT_AUTHED` | No credentials | `mmx auth login` or `export MINIMAX_API_KEY=…` |
| `OAuth session wiped` | Shouldn't happen | Bootstrap only fires when status reports unauthed |
| LLM doesn't know mmx flags | `mmxc-cli` skill not installed | `npx skills add MiniMax-AI/cli -y -g` |
| All calls slow (~150ms) | Expected subprocess overhead | Use bash + mmx directly for non-typed tools |
| Token leakage in logs | — | mmx-cli's `maskToken` prefixes only; we don't log full keys |
| `AUTH_STATUS_PARSE_ERROR` | mmx-cli JSON format changed | Open issue; we'll adapt parser |

**Manual diagnosis**:

```bash
# Confirm mmx is installed
which mmx
mmx --version

# Confirm mmx auth
mmx auth status --output json --quiet --non-interactive

# Force re-deploy
cd ~/Project/sages/pi-minimax && ./scripts/install.sh --force
```

## 🛠️ Development
```bash
cd ~/Project/sages/pi-minimax

# Type check
./node_modules/.bin/tsc --noEmit

# Run all tests
bun test

# Run a single test file
bun test ./test/binary-finder.test.ts

# Deploy after changes
./scripts/install.sh --force
```

See `AGENTS.md` for project conventions, TDD discipline, and known traps.

## 📊 Status (post 2026-07-19 simplification)

- **Two tools**: `minimax_auth_status`, `minimax_search_query` (was three; `minimax_exec` removed — escape hatch no longer needed since the LLM uses bash + the `mmxc-cli` skill for all other modalities)
- All non-exec tests pass (exec-tool test deleted)
- **tsc clean** (`tsc --noEmit` exits 0)
- **install.sh** verified deploys to `~/.pi/packages/minimax`
- **Real integration**: finds `mmx` via npm-global on this machine, runs the real auth-status JSON parser

## Related

- **pi-yunxiao** (sibling) — Alibaba Cloud DevOps / Yunxiao MCP integration. Same pattern but with a long-running MCP sidecar.
- **mmx-cli** (upstream) — the official MiniMax AI Platform CLI that we shell-out to. Its `skill/SKILL.md` is the canonical reference for the LLM.

## License

MIT

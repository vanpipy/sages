# pi-minimax

> **MiniMax AI Platform CLI wrapper for [pi](https://pi.dev)** — thin shell-out
> layer over the globally-installed [`mmx`](https://www.npmjs.com/package/mmx-cli) CLI.

Exposes 3 pi tools (auth status, exec escape hatch, search) that delegate to `mmx`.
**No daemon, no auth duplication, no SDK imports** — mmx-cli owns credentials,
region detection, and the API surface.

## ✨ 3 tools

| Layer | Tool | Purpose |
|---|---|---|
| L0 | `minimax_auth_status` | Check mmx auth state; auto-bootstrap from `MINIMAX_API_KEY` env |
| L1 | `minimax_exec` | Escape hatch — runs any mmx subcommand with structured args |
| L2 | `minimax_search_query` | Web search via `mmx search query --q <query>` |

**All other mmx modalities** (text / image / video / speech / music / vision /
quota / file) are reachable via `minimax_exec`. Example:

```ts
minimax_exec({
  command: "image generate",
  args: { prompt: "A cat in a spacesuit", n: 1 },
})

minimax_exec({
  command: "video generate",
  args: { prompt: "Ocean waves at sunset", async: true },
})

minimax_exec({
  command: "speech synthesize",
  args: { text: "Hello!", out: "hello.mp3" },
})
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
"show quota"
```

Or use the slash command:

```
/minimax-quickstart
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
src/tools/{auth,exec,search}.ts
  ↓ calls ensureAuth() (cached)
src/services/auth-bootstrap.ts
  ↓ if unauthed + MINIMAX_API_KEY env → mmx auth login --api-key $KEY
src/services/exec.ts → execMmx({command, args, apiKey})
  ↓ node:child_process.execFile("mmx", ...)
mmx-cli (already installed globally)
  ↓ HTTPS + ~/.mmx/{config,credentials}
api.minimax.io | api.minimaxi.com
```

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
| All calls slow (~150ms) | Expected subprocess overhead | Use `minimax_exec` to batch, or wait for v2 |
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

# Run all tests (46 tests)
bun test

# Run a single test file
bun test ./test/binary-finder.test.ts

# Deploy after changes
./scripts/install.sh --force
```

See `AGENTS.md` for project conventions, TDD discipline, and known traps.

## 📊 Status

- **67 unit tests pass** (9 test files: auth-status 6 + search 11 + exec 11 + tools-index 10 + exec-tool 6 + auth 5 + binary-finder 8 + auth-bootstrap 8 + extension 2)
- **tsc clean** (`tsc --noEmit` exits 0)
- **install.sh** verified deploys to `~/.pi/packages/minimax`
- **21 git commits** (T1-T22) — atomic per task
- **31 tracked files**, ~2972 LOC (vs pi-yunxiao's 24 files / ~2400 LOC)
- **Real integration**: finds `mmx` via npm-global on this machine, runs the real auth-status JSON parser

## 📚 Docs

- `AGENTS.md` — conventions for future LLM agents
- `skills/minimax/SKILL.md` — routing doc (defers flag reference to mmx-cli SKILL.md)
- `.sages/designs/2026-06-14-minimax-pi-design.md` — original MDD design draft (in workspace archive)
- `.sages/workspace/draft.md` — refined MDD Seven Planes analysis (QiaoChui score: 82/100)

## Related

- **pi-yunxiao** (sibling) — Alibaba Cloud DevOps / Yunxiao MCP integration. Same pattern but with a long-running MCP sidecar.
- **mmx-cli** (upstream) — the official MiniMax AI Platform CLI that we shell-out to.

## License

MIT

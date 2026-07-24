# Sages — pi package

The `pi/` subpackage of the [Sages monorepo](../). Implements the
4-tool orchestrator + skill templates installed to `~/.pi/agent/` by
`pi/scripts/install.sh`.

> **For the full architecture, workflow, and tool surface, see the
> [root README](../README.md) and [root AGENTS.md](../AGENTS.md).**
> This file covers only `pi/`-specific build / install / dev notes.

## What lives in `pi/`

```
pi/
├── src/
│   ├── extension.ts              # pi entrypoint → registerOrchestratorTools
│   ├── index.ts                  # re-exports
│   ├── services/file-service.ts  # centralized file ops with path validation
│   └── tools/
│       ├── orchestrator/         # 4-tool surface + types + template renderer
│       │   ├── index.ts          # registerOrchestratorTools
│       │   ├── types.ts          # GoalContract / TaskNode / AuditState
│       │   ├── planes.ts         # MDD Seven Planes enum
│       │   ├── goal-contract.ts  # Stage 1
│       │   ├── dag-synthesizer.ts # Stage 2
│       │   ├── task-dispatcher.ts # Stage 3
│       │   ├── orchestrator-audit.ts # Stage 4 (A3 split)
│       │   └── template-loader.ts  # {{var}} / {{#if}} / {{#each}}
│       └── brainstorming/        # pre-design intent clarification (slash command)
├── test/                         # 343 Bun tests
├── skills/                        # orchestrator + brainstorming SKILL.md
├── templates/                     # installed by install.sh to ~/.pi/agent/
│   ├── SYSTEM.md                 #   → Main Agent system prompt
│   ├── SUBAGENTS.md              #   → subagent pipeline guide
│   ├── agent-tool-description.md #   → Agent tool override
│   ├── subagents.json            #   → {toolDescriptionMode: custom}
│   └── agents/                    #   → custom subagent templates
│       ├── software-developer.md
│       └── software-auditor.md
└── scripts/                       # install.sh / install.bat / install.ps1
```

Peer extensions in the same monorepo (each has its own `pi/`
package, see their own `README.md`):

- `pi-codebase-memory/` — tree-sitter AST indexing + 15 MCP tools
- `pi-graphify/` — knowledge graph generator + MCP server
- `pi-magic-context/` — cross-session memory (`ctx_search` / `ctx_note`)
- `pi-aft/` — AFT-backed file ops (`aft_search` / `aft_read` / `aft_edit`)

## Installation

```bash
# From the repo root:
cd sages
./pi/scripts/install.sh

# Or one-liner (uses the GitHub raw URL):
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash
```

The installer:

1. Registers `~/.pi/agent/SYSTEM.md`, `SUBAGENTS.md`,
   `agent-tool-description.md`, `subagents.json` (sentinel-protected;
   preserves user customizations).
2. Ships the two custom subagent templates
   (`software-developer`, `software-auditor`) to
   `~/.pi/agent/agents/`.
3. Installs peer extension npm packages
   (`@tintinweb/pi-subagents`, `@cortexkit/aft-pi`, etc.).
4. Configures AFT and graphify for the host project.

The shell installer suite at `pi/test/install.test.sh` exercises all
of the above idempotently.

## Development

```bash
cd pi
bun install                     # one-time
bun run typecheck               # 0 errors expected
bun test ./test                 # 343 pass
bash test/install.test.sh       # all pass
```

All three must pass before committing. Use `@/...` in `pi/test/`,
relative paths in `pi/src/`.

## Security

- **No direct `node:fs`** in production code — use `FileService`.
- **Path validation** via `validatePath()` (rejects `..`, `~`, `\0`,
  absolute paths).
- **No hardcoded models**, no API keys in code — configuration via
  `~/.pi/agent/settings.json`.
- **Reports and audit state are `chmod 0o600`**; orchestrator dir
  `0o700`. `chmod` is wrapped in `try/catch` for non-POSIX
  platforms.
- **Pending P2**: `injectUpstreamOutputs` reads `upstream.output_path`
  without a realpath / project-prefix check. Currently assumes the
  developer/auditor agents are trusted.

## `pi/.sages/workspace/` — marker, not state

The `.sages/workspace/` directory is intentionally kept as an **empty
marker**. It is read (not written) by:

- `pi-graphify/templates/start-mcp.sh:33,43` — to detect the sage
  root and pick the correct `graphify-out/` location.
- `pi-codebase-memory/src/index.ts:32` — `isSageWorkspace` heuristic
  to decide whether the codebase indexer should run.

The directory must exist for these heuristics to fire. The
`install.sh` ensures it exists when the orchestrator is installed.
No runtime state is stored in it — that all lives in
`.pi/orchestrator/`.

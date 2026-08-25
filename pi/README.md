# Sages — pi package (conductor)

The `pi/` subpackage of the [Sages monorepo](../). This is the
**conductor** layer — a thin profile-driven layer that:

1. Loads the active profile once at module load (`loadProfile()`).
2. Applies the profile via three pi hooks (capability filter,
   prompt composer, reminder injector) in `registerConductorOnly`.
3. Delegates to the orchestrator package: `registerOrchestratorTools(pi, runtimeDeps)`
   from `@sages/pi-orchestrator` (a sibling monorepo package) registers
   the 5 orchestrator tools + installs the orchestrator advisory pipeline.

`standard` is the only built-in profile; user overrides at
`~/.pi/profile.yaml` take precedence.

> **For the full architecture, workflow, and tool surface, see the
> [root README](../README.md) and [root AGENTS.md](../AGENTS.md).**
> This file covers only `pi/`-specific build / install / dev notes.

## What lives in `pi/`

```
pi/
├── src/
│   ├── extension.ts         # 100-line conductor: registerConductorOnly + delegate to orchestrator
│   ├── index.ts             # 30-line public surface
│   ├── profile.ts           # DEFAULT_SOFT_MODE_REMINDER + STANDARD_PROFILE + loadProfile
│   └── profile/             # 4-segment schema + applier
│       ├── index.ts
│       ├── types.ts         # Profile / ToolCapability / Policy schemas
│       ├── validator.ts     # validateProfile()
│       ├── loader.ts        # loadProfile() / clearProfileCache()
│       └── applier.ts       # applyProfile(pi, profile) — three pi hooks
├── profiles/
│   └── standard.yaml        # the only built-in
├── scripts/
│   ├── install.sh           # cross-platform install (peer-dep + pi-orchestrator + pi)
│   ├── install.ps1          # Windows PowerShell installer
│   ├── install.bat          # Windows cmd installer
│   ├── gen-gcdb.ts          # regenerate pi/docs/gc-index.md
│   └── check-all.ts         # aggregate verifier (typecheck + test + verify:*)
├── templates/               # installed by install.sh to ~/.pi/agent/
│   ├── SYSTEM.md            #   → Main Agent system prompt
│   ├── agent-tool-description.md  # → Agent tool override
│   ├── subagents.json       #   → {toolDescriptionMode: custom}
│   ├── aft.jsonc            #   → AFT bridge config
│   ├── magic-context.jsonc  #   → magic-context config
│   └── prompts/             #   → system-prompt presets
└── test/                    # Bun test suite
```

Peer packages in the same monorepo:

- `pi-orchestrator/` — orchestrator tools, orchestrator advisory, observability,
  bash-guard, file-gate, project analyzer, template loader. The
  conductor delegates tool registration here.
- `pi-subagents/` — Agent tool (subagent lifecycle, worktrees).
- `pi-codebase-memory/` — code knowledge graph (MCP server).
- `pi-evaluator/` — eval metrics (cost, security, text quality).

## Installation

```bash
# From the repo root:
cd sages
./pi/scripts/install.sh

# Or one-liner (uses the GitHub raw URL):
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash
```

The installer:

1. Registers `~/.pi/agent/SYSTEM.md`, `agent-tool-description.md`,
   `subagents.json` (sentinel-protected;
   preserves user customizations).
2. Installs the conductor + the orchestrator package (file-copy to
   `~/.pi/packages/pi-orchestrator`) and configures the reverse peer
   symlink.
3. Installs peer extension npm packages
   (`@sages/pi-subagents`, `@cortexkit/aft-pi`, etc.).
4. Configures AFT for the host project.

The shell installer suite at `pi/test/install.test.sh` exercises all
of the above idempotently.

## Development

```bash
cd pi
bun install                     # one-time
bun run typecheck               # 0 errors expected
bun test ./test                 # all green
bash test/install.test.sh       # all pass
```

All three must pass before committing. Use `@/...` in `pi/test/`,
relative paths in `pi/src/`.

## `.pi/orchestrator/` namespace ownership

Developers own `task-{task_id}-report.md` and
`handoff/{workspace_id}/{task_id}-handoff.md`; auditors own
`audit-{task_id}.md`; The orchestrator owns `goal-{id}.yaml`, DAG, audit-state, and
workflow rollup files. Cross-namespace overwrites are rejected, and
Explore/Plan remain read-only.

## Security

- **No hardcoded models**, no API keys in code — configuration via
  `~/.pi/agent/settings.json`.
- **Reports and audit state are `chmod 0o600`**; orchestrator dir
  `0o700`. `chmod` is wrapped in `try/catch` for non-POSIX platforms.
- The 4-stage DAG workflow is the recommended pattern for production
  code on workflows with >2 items in the active todowrite. For ≤2
  items, direct editing is also acceptable (soft mode). No commands
  are mechanically blocked.

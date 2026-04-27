# OpenCode Sages

OpenCode plugin for Four Sages Agents (Fuxi, QiaoChui, LuBan, GaoYao)

## Overview

Sages is an OpenCode plugin that implements a multi-agent workflow system based on the Four Sages Agents mythology. Each agent has a specialized role in the software development lifecycle:

- **Fuxi** - Creates architectural designs using Eight Trigrams methodology
- **QiaoChui** - Reviews designs and decomposes into executable tasks
- **LuBan** - Executes tasks with TDD and file locking for conflict prevention
- **GaoYao** - Performs quality audits including security and coverage checks

## Installation

### Quick Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/scripts/install.sh | bash
```

This clones the repo, runs the install script, and cleans up automatically.

### Manual Install

```bash
bun install
bun run install
```

Or run directly:

```bash
bun scripts/install.ts
```

**What it does:**
1. Build self-contained tools with esbuild
2. Copy `src/agents/*` to `~/.config/opencode/agent/`
3. Copy bundled tools to `~/.config/opencode/tool/`

## Development

```bash
# Build self-contained tools (output: tool/)
bun run build:tools

# Clean build artifacts
bun run clean
```

## Testing

```bash
# All tests
bun run test

# Unit tests only
bun run test:unit

# Integration tests
bun run test:integration
```

## Workflow

1. **Design Phase**: Fuxi creates architectural draft in `.plan/{name}.draft.md`
2. **Review Phase**: QiaoChui reviews and creates execution plan
3. **Approval Phase**: User approves or requests revisions
4. **Execution Phase**: LuBan executes tasks (parallel, up to 3 workers)
5. **Audit Phase**: GaoYao performs final quality check
6. **Completion**: Workflow complete after passing audit

## Architecture

The plugin consists of:

| Directory | Purpose |
|-----------|---------|
| `scripts/` | Build and install scripts |
| `src/agents/` | Agent persona definitions (markdown) |
| `src/engine/` | Workflow engine, file-lock, state-manager, circuit-breaker |
| `src/tools/` | Per-agent tool definitions |
| `src/workflows/` | YAML workflow orchestration |
| `tool/` | Bundled self-contained tools (deploy to ~/.config/opencode/tool/) |

## Dependencies

- [zod](https://github.com/colinhacks/zod) ^4.1.8
- [@opencode-ai/plugin](https://github.com/opencode-ai/opencode) ^1.14.25

## License

MIT

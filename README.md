# OpenCode Sages

OpenCode plugin for Four Sages Agents (Fuxi, QiaoChui, LuBan, GaoYao)

## Overview

Sages is an OpenCode plugin that implements a multi-agent workflow system based on the Four Sages Agents mythology. Each agent has a specialized role in the software development lifecycle:

- **Fuxi** - Creates architectural designs using Eight Trigrams methodology
- **QiaoChui** - Reviews designs and decomposes into executable tasks
- **LuBan** - Executes tasks with TDD and file locking for conflict prevention
- **GaoYao** - Performs quality audits including security and coverage checks

## Installation

```bash
bun install
```

## Development

```bash
# Build the plugin
bun run build:plugin

# Watch mode for development
bun run build:plugin:watch

# Clean build artifacts
bun run clean
```

## Testing

```bash
# All tests
bun run test:all

# Unit tests only
bun run test:unit

# Integration tests
bun run test:integration

# E2E tests
bun run test:e2e
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
| `src/agents/` | Agent persona definitions (markdown) |
| `src/engine/` | Workflow engine, file-lock, state-manager, circuit-breaker |
| `src/tools/` | Per-agent tool definitions |
| `src/workflows/` | YAML workflow orchestration |
| `tool/` | Bundled self-contained tools (deploy to ~/.config/opencode/tool/sages/) |

## Dependencies

- [zod](https://github.com/colinhacks/zod) ^4.1.8
- [@opencode-ai/plugin](https://github.com/opencode-ai/opencode) ^1.14.25

## License

MIT

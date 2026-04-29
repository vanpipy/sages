# OpenCode Sages

A multi-agent workflow system for [OpenCode](https://github.com/opencode-ai/opencode) and [pi](https://pi.dev), inspired by Chinese mythology.

## Overview

Sages implements a Four Sages workflow where each agent has a specialized role:

| Agent | Role | Trigram |
|-------|------|---------|
| **Fuxi (伏羲)** | Architect - Creates designs using Eight Trigrams | ☰ Qian |
| **QiaoChui (巧倕)** | Mechanist - Reviews designs, decomposes into tasks | ☳ Zhen |
| **LuBan (鲁班)** | Craftsman - Implements with TDD methodology | ☴ Xun |
| **GaoYao (皋陶)** | Judge - Quality audits and security checks | ☲ Li |

## Installation

### OpenCode

```bash
# Quick Install (Recommended)
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/opencode/install.sh | bash

# Manual Install
cd opencode && bun install && bun run install
```

### pi

```bash
pi install npm:@sages/pi-four-sages
```

## Usage

### OpenCode

```bash
# Start workflow
/fuxi "add dark mode to the app"

# Approve to proceed
/fuxi-approve
```

### pi

```bash
# Start workflow
/fuxi

# Or use skills directly
/skill:fuxi
/skill:qiaochui
/skill:luban
/skill:gaoyao
```

## Available Tools

### Fuxi (Design)
| Tool | Description |
|------|-------------|
| `fuxi_create_draft` | Create architectural design using Eight Trigrams |
| `fuxi_get_draft` | Read existing draft |
| `fuxi_get_status` | Check workflow status |

### QiaoChui (Review)
| Tool | Description |
|------|-------------|
| `qiaochui_review` | Review design for feasibility |
| `qiaochui_decompose` | Create execution plan |

### LuBan (Implementation)
| Tool | Description |
|------|-------------|
| `luban_execute_task` | Execute task with TDD |
| `luban_get_status` | Check execution progress |

### GaoYao (Audit)
| Tool | Description |
|------|-------------|
| `gaoyao_review` | Quality audit |
| `gaoyao_check_security` | Security scan |

## Workflow

```
Request → Fuxi Design → QiaoChui Review → User Decision
                                         ↓
                    LuBan Execute ←── APPROVE
                         ↓
                    GaoYao Audit
                         ↓
                    Complete
```

**Phase Details:**
1. **Design Phase**: Fuxi creates architectural draft
2. **Review Phase**: QiaoChui reviews and creates execution plan
3. **Approval Phase**: User approves or requests revisions
4. **Execution Phase**: LuBan executes tasks (parallel execution)
5. **Audit Phase**: GaoYao performs quality check
6. **Completion**: Workflow complete after passing audit

## Eight Trigrams Design

Each design draft follows the Eight Trigrams structure:

| Trigram | Section | Purpose |
|---------|---------|---------|
| ☰ Qian | Core Intent | What & Why |
| ☷ Kun | Data Structures | Entities & Models |
| ☳ Zhen | Triggers | Events |
| ☴ Xun | Data Flow | Transformations |
| ☵ Kan | Error Handling | Fallbacks |
| ☲ Li | Observability | Metrics |
| ☶ Gen | Boundaries | Constraints |
| ☱ Dui | Success Path | Happy path |

## Project Structure

```
sages/
├── opencode/              # OpenCode plugin
│   ├── src/
│   │   ├── agents/        # Agent personas (markdown)
│   │   ├── engine/        # Workflow engine, file-lock, state-manager
│   │   ├── hooks/         # Session hooks
│   │   ├── tools/         # Tool definitions
│   │   ├── utils/         # Utilities
│   │   ├── workflows/     # YAML orchestration
│   │   ├── index.ts
│   │   ├── opencode-adapter.ts
│   │   └── types.ts
│   ├── scripts/           # Build scripts
│   ├── test/              # Tests
│   ├── tool/               # Bundled tools
│   ├── build-self-contained-tools.ts
│   ├── install.ts
│   ├── install.sh
│   ├── package.json
│   └── tsconfig.json
│
├── pi/                    # pi plugin
│   ├── extensions/        # pi extension with tools
│   ├── skills/            # Skill definitions (fuxi, qiaochui, luban, gaoyao)
│   ├── prompts/           # Workflow templates
│   └── package.json
│
├── .sages/                 # Workflow state & plans
├── AGENTS.md               # Architecture documentation
└── README.md               # This file
```

## Development

```bash
# Install all dependencies
bun install

# Build OpenCode tools
bun run build:opencode

# Run tests
bun run test
```

## Dependencies

- [zod](https://github.com/colinhacks/zod) ^3.22.0
- [@opencode-ai/plugin](https://github.com/opencode-ai/opencode) ^1.14.25

## License

MIT

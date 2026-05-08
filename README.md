# OpenCode Sages

A multi-agent workflow system for [OpenCode](https://github.com/opencode-ai/opencode) and [pi](https://pi.dev), inspired by Chinese mythology.

## Overview

Sages implements a Four Sages workflow where each agent has a specialized role:

| Agent | Role | Focus |
|-------|------|-------|
| **Fuxi (伏羲)** | Architect | MDD System Design |
| **QiaoChui (巧倕)** | Expert | Technical Review & Decomposition |
| **LuBan (鲁班)** | Craftsman | TDD Implementation |
| **GaoYao (皋陶)** | Auditor | Quality Audit & Security |

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
# Quick Install (Recommended)
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | sh

# Manual Install
./pi/scripts/install.sh

# Or use pi install with local path (after cloning)
git clone https://github.com/vanpipy/sages.git
cd sages
./pi/scripts/install.sh
```

## Usage

### OpenCode

```bash
# Start workflow
/fuxi-start my-plan "add dark mode to the app"

# Review draft
/qiaochui-review
```

### pi

```bash
# Start workflow
fuxi-start my-plan "add dark mode"

# Create draft
fuxi-request "add dark mode"
```

## Commands

### Fuxi ( Design)
| Command | Description |
|---------|-------------|
| `fuxi-start` | Start workflow |
| `fuxi-request` | Create draft.md |
| `fuxi-plan <score>` | Transition to plan (score > 80) |
| `fuxi-recover` | Recover from state.json |
| `fuxi-end` | End and archive workflow |
| `fuxi-get-status` | Get workflow status |

### QiaoChui ( Review)
| Command | Description |
|---------|-------------|
| `qiaochui-review` | Review draft feasibility |
| `qiaochui-decompose` | Create plan.md and execution.yaml |

### LuBan ( Execute)
| Command | Description |
|---------|-------------|
| `luban-execute-task` | Execute single task (TDD) |
| `luban-execute-all` | Execute all tasks |
| `luban-get-status` | Get execution status |

### GaoYao ( Audit)
| Command | Description |
|---------|-------------|
| `gaoyao-review` | Quality audit (Xie Zhi) |
| `gaoyao-check-security` | Security scan |

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

## Workflow Recovery

Four Sages supports resuming interrupted workflows:

| Scenario | Detection | Recovery Action |
|----------|----------|----------------|
| `draft.md` exists + `state.json` exists | Phase detected from `state.json` | Continue from stored phase |
| `draft.md` missing + `state.json` exists | Workflow detected | `fuxi-request` regenerates |
| New request same workspace | Existing workflow | Draft updated, phase preserved |

State is stored in `.sages/workspace/state.json` with phase progression:

```
idle → design → review → plan → execute → audit → complete
```

## MDD Design

Each design draft follows the **Multi-Dimensional Design (MDD)** framework:

| Plane | Elements | Focus |
|-------|----------|-------|
|  Business | Process × Rules | Business value delivery |
|  Data | Logic × State | Data processing |
|  Control | Strategy × Distribution | Decision execution |
|  Foundation | Resource × Abstraction | Infrastructure |
|  Observation | Data × Analysis | Monitoring |
|  Security | Identity × Permissions | Access control |
|  Evolution | Time × Change | Versioning & migration |

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
│   ├── scripts/           # Installation scripts
│   ├── src/               # TypeScript source
│   ├── package.json
│   └── README.md
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

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
```

## Commands

### Fuxi ( Design)
| Command | Description |
|---------|-------------|
| `fuxi-start` | Start workflow, set design phase |
| `fuxi-request` | Create draft.md |
| `fuxi-plan <score>` | Transition to plan (score > 80) |
| `fuxi-recover` | Recover from state.json |
| `fuxi-end` | End workflow, archive |
| `fuxi-get-status` | View current status |
| `fuxi-update-score` | Update review score in state |

### QiaoChui ( Review)
| Command | Description |
|---------|-------------|
| `qiaochui-review` | Review draft, set score in state |
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
| `gaoyao-review` | Quality audit (Xie Zhi methodology) |
| `gaoyao-check-security` | Security scan |

## Workflow

```
Request → Fuxi Design → QiaoChui Review → fuxi-plan
                                              ↓
                    LuBan Execute ←── APPROVE
                         ↓
                    GaoYao Audit
                         ↓
                    Complete → fuxi-end
```

**Phase Details:**
1. **Design Phase**: Fuxi creates architectural draft
2. **Review Phase**: QiaoChui reviews and creates execution plan
3. **Plan Phase**: User approves (score > 80) or revises
4. **Execute Phase**: LuBan executes tasks (parallel execution)
5. **Audit Phase**: GaoYao performs quality check
6. **Completion**: Workflow archived after passing audit

## Workflow Recovery

Four Sages supports resuming interrupted workflows:

| Scenario | Detection | Recovery Action |
|----------|----------|----------------|
| `draft.md` exists + `state.json` exists | Phase from `state.json` | Continue from stored phase |
| `draft.md` missing + `state.json` exists | Workflow detected | `fuxi-request` regenerates |
| New request same workspace | Existing workflow | Draft updated, phase preserved |

State is stored in `.sages/workspace/state.json`:

```json
{
  "id": "sages-1234567890",
  "phase": "design",
  "planName": "user-management",
  "request": "Create REST API for user management",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

Phase progression: `idle → design → review → plan → execute → audit → complete`

## MDD Design

Each design draft follows the **Multi-Dimensional Design (MDD)** framework with Seven Planes:

| Trigram | Plane | Elements | Focus |
|---------|-------|----------|-------|
|  Qian | Business | Process × Rules | Business value delivery |
|  Kun | Data | Logic × State | Data processing |
|  Zhen | Control | Strategy × Distribution | Decision execution |
|  Xun | Foundation | Resource × Abstraction | Infrastructure |
|  Kan | Observation | Data × Analysis | Monitoring |
|  Li | Security | Identity × Permissions | Access control |
|  Gen | Evolution | Time × Change | Versioning & migration |

## TDD Implementation

LuBan implements tasks using **Test-Driven Development**:

```
RED → GREEN → REFACTOR
```

1. **RED**: Write a failing test first
2. **GREEN**: Write minimal code to pass
3. **REFACTOR**: Improve structure while keeping tests passing

## Execution Modes (pi)

LuBan supports two execution modes:

### Subagent Mode (Default)

Each task runs in an **isolated pi subprocess**:

```
┌─────────────────────────────────────────────────────┐
│ Main Agent (Fuxi/QiaoChui context)                  │
│                                                     │
│   qiaochui-decompose use_subagent=true            │
│                      ↓                              │
│   .sages/workspace/execution.yaml                   │
│                      ↓                              │
│ ┌─────────┬─────────┬─────────┐                   │
│ │ LuBan #1│ LuBan #2│ LuBan #3│  ← maxParallel: 3│
│ │   T1    │   T2    │   T3    │                   │
│ └─────────┴─────────┴─────────┘                   │
└─────────────────────────────────────────────────────┘
```

### Shared Context Mode

All tasks share the **same LLM context**:

```
┌─────────────────────────────────────────────────────┐
│ Main Agent (Fuxi/QiaoChui context)                  │
│                                                     │
│   qiaochui-decompose use_subagent=false           │
│                      ↓                              │
│ ┌─────────────────────────────────────────────┐   │
│ │     Single LuBan (shared context)            │   │
│ │     T1 → T2 → T3 (sequential)               │   │
│ └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Project Structure

```
sages/
├── opencode/                    # OpenCode plugin
│   ├── src/
│   │   ├── agents/            # Agent personas (markdown)
│   │   ├── engine/            # Workflow engine, file-lock, state-manager
│   │   ├── hooks/             # Session hooks
│   │   ├── tools/             # Tool definitions
│   │   ├── utils/             # Utilities
│   │   ├── workflows/         # YAML orchestration
│   │   └── opencode-adapter.ts
│   ├── scripts/               # Build scripts
│   ├── test/                  # Tests
│   └── tool/                  # Bundled tools
│
├── pi/                         # pi plugin
│   ├── src/
│   │   ├── tools/             # Modular tools (fuxi, qiaochui, luban, gaoyao)
│   │   ├── state/             # StateManager, WorkspaceManager
│   │   ├── executor/          # TDDRunner, TaskExecutor, SubagentExecutor
│   │   ├── orchestrator/      # WorkflowOrchestrator
│   │   └── utils/             # Draft parser/generator, mode-checker
│   ├── extensions/           # pi extension entry
│   ├── skills/                # Skill definitions (fuxi, qiaochui, luban, gaoyao)
│   ├── prompts/               # Workflow templates
│   ├── test/                  # Tests
│   ├── dist/                  # Built JavaScript
│   └── README.md
│
├── .sages/                    # Workflow state & plans
│   ├── workspace/            # Current workflow
│   └── archive/              # Completed workflows
├── AGENTS.md                  # Architecture documentation
└── README.md                  # This file
```

## pi Package Exports

```typescript
// Tools
export { registerFuxiTools } from "./tools/fuxi-tools.js";
export { registerQiaoChuiTools } from "./tools/qiaochui-tools.js";
export { registerLuBanTools } from "./tools/luban-tools.js";
export { registerGaoYaoTools } from "./tools/gaoyao-tools.js";

// State
export { StateManager, WorkspaceManager } from "./state/index.js";
export type { WorkflowState, Task, AuditResult } from "./state/index.js";

// Executor
export { TDDRunner, TaskExecutor } from "./executor/index.js";
export type { TDDResult, TDDPhase, Task as ExecutorTask, ExecutionResult } from "./executor/index.js";

// Orchestrator
export { WorkflowOrchestrator } from "./orchestrator/index.js";
export type { Phase, OrchestratorConfig } from "./orchestrator/index.js";
```

## Development

```bash
# Install all dependencies
bun install

# Build pi package
cd pi && bun run build

# Run tests
bun run test
```

## License

MIT

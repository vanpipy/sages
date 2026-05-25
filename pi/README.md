# Four Sages Workflow

Four Sages Agents workflow for [pi coding agent](https://pi.dev) — a multi-agent system for software engineering tasks.

## Overview

Named after four sage figures from Chinese mythology, representing the complete software engineering lifecycle:

| Sage | Title | Responsibility | Output |
|------|-------|---------------|--------|
| **Fuxi (伏羲)** | Architect | MDD System Design | Design Document |
| **QiaoChui (巧倕)** | Expert | Technical Review | SPEC + Execution Plan |
| **LuBan (鲁班)** | Engineer | TDD Implementation | Source Code + Tests |
| **GaoYao (皋陶)** | Auditor | Quality Audit | Audit Report + Verdict |

## Installation

### Quick Install

**macOS / Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.ps1 | iex
```

**Windows (CMD):**
```batch
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.bat -o install.bat && install.bat
```

### Manual Install

**macOS / Linux / WSL:**
```bash
git clone https://github.com/vanpipy/sages.git
cd sages
./pi/scripts/install.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/vanpipy/sages.git
cd sages
.\pi\scripts\install.ps1
```

## Commands

### Workflow Commands

#### Fuxi ( Design)

| Command | Description |
|---------|-------------|
| `fuxi-start` | Start workflow, set design phase |
| `fuxi-request` | Create draft.md |
| `fuxi-plan <score>` | Transition to plan (only if score > 80) |
| `fuxi-recover` | Recover from state.json |
| `fuxi-end` | End workflow, archive |
| `fuxi-get-status` | View current status |

#### QiaoChui ( Review)

| Command | Description |
|---------|-------------|
| `qiaochui-review` | Review draft, set score in state.json |
| `qiaochui-decompose` | Create plan.md and execution.yaml |

#### LuBan ( Execute)

| Command | Description |
|---------|-------------|
| `luban-execute-task` | Execute a single task using TDD |
| `luban-execute-all` | Execute all tasks from execution.yaml |
| `luban-get-status` | Get TDD execution status |

#### GaoYao ( Audit)

| Command | Description |
|---------|-------------|
| `gaoyao-review` | Quality audit (phase-guided) |
| `gaoyao-check-security` | Security scan |

## Workflow Flow

### Approval Points

| Phase | Command | Description |
|-------|---------|-------------|
|  **Design** | `fuxi-plan <score>` | Transition to plan (only if score > 80) |
|  **Review** | QiaoChui auto-proceeds | After review with score > 80 |
| 📁 **Archive** | `fuxi-end` | End workflow and archive |

### Phase Progression

```
idle → design → review → plan → execute → audit → complete
```

## Complete Workflow

```
                    ┌─────────────┐
                    │ User Request│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Fuxi      │  Design
                    │ MDD Design  │
                    │ 7 Planes    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │fuxi-request │     Create draft.md
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  QiaoChui   │  Review
                    │ qiaochui-   │
                    │ review      │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │qiaochui-     │     Create tasks
                    │decompose    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  LuBan      │  Execute
                    │ luban-      │     (RED→GREEN→REFACTOR)
                    │ execute-all │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  GaoYao     │  Audit
                    │ gaoyao-     │     (INK→NOSE→FOOT→CASTRATION→DEATH)
                    │ review      │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │fuxi-end     │     Archive
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   🎉 Complete│
                    └─────────────┘
```

## MDD Design Method

Four Sages uses **Multi-Dimensional Design (MDD)** for system architecture:

### Seven Planes

| Plane | Elements | Focus |
|-------|----------|-------|
| **Business** | Process × Rules | Business value delivery |
| **Data** | Logic × State | Data processing |
| **Control** | Strategy × Distribution | Decision execution |
| **Foundation** | Resource × Abstraction | Infrastructure |
| **Observation** | Data × Analysis | Monitoring |
| **Security** | Identity × Permissions | Access control |
| **Evolution** | Time × Change | Versioning & migration |

## TDD Implementation

LuBan implements tasks using **Test-Driven Development**:

```
RED → GREEN → REFACTOR
```

1. **RED**: Write a failing test first
2. **GREEN**: Write minimal code to pass
3. **REFACTOR**: Improve structure while keeping tests passing

### TDD Fallback Guide

When exceptions occur, LuBan provides built-in guidance:

```typescript
import { TDD_GUIDE } from "@/tools/luban/task-runner.js";

// Get phase-specific guidance
const guidance = TDD_GUIDE.getPhaseGuidance("RED");
// Returns: How to write failing tests first

const errorMsg = "Unexpected error";
const formatted = TDD_GUIDE.formatError("GREEN", errorMsg);
// Returns: Error + GREEN phase guidance
```

## Execution Modes

### 1. Subagent Mode (Default)

Each task runs in an **isolated pi subprocess**:

```
┌─────────────────────────────────────────────────────┐
│ Main Agent                                          │
│                                                     │
│   /qiaochui_decompose use_subagent=true           │
│                      ↓                              │
│   .sages/workspace/execution.yaml                    │
│                      ↓                              │
│ ┌─────────┬─────────┬─────────┐                     │
│ │ LuBan #1│ LuBan #2│ LuBan #3│  ← maxParallel: 3│
│ │   T1    │   T2    │   T3    │                   │
│ └─────────┴─────────┴─────────┘                     │
└─────────────────────────────────────────────────────┘
```

### 2. Shared Context Mode

All tasks share the **same LLM context**:

```
┌─────────────────────────────────────────────────────┐
│ Main Agent                                          │
│                                                     │
│   /qiaochui_decompose use_subagent=false          │
│                      ↓                              │
│ ┌─────────────────────────────────────────────┐   │
│ │     Single LuBan (sequential)                │   │
│ │     T1 → T2 → T3                            │   │
│ └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## LuBan Module Architecture

LuBan is modularized for maintainability:

```
src/tools/luban/
├── index.ts          # Tool registration
├── types.ts          # LubanTask, TDDConfig, TaskResult
├── plan-parser.ts    # YAML parsing, dependency resolution
└── task-runner.ts    # TDD execution + TDD_GUIDE
```

**Key Design**: `luban_execute_all` internally calls `luban_execute_task` (DRY principle)

## Execution Plan Configuration

```yaml
# Execution Plan
name: user-management-api

settings:
  maxParallel: 3        # Max parallel subagents
  useSubagent: true     # true = isolated, false = shared
  maxRetry: 1           # Retry on failure

tasks:
  - id: T1
    description: "Setup database schema"
    priority: 1
    dependsOn: []

  - id: T2
    description: "Create user model"
    priority: 1
    dependsOn: [T1]
```

## Audit Phases (GaoYao)

Phase-guided auditing with 5 penalty categories:

| Phase | Category | Focus | Penalty |
|-------|----------|-------|---------|
| INK | 墨刑 | Code style | Minor |
| NOSE | 劓刑 | Naming/docs | Minor |
| FOOT | 剕刑 | Architecture | Major |
| CASTRATION | 宫刑 | Security | Critical |
| DEATH | 大辟 | Critical defect | Fail |

## File Structure

```
~/.pi/agent/
├── npm/@sages/              # Installed package
│   ├── dist/                # Built JavaScript
│   ├── extensions/          # Extension config
│   ├── skills/              # Fuxi, QiaoChui, LuBan, GaoYao
│   └── prompts/             # Workflow templates
│
└── extensions/             # User extensions

sages/pi/
├── src/
│   ├── tools/               # Modular tools
│   │   ├── fuxi/
│   │   ├── qiaochui/
│   │   ├── luban/
│   │   └── gaoyao/
│   ├── services/            # FileService, WorkflowStateManager
│   └── utils/               # model-helper, mode-checker
├── test/                    # Unit tests (uses @/ alias)
└── README.md
```

## Security Practices

| Practice | Implementation |
|----------|---------------|
| No direct node:fs | Use `FileService` from `@/services/file-service.js` |
| Path validation | `validatePath()` prevents traversal attacks |
| No hardcoded models | Use `getUserDefaultModel()` from `@/utils/model-helper.js` |
| No API keys | Configuration via `~/.pi/agent/settings.json` |

## Development

```bash
# Type-check (run before committing)
bun run typecheck

# Run tests
bun test ./test
```

> **⚠️ Important**: Both checks must pass before committing.

## Examples

```
You: fuxi-start user-api Create a REST API for user management
pi: Workflow started: user-api

You: fuxi-request Create a REST API for user management
pi: Draft created: .sages/workspace/draft.md

You: qiaochui-review
pi: Score: 85 - APPROVED

You: qiaochui-decompose
pi: Tasks created: 4 tasks in execution.yaml

You: fuxi-plan 85
pi: Plan phase started

You: luban-execute-all
pi: [LuBan] Executing 4 tasks...
pi: [LuBan] T1: RED → GREEN → REFACTOR ✓
pi: [LuBan] T2, T3: Parallel execution...
pi: [LuBan] All tasks complete! (4/4)

You: gaoyao-review
pi: [GaoYao] Verdict: PASS (95%)

You: fuxi-end
pi: Workflow archived to .sages/archive/user-api/
```

## License

MIT

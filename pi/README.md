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

```bash
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | sh
```

### Manual Install

```bash
# Clone the repository
git clone https://github.com/vanpipy/sages.git
cd sages

# Run installation
./pi/scripts/install.sh
```

### Options

```bash
./pi/scripts/install.sh [options]

Options:
  --prefix PATH   pi config directory (default: ~/.pi)
  --force         Overwrite existing installation
  --uninstall     Remove installed files
  --dry-run       Preview without making changes
  --help          Show help message
```

### Examples

```bash
# Install with defaults
./pi/scripts/install.sh

# Install to custom directory
./pi/scripts/install.sh --prefix /custom/.pi

# Overwrite existing
./pi/scripts/install.sh --force

# Uninstall
./pi/scripts/install.sh --uninstall

# Preview changes
./pi/scripts/install.sh --dry-run
```

## Commands

After installation, restart pi and use these commands:

### Workflow Commands

| Command | Description |
|---------|-------------|
| `/fuxi <request>` | Start a new workflow with your request |
| `/fuxi-approve` | Approve current phase and proceed |
| `/fuxi-reject` | Reject and stop the workflow |
| `/fuxi-status` | View current workflow status |
| `/fuxi-execute` | Execute planned tasks |
| `/fuxi-archive` | Archive completed workflow |
| `/fuxi-archives` | List archived workflows |
| `/fuxi-restore` | Restore an archived workflow |

### Skills

| Skill | Description |
|-------|-------------|
| `fuxi` | Four Sages workflow agent for architectural design |
| `qiaochui` | Four Sages workflow agent for review and decomposition |
| `luban` | Four Sages workflow agent for implementation |
| `gaoyao` | Four Sages workflow agent for audit |

## Complete Workflow

```
                    ┌─────────────┐
                    │ User Request│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☰ Fuxi      │
                    │ MDD Design  │
                    │ 7 Planes    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │/fuxi-approve│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☳ QiaoChui  │
                    │ Review      │
                    │ Decompose   │ ← Configure execution mode
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │/fuxi-approve│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☴ LuBan     │
                    │ Execute     │
                    │ TDD        │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │/fuxi-approve│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☲ GaoYao    │
                    │ Audit       │
                    │ Security    │
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

### MDD Framework

```
Factor (因子) → Element (要素) → Plane (平面) → System (系统)
```

- **Factor**: Basic attributes (hidden)
- **Element**: Observable dimensions
- **Plane**: Two elements spanning observation space
- **System**: Multiple planes forming a whole

## Execution Modes

LuBan supports two execution modes for task implementation:

### 1. Subagent Mode (Default)

Each task runs in an **isolated pi subprocess** with its own LLM context.

```
┌─────────────────────────────────────────────────────┐
│ Main Agent (Fuxi/QiaoChui context)                  │
│                                                     │
│   /qiaochui_decompose use_subagent=true            │
│                      ↓                              │
│   .sages/workspace/execution.yaml                   │
│                      ↓                              │
│ ┌─────────┬─────────┬─────────┐                   │
│ │ LuBan #1│ LuBan #2│ LuBan #3│  ← maxParallel: 3│
│ │   T1    │   T2    │   T3    │                   │
│ │(isolated)│(isolated)│(isolated)│                  │
│ └─────────┴─────────┴─────────┘                   │
│                      ↓                            │
│              Results merged                         │
└─────────────────────────────────────────────────────┘
```

**Benefits:**
- True parallelism (independent processes)
- No LLM context pollution
- Independent error handling
- Better scalability

### 2. Shared Context Mode

All tasks share the **same LLM context** in a single pi session.

```
┌─────────────────────────────────────────────────────┐
│ Main Agent (Fuxi/QiaoChui context)                  │
│                                                     │
│   /qiaochui_decompose use_subagent=false          │
│                      ↓                              │
│ ┌─────────────────────────────────────────────┐   │
│ │     Single LuBan (shared context)            │   │
│ │     T1 → T2 → T3 (sequential)               │   │
│ │     Shared variables and state               │   │
│ └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Use cases:**
- Simple scripts (single task)
- Tasks that need shared state
- Debugging (easier to trace)

## Execution Plan Configuration

The execution plan is saved to `.sages/workspace/execution.yaml`:

```yaml
# Execution Plan
name: user-management-api

settings:
  maxParallel: 3        # Max parallel subagents
  useSubagent: true     # true = isolated, false = shared
  maxRetry: 1           # Retry on failure
  subagentConfig:
    model: sonnet
    skills:
      - luban
    maxContext: 4000
    timeout: 300

tasks:
  - id: T1
    description: "Setup database schema"
    priority: 1
    dependsOn: []

  - id: T2
    description: "Create user model"
    priority: 1
    dependsOn: [T1]

  - id: T3
    description: "Create user routes"
    priority: 1
    dependsOn: [T1]

  - id: T4
    description: "Write user tests"
    priority: 2
    dependsOn: [T2]
```

### Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxParallel` | 3 | Maximum parallel subagents |
| `useSubagent` | true | Execution mode |
| `maxRetry` | 1 | Retry count on failure |
| `subagentConfig.model` | sonnet | LLM model for subagents |
| `subagentConfig.timeout` | 300 | Timeout in seconds |

### Overriding via Command

```bash
# Use subagent mode (default)
/qiaochui_decompose

# Use shared context mode
/qiaochui_decompose use_subagent=false

# Custom parallelism
/qiaochui_decompose max_parallel=5

# Combine options
/qiaochui_decompose use_subagent=false max_parallel=1
```

## TDD Implementation

LuBan implements tasks using **Test-Driven Development**:

```
RED → GREEN → REFACTOR
```

1. **RED**: Write a failing test first
2. **GREEN**: Write minimal code to pass
3. **REFACTOR**: Improve structure while keeping tests passing

## File Structure

```
~/.pi/agent/
├── npm/@sages/              # Installed package
│   ├── package.json
│   ├── dist/                # Built JavaScript
│   ├── extensions/          # Extension config
│   ├── skills/              # Fuxi, QiaoChui, LuBan, GaoYao
│   └── prompts/             # Workflow templates
│
└── extensions/             # User extensions

.sages/workspace/           # Current workflow
├── draft.md               # MDD Design (Fuxi)
├── plan.md                # Task plan
├── execution.yaml         # Execution config
├── tasks.json            # Task list
└── state.json            # Workflow state
```

## Updating

```bash
# Update all packages
pi update

# Update specific package
pi update --extension npm:@sages/pi-four-sages
```

## Uninstalling

```bash
# Using install script
./pi/scripts/install.sh --uninstall

# Or using pi
pi remove npm:@sages/pi-four-sages
```

## Examples

### Full Workflow Example

```
You: /fuxi Create a REST API for user management

pi: [Fuxi] I'll design this using MDD Seven Planes...
pi: Design draft created. Use /fuxi-approve to proceed.

You: /fuxi-approve

pi: [QiaoChui] Reviewing technical feasibility...
pi: [QiaoChui] Decomposing into tasks...
pi: Tasks created with subagent mode (maxParallel: 3)
pi: Use /fuxi-approve to proceed.

You: /fuxi-approve

pi: [LuBan] Starting execution with 4 tasks...
pi: [LuBan] Spawning subagents...
pi: [LuBan #1] Task T1: Setup database - RED phase
pi: [LuBan #2] Task T2: Wait for T1...
pi: [LuBan #3] Task T3: Wait for T1...
pi: [LuBan #4] Task T4: Wait for T2...
pi: [LuBan #1] T1 complete ✓
pi: [LuBan #2] Task T2: Creating model - RED phase
pi: [LuBan #3] Task T3: Creating routes - RED phase
pi: [LuBan #2] T2 complete ✓
pi: [LuBan #4] Task T4: Writing tests - RED phase
pi: [LuBan #3] T3 complete ✓
pi: [LuBan #4] T4 complete ✓
pi: All tasks complete! (4/4)
pi: Use /fuxi-approve to proceed.

You: /fuxi-approve

pi: [GaoYao] Running quality audit...
pi: [GaoYao] Running security scan...
pi: [GaoYao] Verdict: PASS
pi: Workflow complete!
pi: Use /fuxi-archive to save
```

## Documentation

- [Four Sages Workflow](prompts/four-sages-workflow.md) - Full workflow guide
- [Fuxi Skill](skills/fuxi/SKILL.md) - Architect skill
- [QiaoChui Skill](skills/qiaochui/SKILL.md) - Expert skill
- [LuBan Skill](skills/luban/SKILL.md) - Engineer skill
- [GaoYao Skill](skills/gaoyao/SKILL.md) - Auditor skill

## License

MIT

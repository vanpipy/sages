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
# Clone the repository
git clone https://github.com/vanpipy/sages.git
cd sages

# Run installation
./pi/scripts/install.sh
```

**Windows (PowerShell):**
```powershell
# Clone the repository
git clone https://github.com/vanpipy/sages.git
cd sages

# Run installation
.\pi\scripts\install.ps1
```

**Windows (CMD):**
```batch
REM Clone the repository
git clone https://github.com/vanpipy/sages.git
cd sages

REM Run installation
.\pi\scripts\install.bat
```

### Options

**macOS / Linux (bash):**
```bash
./pi/scripts/install.sh [options]

Options:
  --prefix PATH   pi config directory (default: ~/.pi)
  --force         Overwrite existing installation
  --uninstall     Remove installed files
  --dry-run       Preview without making changes
  --help          Show help message
```

**Windows (PowerShell):**
```powershell
.\pi\scripts\install.ps1 [-Prefix PATH] [-Force] [-Uninstall] [-Help]
```

**Windows (CMD):**
```batch
.\pi\scripts\install.bat [options]

Options:
  --prefix PATH   pi config directory (default: ~\.pi)
  --force         Overwrite existing installation
  --uninstall     Remove installed files
  --help, -h      Show help message
```

### Examples

**macOS / Linux:**
```bash
# Install with defaults
./pi/scripts/install.sh

# Install to custom directory
./pi/scripts/install.sh --prefix /custom/.pi

# Overwrite existing
./pi/scripts/install.sh --force

# Uninstall
./pi/scripts/install.sh --uninstall
```

**Windows (PowerShell):**
```powershell
# Install with defaults
.\pi\scripts\install.ps1

# Install to custom directory
.\pi\scripts\install.ps1 -Prefix C:\custom\.pi

# Overwrite existing
.\pi\scripts\install.ps1 -Force

# Uninstall
.\pi\scripts\install.ps1 -Uninstall
```

**Windows (CMD):**
```batch
REM Install with defaults
.\pi\scripts\install.bat

REM Install to custom directory
.\pi\scripts\install.bat --prefix C:\custom\.pi

REM Overwrite existing
.\pi\scripts\install.bat --force

REM Uninstall
.\pi\scripts\install.bat --uninstall
```

## Commands

After installation, restart pi and use these commands:

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
| `gaoyao-review` | Quality audit, generate report |
| `gaoyao-check-security` | Security scan (SQL injection, XSS, auth) |

### Skills

| Skill | Description |
|-------|-------------|
| `fuxi` | Four Sages workflow agent for architectural design |
| `qiaochui` | Four Sages workflow agent for review and decomposition |
| `luban` | Four Sages workflow agent for implementation |
| `gaoyao` | Four Sages workflow agent for audit |

## Workflow Flow

### Approval Points

| Phase | Command | Description |
|-------|---------|-------------|
|  **Design** | `fuxi-plan <score>` | Transition to plan (only if score > 80) |
|  **Review** | QiaoChui auto-proceeds | After review with score > 80 |
| 📁 **Archive** | `fuxi-end` | End workflow and archive |

### Auto-Proceed Phases

| Phase | Behavior |
|-------|----------|
|  **Review** | Auto-proceeds after qiaochui-review |
|  **Execute** | Manual via luban-execute commands |
|  **Audit** | Manual via gaoyao commands |

## Workflow Recovery

Four Sages supports resuming interrupted workflows:

### Recovery Scenarios

| Scenario | Detection | Recovery Action |
|----------|----------|----------------|
| `draft.md` exists + `state.json` exists | Phase detected from `state.json` | `fuxi-recover` continues from stored phase |
| `draft.md` missing + `state.json` exists | Workflow detected but draft lost | `fuxi-request` regenerates with original request |
| New request same workspace | Existing workflow detected | Draft updated, phase preserved |

### State File

Workflow state is stored in `.sages/workspace/state.json`:

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
                    │  Fuxi      │  Design (Manual)
                    │ MDD Design  │
                    │ 7 Planes    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐     ← Use fuxi-request
                    │fuxi-request │     Create draft.md
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  QiaoChui  │  Review (Manual)
                    │ qiaochui-   │
                    │ review      │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐     ← Use qiaochui-decompose
                    │qiaochui-    │     Create tasks
                    │decompose    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐     ← Use luban-execute-all
                    │  LuBan     │  Execute
                    │ luban-      │
                    │ execute-all │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐     ← Use gaoyao-review
                    │  GaoYao    │  Audit
                    │ gaoyao-     │
                    │ review      │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐     ← Use fuxi-end
                    │fuxi-end     │     Archive
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   🎉 Complete│
                    └─────────────┘
```

### Phase Summary

| # | Phase | Command | Description |
|---|-------|---------|-------------|
| 1 |  Fuxi | `fuxi-start` | Start workflow |
| 2 |  Fuxi | `fuxi-request` | Create draft.md |
| 3 |  QiaoChui | `qiaochui-review` | Review draft |
| 4 |  QiaoChui | `qiaochui-decompose` | Create tasks |
| 5 |  LuBan | `luban-execute-all` | Execute all tasks |
| 6 |  GaoYao | `gaoyao-review` | Quality audit |
| 7 | Archive | `fuxi-end` | End and archive |

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
├── execution.yaml         # Execution config (single source of truth)
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

**macOS / Linux:**
```bash
# Using install script
./pi/scripts/install.sh --uninstall

# Or using pi
pi remove npm:@sages/pi-four-sages
```

**Windows (PowerShell):**
```powershell
# Using install script
.\pi\scripts\install.ps1 -Uninstall

# Or using pi
pi remove npm:@sages/pi-four-sages
```

**Windows (CMD):**
```batch
REM Using install script
.\pi\scripts\install.bat --uninstall

REM Or using pi
pi remove npm:@samfp/sages
```

## Examples

### Full Workflow Example

```
You: fuxi-start user-api Create a REST API for user management

pi: [Fuxi] Starting workflow...
pi: Workflow started: user-api

You: fuxi-request Create a REST API for user management

pi: [Fuxi] Creating MDD design draft...
pi: Draft created: .sages/workspace/draft.md

You: qiaochui-review

pi: [QiaoChui] Reviewing technical feasibility...
pi: Score: 85 - APPROVED

You: qiaochui-decompose

pi: [QiaoChui] Decomposing into tasks...
pi: Tasks created: .sages/workspace/execution.yaml

You: fuxi-plan 85

pi: Plan phase started (score: 85)

You: luban-execute-all

pi: [LuBan] Starting execution with 4 tasks...
pi: [LuBan #1] Task T1: RED → GREEN → REFACTOR
pi: [LuBan #2] Task T2: Waiting for T1...
pi: [LuBan #3] Task T3: Waiting for T1...
pi: [LuBan #1] T1 complete ✓ (committed)
pi: [LuBan #2] Task T2: RED → GREEN → REFACTOR
pi: [LuBan #3] Task T3: RED → GREEN → REFACTOR
pi: [LuBan #2] T2 complete ✓ (committed)
pi: [LuBan #3] T3 complete ✓ (committed)
pi: All tasks complete! (3/3)

You: gaoyao-review

pi: [GaoYao] Running quality audit...
pi: [GaoYao] Verdict: PASS
pi: Workflow complete!

You: fuxi-end

pi: Workflow archived to .sages/archive/user-api/
```

## Documentation

- [Four Sages Workflow](prompts/four-sages-workflow.md) - Full workflow guide
- [Fuxi Skill](skills/fuxi/SKILL.md) - Architect skill
- [QiaoChui Skill](skills/qiaochui/SKILL.md) - Expert skill
- [LuBan Skill](skills/luban/SKILL.md) - Engineer skill
- [GaoYao Skill](skills/gaoyao/SKILL.md) - Auditor skill

## License

MIT

# Sages

A multi-agent workflow system for [pi](https://pi.dev), inspired by Chinese mythology.

## Overview

Sages implements a Four Sages workflow where each agent has a specialized role:

| Agent | Role | Focus |
|-------|------|-------|
| **Fuxi (伏羲)** | Architect | MDD System Design |
| **QiaoChui (巧倕)** | Expert | Technical Review & Decomposition |
| **LuBan (鲁班)** | Craftsman | TDD Implementation |
| **GaoYao (皋陶)** | Auditor | Quality Audit & Security |

## Installation

### pi

```bash
# Quick Install (Recommended)
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | sh

# Manual Install
./pi/scripts/install.sh
```

## Commands

> **Note**: The tool surface was simplified in the simplify-actions refactor (18+ → 10 active tools). Each tool returns `{status, intent, validation}` and auto-advances on observation. Deprecated tool names remain as stubs that return `isError` with a redirect hint.

### Fuxi ( Design) — 3 tools
| Tool | Description |
|------|-------------|
| `fuxi_start` | Initialize workflow (`state.json` + design sub-state) |
| `fuxi_design` | Observe cycle: `design` (write draft) → `review` (validate score >= 80) → `plan` |
| `fuxi_end` | End workflow based on audit verdict (PASS / NEEDS_CHANGES / REJECTED) |

### QiaoChui ( Review) — 2 tools
| Tool | Description |
|------|-------------|
| `qiaochui_review` | Review draft. Without observation: returns heuristic hints + semantic-tool guidance. With `observation: { score, notes? }`: validates 0-100, persists to `state.json`, returns verdict (APPROVED >= 80, REVISE 50-79, REJECTED < 50). |
| `qiaochui_decompose` | Decompose approved design into `plan.md` + `execution.yaml`. Requires `state.score >= 80`. |

### LuBan ( Execute) — 2 tools
| Tool | Description |
|------|-------------|
| `luban_execute_task` | Single task observe cycle (RED → GREEN → REFACTOR → complete). The LLM uses **serena** / **codebase-memory** / **graphify** for implementation; LuBan validates. |
| `luban_run_batch` | Planner — reads `execution.yaml`, returns ordered plan with file conflicts and topological layers. |

### GaoYao ( Audit) — 3 tools
| Tool | Description |
|------|-------------|
| `gaoyao_audit` | Init / resume / reset / status (one tool). `reset: true` clears existing session. |
| `gaoyao_observe` | Discriminated union: `file_read: {...}` or `finding: {...}`. Auto-advances when phase requirements are met. |
| `gaoyao_finalize` | Generate `audit.md` with verdict. |

## Workflow

```
Request → fuxi_start
   ↓
[fuxi_design observe cycle]
   LLM writes draft.md → fuxi_design { observation: {phase:"design"} }
   qiaochui_review { observation: {score: N} } auto-writes state.score
   fuxi_design { observation: {phase:"review", score: N} } → advances if >= 80
   qiaochui_decompose → execution.yaml
   ↓
[luban_run_batch → plan]
[luban_execute_task observe cycle per task]
   RED → GREEN → REFACTOR → complete (LLM does work via serena/codebase-memory/graphify)
   ↓
[gaoyao_audit / gaoyao_observe / gaoyao_finalize]
   ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH → verdict
   ↓
fuxi_end { observation: {verdict: "PASS|NEEDS_CHANGES|REJECTED"} }
   PASS → archive | NEEDS_CHANGES → LuBan | REJECTED → Fuxi
```

**Phase Details:**
1. **Design Phase** (Fuxi): write `draft.md` via `fuxi_design` observe cycle (MDD Seven Planes, ≥ 500 bytes)
2. **Review Phase** (QiaoChui): `qiaochui_review { observation: {score} }` auto-writes; threshold ≥ 80
3. **Plan Phase**: `qiaochui_decompose` generates `execution.yaml`
4. **Execute Phase** (LuBan): `luban_run_batch` plans, `luban_execute_task` runs observe cycle per task
5. **Audit Phase** (GaoYao): `gaoyao_audit / observe / finalize` walks 5 audit categories
6. **End**: `fuxi_end` archives on PASS, routes NEEDS_CHANGES back to LuBan, REJECTED back to Fuxi

## Workflow Recovery

Four Sages supports resuming interrupted workflows via per-tool init/resume semantics:

| Scenario | Detection | Recovery Action |
|----------|----------|----------------|
| Resume workflow | `fuxi_design` (no observation) loads state | Returns current sub-phase (design/review/plan) |
| Resume audit | `gaoyao_audit` (no params) loads session | Returns current phase + remaining work |
| Resume task | `luban_execute_task` (no observation) loads task state | Returns current sub-phase (RED/GREEN/REFACTOR) |
| Fresh start | `reset: true` on `gaoyao_audit`, or delete `.sages/workspace/` | Init from scratch |

State is stored in `.sages/workspace/state.json` (managed by `WorkflowStateManager`) with sub-state files for each sage:
- `.sages/workspace/.fuxi-design-state.json` (design sub-phase)
- `.sages/workspace/.luban-task-state.json` (per-task TDD phase)
- `.sages/workspace/.gaoyao-session.json` (audit session)

Phase progression: `design → review → plan → execute → audit → complete`

## MDD Design

Each design draft follows the **Multi-Dimensional Design (MDD)** framework with Seven Planes:

| Plane | Elements | Focus |
|---------|----------|-------|
| Business | Process × Rules | Business value delivery |
| Data | Logic × State | Data processing |
| Control | Strategy × Distribution | Decision execution |
| Foundation | Resource × Abstraction | Infrastructure |
| Observation | Data × Analysis | Monitoring |
| Security | Identity × Permissions | Access control |
| Evolution | Time × Change | Versioning & migration |

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
TDD_GUIDE.getPhaseGuidance("RED");  // How to write failing tests
TDD_GUIDE.getPhaseGuidance("GREEN"); // How to write minimal code
TDD_GUIDE.getPhaseGuidance("REFACTOR"); // How to refactor
```

## Execution Modes

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
│ │     Single LuBan (shared context)             │   │
│ │     T1 → T2 → T3 (sequential)               │   │
│ └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Project Structure

```
sages/
├── pi/                         # pi plugin
│   ├── src/
│   │   ├── tools/             # Modular tools
│   │   │   ├── fuxi/         # Fuxi tools
│   │   │   ├── qiaochui/     # QiaoChui tools
│   │   │   ├── luban/        # LuBan tools
│   │   │   └── gaoyao/       # GaoYao tools
│   │   ├── services/         # Shared services
│   │   │   ├── file-service.ts
│   │   │   └── workflow-state-manager.ts
│   │   └── utils/            # Utilities
│   ├── test/                 # Unit tests
│   ├── extensions/           # Extension config
│   ├── skills/               # Skill definitions
│   └── prompts/              # Workflow templates
│
├── .sages/                   # Workflow state & plans
│   ├── workspace/            # Current workflow
│   └── archive/              # Completed workflows
├── AGENTS.md                  # Architecture documentation
└── README.md                  # This file
```

## pi Package Exports

```typescript
// Tools
export { registerFuxiTools } from "./tools/fuxi-tools.js";
export { registerQiaoChuiTools } from "./tools/qiaochui/index.js";
export { registerLubanTools } from "./tools/luban/index.js";
export { registerGaoYaoTools } from "./tools/gaoyao-tools.js";

// Services
export { FileService } from "./services/file-service.js";
export { WorkflowStateManager } from "./services/workflow-state-manager.js";

// Executor (from luban module)
export { runTask, runTDDCycle, parseExecutionYaml } from "./executor/index.js";
export type { LubanTask, TDDConfig, TaskResult, TDDPhase } from "./executor/index.js";

// Orchestrator removed in simplify-actions refactor (dead code, replaced by FSM extension in extensions/sages-fsm.ts)
```

## Development

```bash
# Install dependencies
bun install

# Type-check (run before committing)
cd pi && bun run typecheck

# Run tests
cd pi && bun test ./test
```

> **⚠️ Reminder**: Before committing, always run `bun run typecheck` to verify no TypeScript errors, and `bun test ./test` to ensure all tests pass.

## Security Practices

| Practice | Implementation |
|----------|---------------|
| No direct node:fs | Use `FileService` from `@/services/file-service.js` |
| Path validation | `validatePath()` prevents traversal attacks |
| No hardcoded models | Use `getUserDefaultModel()` from `@/utils/model-helper.js` |
| No API keys | Configuration via `~/.pi/agent/settings.json` |

## License

MIT

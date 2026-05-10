# Sages - Four Sages Agents

A multi-agent workflow system for [pi](https://pi.dev), inspired by Chinese mythology.

## Architecture Overview

The system implements four specialized agents that collaborate through a structured workflow:

```
design (Fuxi) → review (QiaoChui) → approve (user) → execute (LuBan) → audit (GaoYao) → archive
```

## The Four Sages Agents

### Fuxi (伏羲) - The Architect 

- **Role**: Architectural design using MDD Seven Planes methodology
- **Tools**: `fuxi-start`, `fuxi-request`, `fuxi-plan`, `fuxi-recover`, `fuxi-end`, `fuxi-get-status`, `fuxi-update-score`
- **Focus**: Core intent, success paths, boundaries, constraints

### QiaoChui (巧倕) - The Sages Mechanist 

- **Role**: Design review and task decomposition
- **Tools**: `qiaochui-review`, `qiaochui-decompose`
- **Focus**: Feasibility, executable task breakdown, execution orchestration

### LuBan (鲁班) - The Master Craftsman 

- **Role**: Task execution with TDD methodology
- **Tools**: `luban-execute-task`, `luban-execute-all`, `luban-get-status`
- **Focus**: Implementation with RED → GREEN → REFACTOR, parallel execution

### GaoYao (皋陶) - The Supreme Judge 

- **Role**: Quality audit and security review
- **Tools**: `gaoyao-review`, `gaoyao-check-security`
- **Focus**: Code quality, security, test coverage, performance

## Workflow Phases

```
 Design → fuxi-plan → Review (auto-proceed) → fuxi-plan → 
 Execute → fuxi-approve → Audit → Complete → fuxi-end
```

### Phase 1: Design (Fuxi) 
- Creates architectural draft using MDD Seven Planes
- Output: `.sages/workspace/draft.md`
- **Requires**: User approval (`fuxi-plan`)

### Phase 2: Review (QiaoChui) 
- Validates draft completeness and feasibility
- **Auto-proceeds** if draft is valid (score > 80)
- Creates execution plan
- Output: `.sages/workspace/plan.md`, `execution.yaml`

### Phase 3: Execute (LuBan) 
- Executes tasks with real TDD (RED → GREEN → REFACTOR)
- Parallel execution (up to 3 tasks)
- Output: Implementation files

### Phase 4: Audit (GaoYao) 
- Quality audit and security scan
- Output: `.sages/workspace/audit.md`
- **Requires**: User approval (`fuxi-plan`)

### Phase 5: Archive
- Saves complete workflow snapshot
- Output: `.sages/archive/{plan}/{timestamp}/`

## Workspace & Archive Structure

### Active Workflow (`.sages/workspace/`)

```
.sages/workspace/
├── draft.md          # Fuxi's design (MDD Seven Planes)
├── plan.md           # Task plan (QiaoChui)
├── execution.yaml    # Execution configuration (single source of truth)
├── state.json        # Workflow state
└── audit.md          # Audit report (GaoYao)
```

### Archived Workflows (`.sages/archive/`)

```
.sages/archive/
└── {plan-name}/
    └── {timestamp}/      # ISO timestamp
        ├── draft.md
        ├── plan.md
        ├── execution.yaml
        ├── state.json
        ├── audit.md
        └── summary.md    # Auto-generated overview
```

## State Management

- **Persistence**: File-based in `.sages/workspace/`
- **Checkpoints**: Auto-save on phase transitions
- **Recovery**: Restore from session or workspace files

## Project Structure

```
sages/
├── pi/                          # pi plugin
│   ├── src/
│   │   ├── tools/               # Modular tools (fuxi, qiaochui, luban, gaoyao)
│   │   ├── state/               # StateManager, WorkspaceManager
│   │   ├── executor/            # TDDRunner, TaskExecutor
│   │   ├── orchestrator/        # WorkflowOrchestrator
│   │   └── utils/               # Draft parser/generator
│   ├── extensions/             # pi extension entry
│   ├── skills/                  # Skill definitions
│   └── prompts/                 # Workflow templates
│
└── .sages/                      # Runtime workspace & archives
    ├── workspace/               # Current workflow
    └── archive/                  # Completed workflows
```

## Design Draft Format (MDD Seven Planes)

Each design draft follows the MDD Seven Planes structure:

| Trigram | Section | Purpose |
|---------|---------|---------|
|  Qian | Core Intent | Why we're building this |
|  Kun | Data Models | Entities and relationships |
|  Zhen | Triggers | Events and conditions |
|  Xun | Data Flow | Transformations |
|  Kan | Error Handling | Fallback strategies |
|  Li | Observability | Metrics and logging |
|  Gen | Boundaries | Constraints and limits |
|  Dui | Success Path | Happy path scenarios |

## pi Package Architecture

The pi package exports modular components:

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

## File Locking (LuBan)

- TTL: 30 minutes
- Auto-release on task complete
- Conflict notification: immediate

## Error Recovery

- Fail-fast with 3 retries
- Retry delay: 1000ms
- Max consecutive failures threshold: 5
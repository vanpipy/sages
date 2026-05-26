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
- **Module**: `src/tools/qiaochui/` (index, review-service, decompose-service, types)

### LuBan (鲁班) - The Master Craftsman 

- **Role**: Task execution with TDD methodology
- **Tools**: `luban-execute-task`, `luban-execute-all`, `luban-get-status`
- **Focus**: Implementation with RED → GREEN → REFACTOR, parallel execution
- **Module**: `src/tools/luban/` (index, types, plan-parser, task-runner)
- **TDD Guide**: Built-in fallback guidance for exceptions

### GaoYao (皋陶) - The Supreme Judge 

- **Role**: Quality audit and security review
- **Tools**: `gaoyao-review`, `gaoyao-check-security`
- **Focus**: Code quality, security, test coverage, performance
- **Phase-guided auditing**: INK → NOSE → FOOT → CASTRATION → DEATH

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
- `luban_execute_all` internally calls `luban_execute_task`
- Output: Implementation files

### Phase 4: Audit (GaoYao) 
- Quality audit and security scan
- Phase-guided: INK (style), NOSE (docs), FOOT (arch), CASTRATION (security), DEATH (critical)
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
│   │   ├── tools/               # Modular tools
│   │   │   ├── fuxi/           # Fuxi (Architect)
│   │   │   ├── qiaochui/       # QiaoChui (Review)
│   │   │   │   ├── index.ts
│   │   │   │   ├── types.ts
│   │   │   │   ├── review-service.ts
│   │   │   │   └── decompose-service.ts
│   │   │   ├── luban/           # LuBan (Execute)
│   │   │   │   ├── index.ts     # Tool registration
│   │   │   │   ├── types.ts     # Shared interfaces
│   │   │   │   ├── plan-parser.ts  # YAML parsing
│   │   │   │   └── task-runner.ts  # TDD execution
│   │   │   └── gaoyao/          # GaoYao (Audit)
│   │   ├── services/            # Shared services
│   │   │   ├── file-service.ts  # File operations
│   │   │   └── workflow-state-manager.ts
│   │   └── utils/               # Utilities
│   │       ├── model-helper.ts  # Get default model
│   │       └── mode-checker.ts
│   ├── test/                    # Unit tests
│   ├── skills/                  # Skill definitions
│   └── prompts/                 # Workflow templates
│
└── .sages/                      # Runtime workspace & archives
    ├── workspace/               # Current workflow
    └── archive/                  # Completed workflows
```

## Design Draft Format (MDD Seven Planes)

Each design draft follows the MDD Seven Planes structure:

| Section | Purpose |
|---------|---------|
| Core Intent | Why we're building this |
| Data Models | Entities and relationships |
| Triggers | Events and conditions |
| Data Flow | Transformations |
| Error Handling | Fallback strategies |
| Observability | Metrics and logging |
| Boundaries | Constraints and limits |
| Success Path | Happy path scenarios |

## pi Package Architecture

The pi package exports modular components:

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

// Orchestrator
export { WorkflowOrchestrator } from "./orchestrator/index.js";
export type { Phase, OrchestratorConfig } from "./orchestrator/index.js";
```

## LuBan Module Architecture

LuBan is modularized for maintainability:

```
src/tools/luban/
├── index.ts          # Tool registration (luban_execute_task, luban_execute_all)
├── types.ts         # LubanTask, TDDConfig, TaskResult interfaces
├── plan-parser.ts   # YAML parsing, dependency resolution
└── task-runner.ts   # TDD execution (RED→GREEN→REFACTOR) + TDD_GUIDE
```

### Key Design

- **`luban_execute_all`** internally calls **`luban_execute_task`**
- **DRY**: TDD logic lives in one place
- **TDD_GUIDE**: Built-in fallback guidance for exceptions
- **FileService**: All file operations use FileService (no direct node:fs)

## File Locking (LuBan)

- TTL: 30 minutes
- Auto-release on task complete
- Conflict notification: immediate

## Error Recovery

- Fail-fast with 3 retries
- Retry delay: 1000ms
- Max consecutive failures threshold: 5

## Development Checklist

**Before committing any changes:**

```bash
cd ~/Project/sages/pi
bun run typecheck    # Verify no TypeScript errors
bun test ./test      # Ensure all tests pass (430+ expected)
```

> **⚠️ Important**: Both checks must pass before committing. Run from the `pi/` subdirectory.

## Import Conventions

- **Use `@/` alias in `./pi/test/`**: When importing from `./pi/src/` in test files, use `from "@/..."` (e.g., `from "@/utils/draft-generator"`) instead of relative paths. Source files in `./pi/src/` should use relative paths.
- **Rationale**: The `tsconfig.json` defines `paths: { "@/*": ["./src/*"] }`. This ensures consistent, maintainable imports across the codebase, especially when files are moved or refactored.

## Security Practices

- **No direct node:fs**: All file operations use `FileService`
- **Path validation**: `validatePath()` prevents traversal attacks
- **No hardcoded models**: Use `getUserDefaultModel()` from `@/utils/model-helper.js`
- **No API keys**: Never hardcode credentials

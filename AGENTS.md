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
- **Tools** (simplified 3-tool surface): `fuxi_start`, `fuxi_design` (observe cycle: design → review → plan), `fuxi_end` (verdict routing)
- **Deprecated stubs** (kept for backward compat, return `isError` + hint): `fuxi_request`, `fuxi_plan`, `fuxi_recover`, `fuxi_get_status`, `fuxi_update_score`, `fuxi_brainstorm_recovery`
- **Focus**: Core intent, success paths, boundaries, constraints

### QiaoChui (巧倕) - The Sages Mechanist

- **Role**: Design review and task decomposition
- **Tools**: `qiaochui_review` (auto-writes `state.score` on observation), `qiaochui_decompose` (validates `score >= 80`)
- **Focus**: Feasibility, executable task breakdown, execution orchestration
- **Module**: `src/tools/qiaochui/` (index, review-service, decompose-service, types)

### LuBan (鲁班) - The Master Craftsman

- **Role**: Task execution with TDD methodology (RED → GREEN → REFACTOR)
- **Tools** (simplified 2-tool surface): `luban_execute_task` (observe cycle, auto-advance), `luban_run_batch` (planner — reads execution.yaml, returns ordered plan + file conflicts)
- **Deprecated stubs**: `luban_get_status` (status in every response), `luban_execute_batch` (renamed), `luban_execute_all` (removed)
- **Focus**: Implementation via **AFT-backed `read`/`write`/`edit`/`grep`** (replaces serena) + **codebase-memory** + **graphify** — LuBan validates outcomes, the LLM does the semantic work
- **Module**: `src/tools/luban/` (index, types, plan-parser, task-runner, scheduler, conflict-detector)
- **TDD Guide**: Built-in fallback guidance for exceptions

### GaoYao (皋陶) - The Supreme Judge

- **Role**: Quality audit and security review via semantic tools
- **Tools** (simplified 3-tool surface): `gaoyao_audit` (init/resume/reset/status), `gaoyao_observe` (file_read + finding, auto-advance), `gaoyao_finalize` (verdict)
- **Deprecated stubs**: 9 names including `gaoyao_init`, `gaoyao_record_file_read`, `gaoyao_record_finding`, `gaoyao_execute_phase`, `gaoyao_status`, `gaoyao_reset`, `gaoyao_review`, `gaoyao_quick_check`, `gaoyao_check_security`
- **Focus**: Code quality, security, test coverage, performance
- **Phase-guided auditing**: ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH (auto-advance)

## Workflow Phases

```
 Design (Fuxi) → Review (QiaoChui) → Plan (user approves /sages-plan) →
 Execute (LuBan) → Audit (GaoYao) → Archive
```

The simplified surface **auto-advances** on observation. The LLM calls each tool once per state transition; status comes back in the response.

### Phase 1: Design (Fuxi)
- `fuxi_start` initializes workflow + design sub-state
- `fuxi_design` observe cycle: design → review → plan
  - LLM writes `draft.md` (≥ 500 bytes, MDD Seven Planes) → `fuxi_design { observation: { phase: "design", draft_path } }` → advances to review
- Output: `.sages/workspace/draft.md`

### Phase 2: Review (QiaoChui)
- `qiaochui_review` with `observation: { score, notes? }` **auto-writes** `state.score` to `state.json`
- Pass threshold: **score >= 80** (APPROVED)
- LLM calls `qiaochui_decompose` to generate execution plan
- Output: `.sages/workspace/plan.md`, `execution.yaml`

### Phase 3: Execute (LuBan)
- `luban_run_batch` reads execution.yaml, returns ordered plan + file conflicts
- LLM iterates `luban_execute_task` per task: RED → GREEN → REFACTOR → complete (observe cycle, auto-advance)
- LLM uses **AFT-backed `read`/`write`/`edit`/`grep`** (via `@cortexkit/aft-pi`) + **codebase-memory** + **graphify** for actual implementation; LuBan validates
- Output: Implementation files

### Phase 4: Audit (GaoYao)
- `gaoyao_audit` initializes session, returns file enumeration
- `gaoyao_observe` accepts `file_read` or `finding`; auto-advances through ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH
- `gaoyao_finalize` produces verdict (`**Verdict**: PASS|NEEDS_CHANGES|REJECTED`) in audit.md
- Output: `.sages/workspace/audit.md`

### Phase 5: End / Archive
- `fuxi_end` with `observation: { verdict }`:
  - PASS → archives and returns `complete`
  - NEEDS_CHANGES → routes to implement (LuBan fixes)
  - REJECTED → routes to design (Fuxi redesign)
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

// Orchestrator (WorkflowOrchestrator removed in simplify-actions refactor — dead code)
```

## LuBan Module Architecture

LuBan is modularized for maintainability:

```
src/tools/luban/
├── index.ts          # Tool registration (luban_execute_task, luban_run_batch)
├── types.ts          # LubanTask, TDDConfig, TaskResult interfaces
├── plan-parser.ts    # YAML parsing, dependency resolution
├── task-runner.ts    # TDD verification (exit-code based runTests) + TDD_GUIDE
├── scheduler.ts      # Optimistic concurrency + auto-degrade serial on file conflicts
└── conflict-detector.ts  # Pure function for file conflict detection
```

### Key Design Decisions

- **KD-1**: `luban_execute_all` removed (no backward-compat alias)
- **KD-2**: optimistic concurrency with auto-serial degrade on intra-batch file conflicts
- **KD-3**: black-box contract — `content.text` = summary, `details` = full BatchResult for GaoYao audit
- **KD-4**: TDD optimization (real LLM implementation) deferred — current runner validates test outcomes, LLM does the semantic work via AFT-backed file ops + codebase-memory + graphify
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
bun test ./test      # Ensure all tests pass (417+ expected)
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

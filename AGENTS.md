# OpenCode Sages - Four Sages Agents

A multi-agent workflow system for [OpenCode](https://github.com/opencode-ai/opencode) and [pi](https://pi.dev), inspired by Chinese mythology.

## Architecture Overview

The system implements four specialized agents that collaborate through a structured workflow:

```
design (Fuxi) → review (QiaoChui) → approve (user) → execute (LuBan) → audit (GaoYao) → archive
```

## The Four Sages Agents

### Fuxi (伏羲) - The Architect ☰

- **Role**: Architectural design using Eight Trigrams methodology
- **Trigram**: ☰ Qian (Heaven)
- **Tools**: `fuxi_create_draft`, `fuxi_get_draft`
- **Focus**: Core intent, success paths, boundaries, constraints

### QiaoChui (巧倕) - The Sages Mechanist ☳

- **Role**: Design review and task decomposition
- **Trigram**: ☳ Zhen (Thunder)
- **Tools**: `qiaochui_review`, `qiaochui_decompose`
- **Focus**: Feasibility, executable task breakdown, execution orchestration

### LuBan (鲁班) - The Master Craftsman ☴

- **Role**: Task execution with TDD methodology
- **Trigram**: ☴ Xun (Wind)
- **Tools**: `luban_execute_task`, `luban_execute_all`, `luban_get_status`
- **Focus**: Implementation with RED → GREEN → REFACTOR, parallel execution

### GaoYao (皋陶) - The Supreme Judge ☲

- **Role**: Quality audit and security review
- **Trigram**: ☲ Li (Fire)
- **Tools**: `gaoyao_review`, `gaoyao_check_security`
- **Focus**: Code quality, security, test coverage, performance

## Workflow Phases

```
☰ Design → /fuxi-approve → ☳ Review (auto-proceed) → /fuxi-approve → 
☴ Execute → /fuxi-approve → ☲ Audit → ✅ Complete → /fuxi-archive
```

### Phase 1: Design (Fuxi) ☰
- Creates architectural draft using Eight Trigrams
- Output: `.sages/workspace/draft.md`
- **Requires**: User approval (`/fuxi-approve`)

### Phase 2: Review (QiaoChui) ☳
- Validates draft completeness and feasibility
- **Auto-proceeds** if draft is valid
- Creates execution plan
- Output: `.sages/workspace/plan.md`, `execution.yaml`, `tasks.json`
- **Requires**: User approval (`/fuxi-approve`)

### Phase 3: Execute (LuBan) ☴
- Executes tasks with real TDD (RED → GREEN → REFACTOR)
- Parallel execution (up to 3 tasks)
- Output: Implementation files

### Phase 4: Audit (GaoYao) ☲
- Quality audit and security scan
- Output: `.sages/workspace/audit.md`
- **Requires**: User approval (`/fuxi-approve`)

### Phase 5: Archive
- Saves complete workflow snapshot
- Output: `.sages/archive/{plan}/{timestamp}/`

## Workspace & Archive Structure

### Active Workflow (`.sages/workspace/`)

```
.sages/workspace/
├── draft.md          # Fuxi's design (Eight Trigrams)
├── plan.md           # Task plan (QiaoChui)
├── execution.yaml    # Execution configuration
├── tasks.json        # Task definitions with dependencies
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
        ├── tasks.json
        ├── state.json
        ├── audit.md
        └── summary.md    # Auto-generated overview
```

## State Management

- **Persistence**: File-based in `.sages/sessions/`
- **Checkpoints**: Auto-save on phase transitions
- **Recovery**: Restore from session or workspace files

## File Locking (LuBan)

- TTL: 30 minutes
- Auto-release on task complete
- Conflict notification: immediate

## Error Recovery

- Fail-fast with 3 retries
- Retry delay: 1000ms
- Max consecutive failures threshold: 5

## Project Structure

```
sages/
├── opencode/                    # OpenCode plugin
│   ├── src/
│   │   ├── agents/              # Agent personas
│   │   ├── engine/              # Core engine
│   │   ├── hooks/               # Session hooks
│   │   ├── tools/               # Tool definitions
│   │   ├── utils/               # Utilities
│   │   └── workflows/           # YAML orchestration
│   ├── test/                    # Tests
│   └── tool/                    # Bundled tools
│
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
    ├── sessions/                # State persistence
    └── archive/                  # Completed workflows
```

## Design Draft Format (Eight Trigrams)

Each design draft follows the Eight Trigrams structure:

| Trigram | Section | Purpose |
|---------|---------|---------|
| ☰ Qian | Core Intent | Why we're building this |
| ☷ Kun | Data Models | Entities and relationships |
| ☳ Zhen | Triggers | Events and conditions |
| ☴ Xun | Data Flow | Transformations |
| ☵ Kan | Error Handling | Fallback strategies |
| ☲ Li | Observability | Metrics and logging |
| ☶ Gen | Boundaries | Constraints and limits |
| ☱ Dui | Success Path | Happy path scenarios |

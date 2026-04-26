# OpenCode Sages - Four Sages Agents

A multi-agent workflow system for [OpenCode](https://github.com/opencode-ai/opencode), inspired by Chinese mythology.

## Architecture Overview

The system implements four specialized agents that collaborate through a structured workflow:

```
design (Fuxi) → review (QiaoChui) → approve (user) → execute (LuBan) → audit (GaoYao)
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
- **Tools**: `luban_execute_task`, `luban_get_status`, `luban_release_locks`
- **Focus**: Implementation, file locking for conflict prevention, per-task commits

### GaoYao (皋陶) - The Supreme Judge ☲

- **Role**: Quality audit and security review
- **Trigram**: ☲ Li (Fire)
- **Tools**: `gaoyao_review`, `gaoyao_check_security`
- **Focus**: Code quality, security, test coverage, performance

## Workflow States

```
initialized → draft_created → plan_approved → execution_in_progress → review_pending → completed
```

## Session Compaction Prevention

- Checkpoint interval: 5 minutes
- Max session age: 24 hours
- State persistence: file-based

## File Locking

- TTL: 30 minutes
- Auto-release on task complete
- Conflict notification: immediate
- Resolution: user decision

## Error Recovery

- Fail-fast with 3 retries
- Retry delay: 1000ms
- Max consecutive failures threshold: 5

## Directory Structure

```
scripts/
├── build-self-contained-tools.ts  # Bundles tools with esbuild
└── install.ts                     # Installs plugin to ~/.config/opencode/

src/
├── agents/           # Agent persona definitions
│   ├── fuxi.md
│   ├── qiaochui.md
│   ├── luban.md
│   └── gaoyao.md
├── engine/           # Core engine components
│   ├── workflow-engine.ts
│   ├── file-lock.ts
│   ├── state-manager.ts
│   ├── circuit-breaker.ts
│   └── task-dispatcher.ts
├── tools/            # OpenCode tool definitions
│   ├── fuxi-tools.ts
│   ├── qiaochui-tools.ts
│   ├── luban-tools.ts
│   ├── gaoyao-tools.ts
│   ├── workflow-tools.ts
│   └── sages-registry.ts
└── workflows/        # YAML orchestration
    └── four-sages.yaml

tool/                  # Bundled self-contained tools (output)
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

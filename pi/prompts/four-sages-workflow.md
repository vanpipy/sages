# Four Sages Workflow

## Recommended Pre-Step: Brainstorming

⚡ **HIGHLY RECOMMENDED** before starting any implementation:

```
/brainstorm [your request]
```

**When to brainstorm?**
- Creating new features
- Building components
- Adding functionality
- Modifying existing behavior
- Even for "simple" projects

**Why brainstorm first?**
- Explore intent and clarify requirements
- Propose 2-3 approaches with tradeoffs
- Get design approval before implementation
- Reduces wasted work on misaligned solutions

**Auto-Transition**: After design approval, Fuxi workflow starts automatically (if not already in one).

## Phases

| Phase | Mode | Allowed Files |
|-------|------|---------------|
| Design | read-only | `draft.md` |
| Review | read-only | `draft.md` (read) |
| Plan | read-only | `plan.md`, `execution.yaml` |
| Implement | writeable | all files |
| Review | read-only | `report-{time}.md` |

## Mode Indicators

Always show mode in system prompt:

```
**Design Mode** (Read-Only)
- Only modify: draft.md
- Read-only for all other files
- Use /fuxi-request to create draft
```

```
**Plan Mode** (Read-Only)
- Only modify: plan.md, execution.yaml
- Read-only for all other files
- Use /fuxi-plan to proceed (score > 80)
```

```
**Implement Mode** (Writeable)
- All files allowed
- Follow TDD: RED → GREEN → REFACTOR
- Use /luban-execute to run tasks
```

```
**Review Mode** (Read-Only)
- Only modify: report-{time}.md
- Use /gaoyao-review for audit
```

## Workflow Flow

```
/brainstorm → [Design Approved] → fuxi-start (auto)
    ↓
Design Phase (Fuxi)
    ↓ /fuxi-request
draft.md created
    ↓
Review Phase (QiaoChui)
    ↓ qiaochui-review (sets score)
score > 80?
    ↓ yes
Plan Phase (QiaoChui)
    ↓ qiaochui-decompose
plan.md + execution.yaml created
    ↓ /fuxi-plan
Implement Phase (LuBan)
    ↓ /luban-execute
Tasks executed (TDD)
    ↓
Audit Phase (GaoYao)
    ↓ gaoyao-review
report-{time}.md created
    ↓ verdict = PASS
fuxi-end → Archive
```

## Commands

| Command | Phase | Description |
|---------|-------|-------------|
| `/fuxi-start` | - | Start workflow, set design phase |
| `/fuxi-request` | design | Create draft.md |
| `/fuxi-plan <score>` | plan | Transition to plan (only if score > 80) |
| `/fuxi-recover` | - | Recover from state.json |
| `/fuxi-end` | - | End workflow, archive |
| `/fuxi-get-status` | - | View current status |
| `qiaochui-review` | review | Review draft, set score |
| `qiaochui-decompose` | plan | Create plan.md and execution.yaml |
| `luban-execute` | implement | Execute tasks with TDD |
| `gaoyao-review` | audit | Quality audit |

## Task Scope

All tasks in execution.yaml must include `files` field specifying exact files affected:

```yaml
tasks:
  - id: T1
    description: "Create user model"
    files:
      - "src/models/user.ts"
      - "src/models/index.ts"
    dependsOn: []
```

This ensures clear scope for LuBan's TDD execution.

## MDD Seven Planes

For design phase, analyze using 7 planes:

1. **Business** - Process × Rules
2. **Data** - Logic × State
3. **Control** - Strategy × Distribution
4. **Foundation** - Resource × Abstraction
5. **Observation** - Data × Analysis
6. **Security** - Identity × Permissions
7. **Evolution** - Time × Change

## TDD Cycle

```
RED → GREEN → REFACTOR
```

- **RED**: Write failing test first
- **GREEN**: Write minimal code to pass
- **REFACTOR**: Improve code structure

## File Structure

```
.sages/
├── workspace/
│   ├── draft.md        # MDD Design (Fuxi)
│   ├── plan.md         # Task plan (QiaoChui)
│   ├── execution.yaml  # Task config
│   ├── report-{time}.md # Audit report (GaoYao)
│   └── state.json      # Workflow state
└── archive/
    └── {plan}/
        └── {timestamp}/
            └── ... (archived files)
```

## State Management

state.json contains:
```json
{
  "phase": "design",
  "planName": "...",
  "request": "...",
  "score": 85,
  "createdAt": "...",
  "updatedAt": "..."
}
```

## Prohibited

- ❌ Modify files outside allowed list for current phase
- ❌ Skip TDD cycle in implement phase
- ❌ Decompose without review
- ❌ Plan if score ≤ 80
- ❌ Write code in read-only phases
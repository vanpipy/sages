---
description: Execute tasks with TDD
---

# LuBan (鲁班) - Engineer

## Mode Indicator

Show current mode in system prompt:

```
**Implement Mode** (Writeable)
- All files allowed
- Follow TDD: RED → GREEN → REFACTOR
- Use /luban-execute to run tasks
```

## Implement Mode Rules

- ✅ All files writeable
- ✅ Follow TDD cycle
- ❌ Must follow RED → GREEN → REFACTOR

## Commands

| Command | Description |
|---------|-------------|
| `/luban-execute-task` | Execute a single task using TDD |
| `/luban-execute-all` | Execute all tasks from execution.yaml |
| `/luban-get-status` | Get TDD execution status |

## TDD Cycle

```
RED → GREEN → REFACTOR
```

### RED (Write Test First)
1. Write failing test
2. Run test, confirm failure

### GREEN (Make Pass)
1. Write minimal code
2. Run test, confirm pass

### REFACTOR (Improve)
1. Clean code structure
2. Keep tests passing
3. Commit

## Task Execution

1. Load execution.yaml
2. Sort by dependencies
3. Execute in parallel (max 3)
4. Commit after each task

## Prohibited

- ❌ Skip RED phase
- ❌ Write code without tests
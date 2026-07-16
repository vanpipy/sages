---
description: Execute tasks with TDD observe cycle using semantic tools
---

# LuBan (鲁班) - Engineer

## Role

LuBan executes tasks via TDD (RED → GREEN → REFACTOR). The sage **does not write code itself** — it validates the LLM's work and auto-advances phases. The LLM uses **serena** / **codebase-memory** / **graphify** to do the actual implementation.

## Mode Indicator

Show current mode in system prompt:

```
**Implement Mode** (Writeable)
- All files allowed
- TDD: RED → GREEN → REFACTOR
- Use semantic tools (serena_*, codebase_memory_*, graphify_*) for the work
```

## Tools (Simplified Surface)

| Tool | Purpose |
|---|---|
| `luban_execute_task` | Single task with **observe cycle** (RED → GREEN → REFACTOR → complete). Auto-advances when phase requirements are met. |
| `luban_run_batch` | Planner — reads `execution.yaml`, returns ordered plan with file conflicts and topological layers. The LLM then iterates with `luban_execute_task`. |

`luban_get_status` is **deprecated**. Status is included in every `luban_execute_task` response.

## Observe Cycle (per task)

The same tool handles all three phases. Four calls per task:

```
Call 1: luban_execute_task { task_id, task_description, files, test_command }
        → RED contract { status: "in_progress", phase: "RED", intent, validation }

        (LLM uses serena_create_text_file to write the test, runs `bun test`, observes failure)

Call 2: luban_execute_task { task_id, observation: { phase: "RED", test_outcome: "fail" } }
        → re-runs test, validates, advances to GREEN

        (LLM uses serena_replace_symbol_body to implement, runs `bun test`, observes pass)

Call 3: luban_execute_task { task_id, observation: { phase: "GREEN", test_outcome: "pass" } }
        → validates, advances to REFACTOR

        (LLM uses serena_find_referencing_symbols + graphify_get_neighbors to check impact, refactors, runs `bun test`)

Call 4: luban_execute_task { task_id, observation: { phase: "REFACTOR", test_outcome: "pass" } }
        → returns { status: "complete", phases: ["RED","GREEN","REFACTOR"] }
```

## Semantic Tool Usage

LuBan does **not** write files or generate code. The LLM uses:

| Phase | Semantic tool | Purpose |
|---|---|---|
| RED | `serena_create_text_file`, `graphify_god_nodes` | Find existing test patterns; write the failing test |
| GREEN | `serena_find_symbol`, `serena_replace_symbol_body`, `codebase_memory_trace_path` | Find existing module shape; write minimal impl |
| REFACTOR | `serena_find_referencing_symbols`, `graphify_get_neighbors`, `codebase_memory_detect_changes` | Check blast radius; clean up without breaking behavior |

## Validation Contract

`luban_execute_task` validates observations by **re-running** the test command:

- RED + `test_outcome: "fail"` + actual exit code ≠ 0 → advance
- RED + `test_outcome: "pass"` → reject (RED must fail)
- GREEN + `test_outcome: "pass"` + actual exit code = 0 → advance
- GREEN + `test_outcome: "fail"` → reject (GREEN must pass)
- REFACTOR + `test_outcome: "pass"` + actual exit code = 0 → complete
- Wrong phase → reject (must submit observation matching current phase)

## Return Shape

Every response: `{status, intent, validation}`. No status tool.

## Scope Guard

The `deny_files` parameter (sourced from draft.md "Out of Scope") rejects matching source/test files. Use it via:

```ts
luban_execute_task {
  task_id, task_description, files, test_files, test_command,
  deny_files: ["src/forbidden.ts"]  // abort if files contain this
}
```

## TDD Fallback Guide (for TDD_GUIDE.formatError)

When the tool returns an error, the embedded `TDD_GUIDE.formatError(phase, error)` includes phase-specific guidance:

- **RED**: "Write a failing test FIRST…"
- **GREEN**: "Write MINIMAL implementation…"
- **REFACTOR**: "Improve code structure WITHOUT changing behavior…"

## Prohibited

- ❌ Skip RED phase (validation enforces it)
- ❌ Write code without tests (RED must produce a real failing test)
- ❌ Use template stubs (removed — LLM writes real implementations via semantic tools)
- ❌ Call deprecated `luban_get_status` (status is in every `luban_execute_task` response)

## Example Flow

```
> luban_run_batch
← { plan: { task_ids: ["T1","T2"], execution_order: ["T1","T2"], conflicts: [] } }

> luban_execute_task { task_id: "T1", task_description: "implement add(a,b)", files: ["src/math/add.ts"] }
← { status: "in_progress", phase: "RED", intent: "Write a failing test for: 'add(2,3) returns 5'...", validation: { test_command: "bun test src/math/add.test.ts", expected_outcome: "fail" } }

[LLM uses serena_create_text_file to write src/math/add.test.ts, runs `bun test`, sees failure]

> luban_execute_task { task_id: "T1", observation: { phase: "RED", test_outcome: "fail" } }
← { status: "in_progress", phase: "GREEN", auto_advanced: true, intent: "Make the test pass..." }

[LLM uses serena_replace_symbol_body to write the implementation, runs `bun test`, sees pass]

> luban_execute_task { task_id: "T1", observation: { phase: "GREEN", test_outcome: "pass" } }
← { status: "in_progress", phase: "REFACTOR", auto_advanced: true }

[LLM uses serena_find_referencing_symbols to check impact, refactors, runs `bun test`]

> luban_execute_task { task_id: "T1", observation: { phase: "REFACTOR", test_outcome: "pass" } }
← { status: "complete", phases: ["RED","GREEN","REFACTOR"] }
```
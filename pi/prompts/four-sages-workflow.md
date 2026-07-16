# Sages Workflow System (Simplified)

> Sages drives **10 sage tools** (3 Fuxi + 2 QiaoChui + 2 LuBan + 3 GaoYao) via **observe-cycle contracts**. Each tool returns `{status, intent, validation}`. Phases **auto-advance** on observation. No status tools, no separate phase-transition tools, no execution-order tools — the LLM does the semantic work via **serena** / **codebase-memory** / **graphify**.

## Quick Start

### 1. Initialize a new project

```bash
/sages-init
```

Creates `.sages/workflow.yaml` + `.sages/workflows/{four-sages,bugfix}.yaml` + `.sages/prompts/`.

### 2. Start a workflow

Just describe the intent in chat ("I want to do X" / "implement Y" / "fix Z"). The FSM auto-injects the design prompt and Fuxi starts.

### 3. What you (the human) actually do

| When | Action | Command |
|---|---|---|
| See review-passed notification | **Approve plan** | `/sages-plan` |
| First-time setup | **Init** | `/sages-init` |

### 4. Auto-advancing flow (sage tools handle phase transitions)

```
[fuxi_design observe cycle]
  LLM writes draft.md → fuxi_design {observation:{phase:"design",draft_path}}
    ↓ auto-advance
  qiaochui_review {observation:{score:N}} → auto-writes state.score
  fuxi_design {observation:{phase:"review",score:N}} → if N >= 80, advance
    ↓ auto-advance
  qiaochui_decompose → execution.yaml
    ↓
[luban_run_batch → plan + first task]
[luban_execute_task observe cycle per task]
  RED → GREEN → REFACTOR → complete (LLM does work via serena)
    ↓
[gaoyao_audit / gaoyao_observe / gaoyao_finalize]
  ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH → verdict
    ↓
[fuxi_end]
  PASS → archive / NEEDS_CHANGES → LuBan / REJECTED → Fuxi
```

## Recommended: brainstorming first

Before any implementation, run brainstorming to clarify requirements:

```
/brainstorm [your request]
```

(Refer to `.pi/agent/skills/brainstorming/SKILL.md`.)

## Available Workflows

| workflow | stages | when to use |
|---|---|---|
| `four-sages` | 8 stages (design → review → plan → decompose → execute → audit → archive → complete) | full feature development |
| `bugfix` | 5 stages (reproduce → fix → audit → archive → complete) | confirmed small-scope bug |

Future: `adr`, `refactor`, `docs`.

## Status (2026-07-16)

| Feature | Status |
|---|---|
| `.sages/workflow.yaml` (renamed from `pipeline.yaml`) | ✅ |
| Workflow YAML loading + typebox schema validation | ✅ |
| 7-stage auto-advance (tool_result events) | ✅ |
| `onVerdict` branching (PASS/REJECTED/NEEDS_CHANGES) | ✅ |
| `/sages-plan` manual gate | ✅ |
| `/sages-init` initialize | ✅ |
| QualityGate pre-check (hard/soft/advisory) | ✅ |
| **Simplified 10-tool sage surface** (auto-advance) | ✅ |
| **Semantic-tool integration** (serena / codebase-memory / graphify) | ✅ |
| Attestation hash chain | ❌ Stage 2+ |
| Autonomy tier | ❌ Stage 2+ |
| Deadlock detection (5 visits → terminate) | ✅ |
| Transition edge validation | ✅ |
| File-missing errors | ✅ |
| YAML error localization | ✅ (schema errors include instancePath) |
| Conformance fixtures (20+) | ❌ Stage 1.5+ |

## Feedback

If something goes wrong:
2. Inspect `.sages/workspace/state.json`
3. Inspect actual file contents (`draft.md` / `plan.md` / `execution.yaml` / `audit.md`)
4. Check pi session's `sages-fsm-transition` history
5. Open an issue or review `.sages/workflows/*.yaml` schema

## Why "simplify the actions" is the key

The simplify-actions principle says: when a sage tool has many sub-actions or multi-step flows, prefer collapsing them into **ONE tool with auto-advance + simple return shape** `{status, intent, validation}`. The LLM does the semantic work via **serena / codebase-memory / graphify**; the sage tool only validates outcomes. Status returned in every response — no separate status tool. Reset/discard is a flag, not a separate tool. Deprecated stubs return `isError` with redirect hints.
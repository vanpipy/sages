# Four Sages

Four role-based agents for [pi coding agent](https://pi.dev) — a multi-agent system for software engineering tasks where the LLM routes between roles via natural language.

## Overview

Named after four sage figures from Chinese mythology, each representing a stage of the software engineering lifecycle:

| Sage | Title | Responsibility | Output |
|------|-------|---------------|--------|
| **Fuxi (伏羲)** | Architect | MDD System Design | Design Document |
| **QiaoChui (巧倕)** | Expert | Technical Review | SPEC + Execution Plan |
| **LuBan (鲁班)** | Engineer | TDD Implementation | Source Code + Tests |
| **GaoYao (皋陶)** | Auditor | Quality Audit | Audit Report + Verdict |

## Installation

### Quick Install

**macOS / Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.ps1 | iex
```

**Windows (CMD):**
```batch
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.bat -o install.bat && install.bat
```

### Manual Install

**macOS / Linux / WSL:**
```bash
git clone https://github.com/vanpipy/sages.git
cd sages
./pi/scripts/install.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/vanpipy/sages.git
cd sages
.\pi\scripts\install.ps1
```

## Tools (Simplified Surface)

Each role exposes a small set of tools with observe-cycle semantics. The LLM calls each tool; the tool validates state and returns the next contract.

File operations (`read`/`write`/`edit`/`grep`/`bash`) are provided by `@cortexkit/aft-pi`, which is installed via `npx @cortexkit/aft@latest setup --harness pi` (see `pi/scripts/install.sh`). The four sage role tools orchestrate the workflow and don't re-register file tools.

### Fuxi (Design)

| Tool | Purpose |
|------|---------|
| `fuxi_design` | Observe cycle: `design → review → plan`. Auto-inits on first call. Validates `draft.md` (tier-aware byte floor + Scope), advances on `score ≥ 80`, marks plan complete. |

### QiaoChui (Review)

| Tool | Purpose |
|------|---------|
| `qiaochui_review` | Review `draft.md`. Without observation: returns heuristic hints + semantic-tool guidance. With `observation: { score }`: auto-writes the score to `state.json` and returns verdict (`APPROVED`/`REVISE`/`REJECTED`, threshold ≥ 80). |
| `qiaochui_decompose` | Generate `plan.md` + `execution.yaml` from approved draft. Reads `draft.md` Scope section to size the task list. |

### LuBan (Execute)

| Tool | Purpose |
|------|---------|
| `luban_execute_task` | Single task with observe cycle `RED → GREEN → REFACTOR → complete`. Re-runs the test command to validate each phase. LLM does the actual coding via `read`/`write`/`edit`/`grep` (AFT-backed), `codebase_memory_*` (graph queries), and `graphify_*` (knowledge graph). LuBan only validates outcomes. |

### GaoYao (Audit)

| Tool | Purpose |
|------|---------|
| `gaoyao_audit` | Initialize / reset / query the audit session. Auto-advances through `ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH → FINAL` as phase requirements are met. |
| `gaoyao_observe` | Record a `file_read` or `finding` observation. Auto-advances when the current phase's requirement is satisfied (e.g., ≥ 5 file reads to exit ENUMERATE; ≥ 1 INK finding to enter NOSE). |
| `gaoyao_finalize` | Write `audit.md` with the final verdict (`PASS`/`NEEDS_CHANGES`/`REJECTED`). Called when the session is in the FINAL phase. |

## Role Interaction Flow

The LLM drives the flow by calling each role's tools in sequence. There is no orchestrator runtime — the LLM is the router. Each tool returns its current phase, intent, and validation, so the LLM always knows what to do next.

```
              ┌──────────────────┐
              │   User Request   │
              └────────┬─────────┘
                       │
                ┌──────▼──────┐
                │ Fuxi Design │  fuxi_design (observe cycle)
                │ 7 Planes    │  design → review → plan
                └──────┬──────┘
                       │
                ┌──────▼──────┐
                │QiaoChui     │  qiaochui_review (writes score)
                │Review+Plan  │  qiaochui_decompose (execution.yaml)
                └──────┬──────┘
                       │
                ┌──────▼──────┐
                │LuBan        │  luban_execute_task per task
                │TDD Cycle    │  RED → GREEN → REFACTOR
                └──────┬──────┘
                       │
                ┌──────▼──────┐
                │GaoYao       │  gaoyao_audit / observe / finalize
                │Audit        │  ENUMERATE → … → DEATH → FINAL
                └──────┬──────┘
                       │
                ┌──────▼──────┐
                │ ✅ Verdict   │  PASS / NEEDS_CHANGES / REJECTED
                └─────────────┘
```

### Phase Progression

```
design → review → plan → execute → audit
```

Each phase is owned by one role. There are no manual gates — the LLM progresses by reading the previous tool's response and calling the next role's tool.

## MDD Design Method

Four Sages uses **Multi-Dimensional Design (MDD)** for system architecture:

### Seven Planes

| Plane | Elements | Focus |
|-------|----------|-------|
| **Business** | Process × Rules | Business value delivery |
| **Data** | Logic × State | Data processing |
| **Control** | Strategy × Distribution | Decision execution |
| **Foundation** | Resource × Abstraction | Infrastructure |
| **Observation** | Data × Analysis | Monitoring |
| **Security** | Identity × Permissions | Access control |
| **Evolution** | Time × Change | Versioning & migration |

### Scope & Tier

For tasks that don't need all 7 planes, declare a Scope section in `draft.md`:

```markdown
## Scope
- Tier: trivial | simple | standard
- In scope: [Foundation, Business]
- Out of scope (justified): Data, Control, Observation, Security, Evolution
```

| Tier | In-scope planes | Min draft bytes |
|------|-----------------|-----------------|
| `trivial` | 1 plane | 100 |
| `simple`  | 2-3 planes | 250 |
| `standard` | 4+ planes | 500 (default) |

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
const guidance = TDD_GUIDE.getPhaseGuidance("RED");
// Returns: How to write failing tests first

const errorMsg = "Unexpected error";
const formatted = TDD_GUIDE.formatError("GREEN", errorMsg);
// Returns: Error + GREEN phase guidance
```

## Execution Plan Configuration

`qiaochui_decompose` writes `execution.yaml` based on the draft:

```yaml
# Execution Plan
name: user-management-api

settings:
  maxParallel: 3        # Max parallel iterations (used by LLM)
  useSubagent: false    # Reserved for future subagent mode
  maxRetry: 1           # Retry budget per task
  autoCommit: false     # Commit on task complete

tasks:
  - id: T1
    description: "Setup database schema"
    priority: 1
    dependsOn: []

  - id: T2
    description: "Create user model"
    priority: 1
    dependsOn: [T1]
```

The LLM reads this file via `read` (AFT-backed) and iterates `luban_execute_task` per task in topological order.

## Audit Phases (GaoYao)

Phase-guided auditing with penalty categories:

| Phase | Category | Focus | Penalty |
|-------|----------|-------|---------|
| ENUMERATE | 列刑 | File enumeration | (gate) |
| INK | 墨刑 | Code style | Minor |
| NOSE | 劓刑 | Naming/docs | Minor |
| FOOT | 剕刑 | Architecture | Major |
| CASTRATION | 宫刑 | Security | Critical |
| DEATH | 大辟 | Critical defect | Fail |

## File Structure

```
sages/pi/
├── src/
│   ├── tools/               # Modular tools (one folder per role)
│   │   ├── orchestrator/    # Orchestrator: goal + DAG + dispatch + audit
│   │   └── brainstorming/   # Brainstorming: design exploration
│   ├── services/            # FileService
│   └── utils/               # (utility helpers)
├── skills/                  # Per-tool SKILL.md (orchestrator + brainstorming)
├── templates/               # SYSTEM.md template
├── scripts/                 # install.sh / install.ps1 / install.bat
├── test/                    # Unit tests (uses @/ alias)
└── README.md
```

Runtime outputs are persisted to `.sages/workspace/` (created automatically on first tool call):

```
.sages/workspace/
├── draft.md               # Fuxi design draft
├── plan.md                # QiaoChui decomposition plan
├── execution.yaml         # Task list
├── audit.md               # GaoYao audit report
├── state.json             # Review score + workflow state
├── .fuxi-design-state.json
├── .luban-task-state.json
└── .gaoyao-session.json
```

## Security Practices

| Practice | Implementation |
|----------|---------------|
| No direct node:fs | Use `FileService` from `@/services/file-service.js` |
| Path validation | `validatePath()` prevents traversal attacks |
| No hardcoded models | Use `getUserDefaultModel()` from `@/utils/model-helper.js` |
| No API keys | Configuration via `~/.pi/agent/settings.json` |

## Development

```bash
# Type-check (run before committing)
bun run typecheck

# Run tests
bun test ./test
```

> **⚠️ Important**: Both checks must pass before committing.

## Examples

```
You: design a user-management API
pi: [Fuxi] Initializing design phase. Write draft.md to .sages/workspace/draft.md
    using MDD Seven Planes (≥ 500 bytes for standard tier).

You: [write draft.md, then call fuxi_design with observation]
pi: [Fuxi] Draft accepted (625 bytes). Advanced to review.
    Run qiaochui_review to assess the draft.

You: [call qiaochui_review with observation {score: 85}]
pi: [QiaoChui] Score 85 → APPROVED. Plan can start.

You: [call fuxi_design with observation {phase:"review", score:85}]
pi: [Fuxi] Advanced to plan. Run qiaochui_decompose to generate execution.yaml.

You: [call qiaochui_decompose]
pi: [QiaoChui] Wrote plan.md and execution.yaml (4 tasks).

You: [call fuxi_design with observation {phase:"plan"}]
pi: [Fuxi] Design complete. Iterate luban_execute_task per task in execution.yaml.

You: [iterate luban_execute_task for T1, T2, T3, T4]
pi: [LuBan] T1: RED → GREEN → REFACTOR ✓
    [LuBan] T2: RED → GREEN → REFACTOR ✓
    [LuBan] T3: RED → GREEN → REFACTOR ✓
    [LuBan] T4: RED → GREEN → REFACTOR ✓

You: [call gaoyao_audit, then gaoyao_observe with file_read + finding, then gaoyao_finalize]
pi: [GaoYao] Audit complete: ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH → FINAL
    Verdict: PASS (95%)
```

## License

MIT
---
description: Architectural design with MDD Seven Planes (single-tool surface with auto-init)
---

# Fuxi (伏羲) - Architect

## Role

Fuxi manages the design phase: create draft.md, get it reviewed, transition to plan. **Single-tool surface** (`fuxi_design`) with auto-init on first call and auto-advance on observation. The LLM uses **serena** / **graphify** to write the draft; Fuxi only validates.

## Mode Indicator

```
**Design Mode** (Read-Only, except draft.md)
- Only modify: draft.md
- Use fuxi_design (observe cycle) to advance phases
```

## Tools (Simplified Surface)

| Tool | Purpose |
|---|---|
| `fuxi_design` | Observe cycle through `design → review → plan`. First call auto-inits the design sub-phase and returns the contract. Subsequent calls with `observation` validate and auto-advance. |

The 5 deprecated stubs (`fuxi_request`, `fuxi_plan`, `fuxi_recover`, `fuxi_get_status`, `fuxi_update_score`) return `isError` with redirect hints to `fuxi_design`. **Do not call them.**

## fuxi_design Observe Cycle

Three sub-phases, auto-advance on observation:

```
Call 1: fuxi_design {}
        → design contract { phase: "design", intent: "...", validation: { file: "draft.md", min_size: 100|250|500 } }
        (design sub-state auto-created on first call)

        (LLM uses serena_read_file + graphify_query to understand project context,
         then writes draft.md — recommended: include ## Scope section declaring Tier + in-scope planes)

Call 2: fuxi_design { observation: { phase: "design", draft_path: "draft.md" } }
        → parses Scope section (if present) → tier-aware size validation → advances to review

        (LLM runs qiaochui_review which auto-writes state.score; heuristic scores only in-scope planes)

Call 3: fuxi_design { observation: { phase: "review", score: 85 } }
        → validates score >= 80 → advances to plan

        (LLM runs qiaochui_decompose to generate execution.yaml)

Call 4: fuxi_design { observation: { phase: "plan" } }
        → status: "complete", next: luban_execute_task
```

The score threshold is **≥ 80** (not `> 80`).

## Per-Phase Validation

| Phase | Validation |
|---|---|
| `design` | `draft.md` exists + ≥ tier-specific byte floor (see Scope/Tier system below). Without Scope: legacy 500 bytes for all-7-plane coverage. |
| `review` | `score >= 80` |
| `plan` | acks; next stage is iterating `luban_execute_task` per task in execution.yaml |

## Scope & Tier System (recommended)

Fuxi supports **scope-driven design**: the agent declares which MDD planes are in scope for the task, and Fuxi/QiaoChui only score those planes. This addresses the "MDD-rigidity" failure mode where agents pad all 7 planes even when only 1-2 matter.

### Tier Bands

| Tier | In-scope planes | Min draft bytes |
|---|---|---|
| `trivial` | 1 plane (e.g., a rename, a single config flag) | 100 |
| `simple`  | 2-3 planes (e.g., a small refactor, a bug fix) | 250 |
| `standard` | 4+ planes (default — full MDD treatment) | 500 |

### Scope Section Format

Include this block at the top of `draft.md`:

```markdown
## Scope
- Tier: trivial | simple | standard
- In scope: [Foundation, Business, Evolution]
- Out of scope (justified): Data (no schema change), Control (no flow change),
  Observation (no new metrics), Security (no auth change)
```

### Behavior

- **Tier drives min draft size**: a trivial-tier draft of 100 bytes passes the gate; a standard-tier draft needs 500.
- **Out-of-scope planes are NOT scored**: `performDeepReview` skips them in `avgDepth`, `feasibleCount`, and critical-plane blocker checks.
- **Tier/plane-count mismatch is a soft warning**, not a rejection (e.g., declaring `trivial` with 3 planes surfaces a warning but advances).
- **Missing Scope section** → falls back to legacy behavior (500 bytes, all 7 planes scored).
- **The QiaoChui rubric gains a `scope_justification` dimension** when Scope is present — the reviewer judges whether the scope choice fits the task.

## MDD Seven Planes

The Seven Planes remain the canonical model. With Scope & Tier:

- **Standard tier**: draft covers all 7 planes (legacy behavior)
- **Simple/trivial tier**: draft covers ONLY the declared in-scope planes; out-of-scope ones are exempt

1. **Business Plane** - Process × Rules
2. **Data Plane** - Logic × State
3. **Control Plane** - Strategy × Distribution
4. **Foundation Plane** - Resource × Abstraction
5. **Observation Plane** - Data × Analysis
6. **Security Plane** - Identity × Permissions
7. **Evolution Plane** - Time × Change

## Semantic Tool Usage

| Phase | Tool | Purpose |
|---|---|---|
| design | `graphify_god_nodes`, `serena_read_file` | Understand existing project shape before writing |
| design | `serena_create_text_file` | Write the draft.md |
| review | `qiaochui_review` (separate tool) | Get the score; it auto-writes |
| plan | `qiaochui_decompose` (separate tool) | Generate execution.yaml |

## State Files

- `.sages/workspace/.fuxi-design-state.json` — design sub-phase state (design → review → plan), auto-created on first call
- `.sages/workspace/draft.md` — the design draft

## Prohibited

- ❌ Call deprecated `fuxi_request`, `fuxi_plan`, `fuxi_recover`, `fuxi_get_status`, `fuxi_update_score` (they all return `isError` with redirect hints)
- ❌ Submit score < 80 in review observation

## Example Flow

```
> fuxi_design {}
← { status: "in_progress", phase: "design", workflow_id: "sages-...", intent: "Create draft.md using MDD Seven Planes...", validation: { file: "draft.md", min_size: 500 } }

[LLM uses graphify_god_nodes + serena_read_file to understand project, then writes draft.md covering all 7 planes, ≥ 500 bytes]

> fuxi_design { observation: { phase: "design", draft_path: "draft.md" } }
← { status: "in_progress", phase: "review", auto_advanced: true, intent: "Get a review score for draft.md..." }

[LLM runs qiaochui_review with observation {score: 85}, which auto-writes state.score]

> fuxi_design { observation: { phase: "review", score: 85 } }
← { status: "in_progress", phase: "plan", auto_advanced: true, score: 85 }

[LLM runs qiaochui_decompose to generate execution.yaml]

> fuxi_design { observation: { phase: "plan" } }
← { status: "complete", summary: "Design phase complete. Iterate through tasks using luban_execute_task." }

[LLM reads execution.yaml via semantic tools, then iterates luban_execute_task per task]
```
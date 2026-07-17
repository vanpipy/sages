---
description: Architectural design with MDD Seven Planes (simplified 3-tool surface)
---

# Fuxi (伏羲) - Architect

## Role

Fuxi manages the design phase: create draft.md, get it reviewed, transition to plan. **Simplified 3-tool surface** with auto-advance on observation. The LLM uses **serena** / **graphify** to write the draft; Fuxi only validates.

## Mode Indicator

```
**Design Mode** (Read-Only, except draft.md)
- Only modify: draft.md
- Use fuxi_design (observe cycle) to advance phases
```

## Tools (Simplified Surface)

| Tool | Purpose |
|---|---|
| `fuxi_start` | Initialize workflow (creates `state.json` + design sub-state). Returns design contract. |
| `fuxi_design` | Observe cycle through `design → review → plan`. First call returns contract; subsequent calls with `observation` validate and auto-advance. |
| `fuxi_end` | End workflow based on audit verdict. `observation: { verdict }` routes PASS→archive, NEEDS_CHANGES→implement, REJECTED→design. |

The 6 deprecated stubs (`fuxi_request`, `fuxi_plan`, `fuxi_recover`, `fuxi_get_status`, `fuxi_update_score`, `fuxi_brainstorm_recovery`) return `isError` with redirect hints. **Do not call them.**

## fuxi_design Observe Cycle

Three sub-phases, auto-advance on observation:

```
Call 1: fuxi_design {}
        → design contract { phase: "design", intent: "...", validation: { file: "draft.md", min_size: 100|250|500 } }

        (LLM uses serena_read_file + graphify_query to understand project context,
         then writes draft.md — recommended: include ## Scope section declaring Tier + in-scope planes)

Call 2: fuxi_design { observation: { phase: "design", draft_path: "draft.md" } }
        → parses Scope section (if present) → tier-aware size validation → advances to review

        (LLM runs qiaochui_review which auto-writes state.score; heuristic scores only in-scope planes)

Call 3: fuxi_design { observation: { phase: "review", score: 85 } }
        → validates score >= 80 → persists score → advances to plan

        (LLM runs qiaochui_decompose to generate execution.yaml)

Call 4: fuxi_design { observation: { phase: "plan", approved: true } }
        → status: "complete", next: luban_run_batch
```

The score threshold is **≥ 80** (not `> 80`). Off-by-one fixed.

## Per-Phase Validation

| Phase | Validation |
|---|---|
| `design` | `draft.md` exists + ≥ tier-specific byte floor (see Scope/Tier system below). Without Scope: legacy 500 bytes for all-7-plane coverage. |
| `review` | `score >= 80` |
| `plan` | acks; next stage is `luban_run_batch` |

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

## fuxi_end Verdict Routing

`observation: { verdict: "PASS" \| "NEEDS_CHANGES" \| "REJECTED" }`:

| Verdict | Phase after | What to do next |
|---|---|---|
| **PASS** | `complete` | Archive. Workflow ends. |
| **NEEDS_CHANGES** | `implement` | Run `luban_run_batch` to plan remediation, then iterate via `luban_execute_task` |
| **REJECTED** | `design` | Re-run `fuxi_design` from scratch (design sub-state cleared) |

After 3× `NEEDS_CHANGES`, the tool auto-escalates to design phase.

Without observation, `fuxi_end` validates that `audit.md` exists and surfaces the verdict so the LLM knows what to pass.

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

- `.sages/workspace/state.json` — main workflow state (planName, request, score, phase)
- `.sages/workspace/.fuxi-design-state.json` — design sub-phase state (design → review → plan)
- `.sages/workspace/draft.md` — the design draft

## Prohibited

- ❌ Call deprecated `fuxi_request`, `fuxi_plan`, `fuxi_recover`, `fuxi_get_status`, `fuxi_update_score`, `fuxi_brainstorm_recovery` (they all return `isError` with redirect hints)
- ❌ Submit score < 80 in review observation
- ❌ Submit `fuxi_end` observation without first running `gaoyao_finalize` (no audit verdict)

## Example Flow

```
> fuxi_start { plan_name: "user-mgmt", request: "Build user CRUD API" }
← { status: "in_progress", phase: "design", workflow_id: "sages-...", plan_name: "user-mgmt", intent: "Create draft.md...", validation: { file: "draft.md", min_size: 500 } }

> fuxi_design {}
← { status: "in_progress", phase: "design", intent: "Create draft.md using MDD Seven Planes...", validation: { file: "draft.md", min_size: 500 } }

[LLM uses graphify_god_nodes + serena_read_file to understand project, then writes draft.md covering all 7 planes, ≥ 500 bytes]

> fuxi_design { observation: { phase: "design", draft_path: "draft.md" } }
← { status: "in_progress", phase: "review", auto_advanced: true, intent: "Get a review score for draft.md..." }

[LLM runs qiaochui_review with observation {score: 85}, which auto-writes state.score]

> fuxi_design { observation: { phase: "review", score: 85 } }
← { status: "in_progress", phase: "plan", auto_advanced: true, score: 85 }

[LLM runs qiaochui_decompose to generate execution.yaml]

> fuxi_design { observation: { phase: "plan", approved: true } }
← { status: "complete", summary: "Design phase complete. Run luban_run_batch..." }

[After LuBan + GaoYao complete]

> fuxi_end { observation: { verdict: "PASS" } }
← { status: "complete", archive_path: ".sages/archive/user-mgmt/..." }
```
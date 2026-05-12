---
description: Create MDD design drafts and manage workflow lifecycle
---

# Fuxi (伏羲) - Architect

## Mode Indicator

Always show current mode in system prompt:

```
**Design Mode** (Read-Only)
- Only modify: draft.md
- Read-only access to all other files
- Use /fuxi-request to create draft
```

## Commands

| Command | Description |
|---------|-------------|
| `/fuxi-start` | Start workflow, set design phase |
| `/fuxi-request` | Create draft.md |
| `/fuxi-plan <score>` | Transition to plan (only if score > 80) |
| `/fuxi-recover` | Recover from state.json |
| `/fuxi-end` | End workflow based on audit verdict |
| `/fuxi-get-status` | View current status |
| `/fuxi-brainstorm-recovery` | Brainstorm fixes when audit fails |

## Design Mode Rules

- ✅ Only modify `draft.md`
- ❌ Read-only for all other files
- ❌ No code writing in design phase

## Workflow Lifecycle

```
Design → Plan → Execute → Audit → [Verdict Handling]
                                    ↓
                         ┌──────────┼──────────┐
                         ↓          ↓          ↓
                       PASS     NEEDS_CHANGES  REJECTED
                         ↓          ↓          ↓
                    [Complete]   [Brainstorm]  [Brainstorm]
                                    ↓          ↓
                                (3 tries)   (back to)
                                   ↓         Fuxi
                              [Execute]   [Design]
```

## fuxi_end Verdict Handling

When calling `/fuxi-end`, the workflow checks audit verdict:

| Verdict | Score | Action |
|---------|-------|--------|
| **PASS** | ≥70 | Archive and complete |
| **NEEDS_CHANGES** | 50-69 | Return to implement (LuBan fixes) |
| **REJECTED** | <50 | Return to design (Fuxi redesign) |

### Special Cases

- After 3x `NEEDS_CHANGES` → auto-escalate to design phase
- Use `--force` to archive regardless of verdict

### State Tracking

```json
{
  "phase": "audit",
  "planName": "...",
  "auditVerdict": "PASS|NEEDS_CHANGES|REJECTED",
  "auditScore": 85,
  "auditAttempts": 1
}
```

## Brainstorm Recovery

When audit fails, use `/fuxi-brainstorm-recovery` to update the plan and re-execute:

### Purpose
- **Analyze** audit findings from GaoYao
- **Update** plan.md with improved approaches
- **Modify** execution.yaml with new/modified tasks
- **Wake** LuBan to re-execute with updated plan

### Focus Options

| Focus | Use When |
|-------|----------|
| `all` | General improvement |
| `critical` | Only critical/major issues |
| `security` | Security vulnerabilities found |
| `architecture` | Design/structure problems |
| `style` | Code style/naming issues |

### Parameters

| Parameter | Description |
|-----------|-------------|
| `--focus` | Which findings to address |
| `--dry-run` | Preview without updating files |

### What It Does

1. Reads audit.md and extracts findings
2. Generates improvement notes for plan.md
3. Creates new tasks in execution.yaml
4. Sets phase to `implement`
5. Wakes LuBan to continue

### After Brainstorming

1. Check updated plan.md with recovery notes
2. Check execution.yaml for new tasks
3. Use `/luban-execute-all` to re-execute
4. Use `/gaoyao-review` to verify fixes
5. Use `/fuxi-end` to check verdict

### Example Flow

```
Audit verdict: NEEDS_CHANGES (65%)
↓
/fuxi-brainstorm-recovery --focus=security
↓
[Updates plan.md and execution.yaml]
↓
Phase set to: implement
↓
/luban-execute-all
↓
[Re-executes with new tasks]
↓
/gaoyao-review
↓
/fuxi-end
```

### Dry Run

```bash
/fuxi-brainstorm-recovery --focus=all --dry-run
# Preview changes without applying
```

## MDD Seven Planes

Analyze request using 7 planes:

1. **Business Plane** - Process × Rules
2. **Data Plane** - Logic × State
3. **Control Plane** - Strategy × Distribution
4. **Foundation Plane** - Resource × Abstraction
5. **Observation Plane** - Data × Analysis
6. **Security Plane** - Identity × Permissions
7. **Evolution Plane** - Time × Change

## Draft Content

Create `draft.md` with:
- Overview (core intent, boundaries)
- Each plane analysis
- Cross-plane dependencies
- Key decisions
- Open questions
- Directory and files structure

## State

```json
{
  "phase": "design",
  "planName": "...",
  "request": "..."
}
```

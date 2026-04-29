# Four Sages Workflow

## Philosophy

Named after four sage figures from Chinese mythology, representing the complete software engineering lifecycle from **multi-dimensional system design** to **quality assurance**.

## The Four Sages

| Sage | Title | Responsibility | Output |
|------|-------|---------------|--------|
| **Fuxi (伏羲)** | Architect ☰ | MDD System Design (7 Planes) | Design Document |
| **QiaoChui (巧倕)** | Expert ☳ | Technical review & decomposition | SPEC + Execution Plan |
| **LuBan (鲁班)** | Engineer ☴ | TDD implementation | Source code + Tests |
| **GaoYao (皋陶)** | Auditor ☲ | Quality audit & security | Audit Report + Verdict |

## MDD Seven Planes (Fuxi's Framework)

| Plane | Elements | Focus |
|-------|----------|--------|
| **Business** | Process × Rules | Business value delivery |
| **Data** | Logic × State | Data processing |
| **Control** | Strategy × Distribution | Decision execution |
| **Foundation** | Resource × Abstraction | Infrastructure |
| **Observation** | Data × Analysis | Monitoring |
| **Security** | Identity × Permissions | Access control |
| **Evolution** | Time × Change | Versioning & migration |

## Mythology Flow

```
Fuxi ──→ Creates systematic observation (MDD)
  ↓
QiaoChui ──→ Creates technical specifications
  ↓
LuBan ──→ Creates working implementation
  ↓
GaoYao ──→ Creates quality assurance
```

## Workflow Diagram

```
                    ┌─────────────┐
                    │ User Request│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☰ Fuxi      │
                    │ MDD Design  │
                    │ 7 Planes    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │/fuxi-approve│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☳ QiaoChui  │
                    │ Review      │
                    │ Decompose   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │/fuxi-approve│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☴ LuBan     │
                    │ Execute     │
                    │ TDD        │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │/fuxi-approve│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ ☲ GaoYao    │
                    │ Audit       │
                    │ Security    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │/fuxi-archive│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   🎉 Complete│
                    └─────────────┘
```

## Phase Details

### Phase 1: Design (Fuxi) ☰

**Framework**: Multi-Dimensional Design (MDD)

**Output**:
- `draft.md` - MDD Design Document

**Content**:
```markdown
# System Design: {Name}

## Overview
- Core Intent: {purpose}
- System Boundary: {scope}

## Plane Analysis
### Business Plane (Process × Rules)
### Data Plane (Logic × State)
### Control Plane (Strategy × Distribution)
### Foundation Plane (Resource × Abstraction)
### Observation Plane (Data × Analysis)
### Security Plane (Identity × Permissions)
### Evolution Plane (Time × Change)

## Cross-Plane Dependencies
## Key Decisions
## Open Questions
```

### When to Use Each Plane

| Request Type | Key Planes |
|-------------|-----------|
| Business App | Business, Data, Control |
| Data Platform | Data, Observation, Evolution |
| Security App | Security, Control, Foundation |
| Microservices | All planes important |

### Plane Flexibility

> Not every system needs all 7 planes. Use the planes relevant to your system:
> - **Required**: Business, Data, Foundation
> - **Often Needed**: Control, Security
> - **Situational**: Observation, Evolution

### Phase 2: Review (QiaoChui) ☳

**Responsibility**: Technical feasibility, task decomposition

**Output**:
- `plan.md` - Task plan
- `execution.yaml` - Execution config
- `tasks.json` - Task list

**Auto Behavior**:
- Review design feasibility
- Generate dependency graph
- Create execution plan

### Phase 3: Execute (LuBan) ☴

**Responsibility**: TDD implementation, craftsmanship

**TDD Iron Law**:
```
RED → GREEN → REFACTOR
```

**Output**:
- Source code files
- Test code
- Commit records

**Features**:
- Parallel execution (max 3 tasks)
- File locks to prevent conflicts
- Per-task commits

### Phase 4: Audit (GaoYao) ☲

**Responsibility**: Quality audit, security scan

**Audit Types**:
| Type | Checks |
|------|--------|
| Code Quality | Complexity, readability |
| Security | Injection, auth, authz |
| Test | Coverage, edge cases |
| Performance | Algorithm complexity |
| Documentation | README, comments |

**Verdicts**:
- PASS → Archive & deploy
- NEEDS_CHANGES → Return for fixes
- REJECTED → Redesign from architecture

### Phase 5: Archive

**Output**:
- `.sages/archive/{plan}/{timestamp}/`

**Archived Content**:
- All phase outputs
- State snapshots
- Audit reports
- Execution summary

## Command Reference

| Command | Description |
|---------|-------------|
| `/fuxi <request>` | Start workflow with MDD design |
| `/fuxi-approve` | Approve current phase |
| `/fuxi-reject` | Reject and stop |
| `/fuxi-status` | View status |
| `/fuxi-execute` | Execute tasks |
| `/fuxi-archive` | Archive completed workflow |
| `/fuxi-archives` | List archives |
| `/fuxi-restore` | Restore an archive |

## File Structure

```
.sages/
├── workspace/           # Current workflow
│   ├── draft.md        # MDD Design (Fuxi)
│   ├── plan.md         # Task plan (QiaoChui)
│   ├── execution.yaml # Execution config
│   ├── tasks.json      # Task list
│   ├── audit.md        # Audit report (GaoYao)
│   └── state.json      # State
│
└── archive/            # Archived workflows
    └── {plan}/
        └── {timestamp}/
            ├── draft.md
            ├── plan.md
            ├── tasks.json
            ├── audit.md
            ├── state.json
            └── summary.md
```

## Four Sages Spirit

> **Fuxi**: Creating symbols to observe systems from multiple dimensions
> 
> **QiaoChui**: Measuring with precision, crafting with standards
> 
> **LuBan**: Building with care, testing with discipline
> 
> **GaoYao**: Judging with facts, guarding with standards

---

*Four Sages working together, none can be lacking; creating excellent software through systematic design*

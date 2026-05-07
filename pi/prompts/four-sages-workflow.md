# Four Sages Workflow

## Philosophy

Named after four sage figures from Chinese mythology, representing the complete software engineering lifecycle from **Multi-Dimensional Design** to **quality assurance**.

## The Four Sages

| Sage | Title | Responsibility | Output |
|------|-------|---------------|--------|
| **Fuxi (伏羲)** | Architect ☰ | MDD System Design (7 Planes) | Design Document |
| **QiaoChui (巧倕)** | Expert ☳ | Technical review & decomposition | SPEC + Execution Plan |
| **LuBan (鲁班)** | Engineer ☴ | TDD implementation | Source code + Tests |
| **GaoYao (皋陶)** | Auditor ☲ | Quality audit & security | Audit Report + Verdict |

## MDD Seven Planes (Fuxi's Framework)

| Plane | Elements | Focus |
|-------|----------|-------|
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
- (no longer uses `tasks.json`)

**Deep Review Analysis**:
| Metric | Description |
|--------|-------------|
| Content Depth | 0-100 score per plane |
| Risks | Identified per plane |
| Questions | Unanswered review questions |
| Complexity | Low/Medium/High/Very-High |
| Est. Hours | Time estimation |
| Blockers | Critical issues |

**Review Verdict**:
- `APPROVED` → Proceed to decomposition
- `REVISE` → Expand incomplete planes
- `REJECTED` → Redesign required

**Auto Behavior**:
- Analyze content depth per plane
- Identify risks and blockers
- Detect cross-plane dependencies
- Estimate implementation complexity

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

## Fuxi Commands

Start new workflow:
- `/fuxi <request>` - Start workflow with MDD design

Design phase:
- `/fuxi-create-draft <request>` - Create MDD design draft
- `/fuxi-get-draft` - View current draft
- `/fuxi-approve` - Approve draft → review

Review phase:
- `/qiaochui-review` - Review draft feasibility
- `/qiaochui-decompose` - Create task plan
- `/fuxi-approve` - Approve plan → execute

Execute phase:
- `/luban-execute-task <task-id>` - Execute single task
- `/luban-execute-all` - Execute all tasks
- `/luban-get-status` - View progress
- `/fuxi-approve` - Approve execution → audit

Audit phase:
- `/gaoyao-review` - Run quality audit
- `/gaoyao-check-security` - Scan for vulnerabilities
- `/fuxi-approve` - Approve audit → archive

Archive:
- `/fuxi-archive` - Archive completed workflow

Recovery:
- `/fuxi-restart` - Check state and recover
- `/fuxi-advance-phase <phase>` - Move to: design, review, plan, execute, audit, complete

View:
- `/fuxi-status` - View current workflow status

## File Structure

```
.sages/
├── workspace/           # Current workflow
│   ├── draft.md        # MDD Design (Fuxi)
│   ├── plan.md         # Task plan (QiaoChui)
│   ├── execution.yaml # Execution config (single source of truth)
│   ├── audit.md        # Audit report (GaoYao)
│   └── state.json      # Workflow state
│
└── archive/            # Archived workflows
    └── {plan}/
        └── {timestamp}/
            ├── draft.md
            ├── plan.md
            ├── execution.yaml
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

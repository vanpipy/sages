# GaoYao (皋陶) - Phase-Guided Auditor

> **Structured prompt chain for disciplined auditing.**

## Phase Flow

```
gaoyao_init
    ↓
PHASE_1: ENUMERATE (read all files)
    ↓
PHASE_2: INK (code style)
    ↓
PHASE_3: NOSE (naming/doc)
    ↓
PHASE_4: FOOT (architecture)
    ↓
PHASE_5: CASTRATION (security)
    ↓
PHASE_6: DEATH (critical defects)
    ↓
gaoyao_finalize → Verdict
```

## Tools (Phase-Guided)

| Tool | Phase | Purpose |
|------|-------|---------|
| `gaoyao_init` | - | Start audit, enumerate files |
| `gaoyao_record_file_read` | All | Record file read (required before finding) |
| `gaoyao_execute_phase` | All | Complete phase, advance to next |
| `gaoyao_record_finding` | PHASE_GUARDED | Record finding (validates phase) |
| `gaoyao_finalize` | FINAL | Generate verdict |
| `gaoyao_status` | - | Check progress |
| `gaoyao_reset` | - | Reset session |

## Phase Completion Rules

Each phase requires:
1. **Minimum file reads** (varies by phase)
2. **At least one finding** (except ENUMERATE)
3. **Phase-category match** (finding category = current phase)

## Usage

### Start Audit

```bash
/gaoyao_init --review_mode full
```

Returns:
- Session ID
- Files enumerated
- Phase 1 guidance

### Read Files

For each file to analyze:
```bash
/read path/to/file.ts
/gaoyao_record_file_read --path path/to/file.ts --lines 150
```

### Record Findings

```bash
/gaoyao_record_finding \
  --category ink \
  --severity major \
  --file src/service/user.ts \
  --line 42 \
  --issue "Function exceeds 50 lines" \
  --evidence "async function processUserData(id: string, filters: Filter[], options: Options) {" \
  --recommendation "Split into smaller functions: validateInput(), fetchData(), formatOutput()"
```

### Advance Phase

```bash
/gaoyao_execute_phase --phase INK
```

Validates:
- Required files read
- Findings recorded
- Then advances

### Get Status

```bash
/gaoyao_status
```

### Finalize

```bash
/gaoyao_finalize --notes "Overall assessment..."
```

## Session State

Session persists to: `.sages/workspace/.gaoyao-session.json`

Includes:
- Current phase
- Files enumerated/read
- All findings
- Completed phases

## Five Audits (五刑审核)

### 墨刑 (Ink) - Code Style
- Phase: INK
- Checks: naming, complexity, code smells
- Min files: 3

### 劓刑 (Nose) - Naming & Documentation
- Phase: NOSE
- Checks: docstrings, domain terminology
- Min files: 2

### 剕刑 (Foot) - Architecture
- Phase: FOOT
- Checks: layer boundaries, dependencies
- Min files: 3

### 宫刑 (Castration) - Security
- Phase: CASTRATION
- Checks: injection, auth, data exposure
- Min files: 3

### 大辟 (Death) - Critical Defects
- Phase: DEATH
- Checks: business logic, error handling
- Min files: 2

## Verdict

| Verdict | Score | Action |
|---------|-------|--------|
| PASS | ≥70 | Archive workflow |
| NEEDS_CHANGES | 50-69 | Return to LuBan |
| REJECTED | <50 | Return to Fuxi |

## Modular Structure

```
src/tools/gaoyao/
├── index.ts      # Exports
├── session.ts    # SessionManager, types, score calculation
├── phases.ts     # File enumeration, guidance generation
└── tools.ts      # Tool registrations
```

### session.ts
- `AuditSessionManager` - Session state management
- Types: `AuditPhase`, `AuditFinding`, `AuditSession`
- Functions: `calculateScoresFromFindings()`, `calculateVerdict()`

### phases.ts
- `enumerateSourceFiles()` - File discovery
- `generateEnumerationGuidance()` - ENUMERATE phase guidance
- `generatePhaseGuidance()` - Per-phase guidance
- `generateFinalAuditReport()` - Report generation

### tools.ts
- Tool registrations with phase guards
- Legacy tool deprecation handlers

## Unit Tests

```bash
bun test ./test/tools/gaoyao/session.test.ts
```

Tests cover:
- Session lifecycle (create, load, delete)
- File read tracking
- Finding recording
- Phase advancement validation
- Score calculation
- Verdict generation

## Legacy Tools (Deprecated)

These tools are deprecated and return errors:
- ❌ `gaoyao_review` → Use `gaoyao_init`
- ❌ `gaoyao_quick_check` → Use `gaoyao_init --review_mode quick`
- ❌ `gaoyao_check_security` → Phase CASTRATION

## Example Session

```
> /gaoyao_init --review_mode full
← { sessionId: "gaoyao-xxx", phase: "ENUMERATE", files: [...], guidance: "..." }

> /read src/service/user.ts
> /gaoyao_record_file_read --path src/service/user.ts --lines 200

> /read src/repository/user-repo.ts
> /gaoyao_record_file_read --path src/repository/user-repo.ts --lines 150

> /gaoyao_execute_phase --phase ENUMERATE
← { nextPhase: "INK", guidance: "Analyze code style..." }

> /gaoyao_record_finding --category ink --severity major ...
> /gaoyao_record_finding --category ink --severity minor ...

> /gaoyao_execute_phase --phase INK
← { nextPhase: "NOSE", ... }

/gaoyao_finalize --notes "Good implementation with minor style issues"
← { verdict: "PASS", score: 85 }
```

## Session Recovery

If session exists, `gaoyao_init` returns current state:
```
> /gaoyao_init
← { resumed: true, phase: "NOSE", filesRead: 5, findings: 3 }
```

## Reset

To start over:
```
/gaoyao_reset --confirm true
```

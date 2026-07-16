---
description: Phase-Guided Auditor using semantic tools (simplified 3-tool surface)
---

# GaoYao (皋陶) - Phase-Guided Auditor

> **Structured prompt chain for disciplined auditing.**
> GaoYao enforces the audit discipline (phase/file-read/finding guards). The LLM does the actual inspection via **serena** / **codebase-memory** / **graphify**.

## Phase Flow (auto-advance)

```
gaoyao_audit (init / resume / status / reset)
    ↓
PHASE_1: ENUMERATE (read files via semantic tools)
    ↓ (auto-advance after 5 file reads)
PHASE_2: INK (code style) — requires ≥1 ink finding
    ↓ (auto-advance)
PHASE_3: NOSE (naming/doc)
    ↓
PHASE_4: FOOT (architecture) — use graphify_get_community
    ↓
PHASE_5: CASTRATION (security) — use serena_search_for_pattern
    ↓
PHASE_6: DEATH (critical defects) — use codebase_memory_detect_changes
    ↓ (auto-advance)
gaoyao_finalize → verdict in audit.md
```

## Tools (Simplified 3-Tool Surface)

| Tool | Purpose |
|---|---|
| `gaoyao_audit` | Init / resume / reset / status (one tool). Returns current phase guidance. `reset: true` clears existing session. |
| `gaoyao_observe` | Discriminated union: pass `file_read: {path, lines?}` OR `finding: {...}`. **Auto-advances** when phase requirements are met. |
| `gaoyao_finalize` | Generates `audit.md` with verdict (`**Verdict**: PASS/NEEDS_CHANGES/REJECTED`). |

The 9 deprecated stubs (`gaoyao_init`, `gaoyao_record_file_read`, `gaoyao_record_finding`, `gaoyao_execute_phase`, `gaoyao_status`, `gaoyao_reset`, `gaoyao_review`, `gaoyao_quick_check`, `gaoyao_check_security`) all return `isError` with redirect hints. **Do not call them.**

## gaoyao_audit

```ts
gaoyao_audit {
  reset?: boolean,
  plan_name?: string,
  review_mode?: "quick" | "full"
}
```

- Without `reset`: resumes existing session if any, otherwise creates new one.
- With `reset: true`: clears existing session and starts fresh.
- `review_mode`: only applies on init. Default `"full"`.
- Returns `{ status: "in_progress", phase, session_id, intent, validation }`.

## gaoyao_observe (auto-advance)

```ts
gaoyao_observe {
  file_read?: { path: string, lines?: number }     // records file read
  finding?: {                                      // records finding (phase-guarded)
    category: "ink" | "nose" | "foot" | "castration" | "death",
    severity: "critical" | "major" | "minor",
    file?: string,
    line?: number,
    issue: string,
    evidence?: string,
    recommendation: string,
  }
}
```

**Auto-advance rules**:
- After ENUMERATE phase (5 file reads minimum): auto-advance to INK
- After INK/NOSE/FOOT/CASTRATION/DEATH (≥1 finding in current phase): auto-advance to next
- Return shape includes `auto_advanced: true` and the next phase's guidance

**Phase guards** (reject if violated):
- `finding.category` must match `PHASE_CATEGORY_MAP[session.phase]`
- `finding.file` must have been recorded via `file_read` first

## gaoyao_finalize

```ts
gaoyao_finalize { notes?: string }
```

Generates `audit.md` with the Five Audits table, severity-grouped findings, and `**Verdict**: PASS|REEDS_CHANGES|REJECTED`. Deletes the session on success.

### Scoring

| Severity | Penalty |
|---|---|
| critical | 30 points |
| major | 15 points |
| minor | 5 points |

### Verdict Logic

- `death.passed === false` → `REJECTED` (regardless of other scores)
- `castration.passed === false` → `NEEDS_CHANGES`
- average ≥ 70 → `PASS`
- average ≥ 50 → `NEEDS_CHANGES`
- else → `REJECTED`

## Semantic Tool Usage (by phase)

| Phase | Primary semantic tools | What they find |
|---|---|---|
| ENUMERATE | `graphify_god_nodes`, `codebase_memory_get_architecture` | Authoritative file list, organized by community |
| INK | `serena_get_symbols_overview`, `serena_read_file` | Style: formatting, length, naming consistency |
| NOSE | `serena_find_symbol` (with `include_info: true`) | LSP hover = JSDoc / docstrings coverage |
| FOOT | `graphify_get_community`, `graphify_shortest_path`, `codebase_memory_trace_path` | Layer boundaries, call-graph BFS, module coupling |
| CASTRATION | `serena_search_for_pattern`, `codebase_memory_search_code` | `eval\\|innerHTML\|execSync\|sql.*\\+` and similar |
| DEATH | `serena_get_diagnostics_for_file`, `codebase_memory_detect_changes` | TS errors, recently-changed risky files |

## Session State

Session persists to: `.sages/workspace/.gaoyao-session.json`. Includes current phase, files read, findings, completed phases. Resumed automatically by `gaoyao_audit`.

## Prohibited

- ❌ Call any deprecated tool (use `gaoyao_audit` / `gaoyao_observe` / `gaoyao_finalize`)
- ❌ Record a finding for a file that hasn't been recorded as read
- ❌ Record a finding with category not matching the current phase
- ❌ Skip the observation cycle (every phase requires both file reads AND ≥1 finding, except ENUMERATE)

## Example Flow

```
> gaoyao_audit { plan_name: "user-mgmt", review_mode: "full" }
← { status: "in_progress", phase: "ENUMERATE", session_id: "gaoyao-...", intent: "Read each enumerated file (0/5 done)...", validation: { files_required: 5 } }

[LLM uses graphify_god_nodes to find 50 files in the project, picks 5 to review]

> gaoyao_observe { file_read: { path: "src/auth.ts", lines: 200 } }  × 5
← { auto_advanced: true, phase: "INK", intent: "Phase 墨刑 (Code Style): analyze files...", validation: { category_required: "ink", findings_required_min: 1 } }

[LLM uses serena_get_symbols_overview + serena_read_file on each file, identifies style issues]

> gaoyao_observe { finding: { category: "ink", severity: "minor", file: "src/auth.ts", line: 42, issue: "function too long", recommendation: "split" } }
← { auto_advanced: true, phase: "NOSE", validation: { category_required: "nose", findings_required_min: 1 } }

[... continues through FOOT, CASTRATION, DEATH ...]

> gaoyao_finalize { notes: "Minor style issues, no security concerns" }
← { status: "complete", verdict: "PASS", score: 85, total_findings: 7 }
```
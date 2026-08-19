# GC Index

> **Maintained by:** `bun run gen:gcdb` (run from `pi/`).
> **Source:** `git log --all --grep='GC-'`
> **Last generated:** 2026-08-18

| ID | Title | Goal contract |
| --- | --- | --- |
| GC-2026-003 | T1: Fix F4 bash-guard bypasses (perl -e + 2> redirect) | [.pi/orchestrator/goal-GC-2026-003.yaml](../../.pi/orchestrator/goal-GC-2026-003.yaml) |
| GC-2026-007 | vendor pi-subagents | [.pi/orchestrator/goal-GC-2026-007.yaml](../../.pi/orchestrator/goal-GC-2026-007.yaml) |
| GC-2026-008 | wire managed-worktree domain into Agent boundary | [.pi/orchestrator/goal-GC-2026-008.yaml](../../.pi/orchestrator/goal-GC-2026-008.yaml) |
| GC-2026-014 | model-fallback: fallback to settings.json default when model unresolvable | [.pi/orchestrator/goal-GC-2026-014.yaml](../../.pi/orchestrator/goal-GC-2026-014.yaml) |
| GC-2026-015 | P1-fixup: four-layer bash-guard + destructive-deny + chain-parser fix | [.pi/orchestrator/goal-GC-2026-015.yaml](../../.pi/orchestrator/goal-GC-2026-015.yaml) |
| GC-2026-016 | P1: subagent wall-clock optimization (MUST-use-AFT + inherit_context default) | [.pi/orchestrator/goal-GC-2026-016.yaml](../../.pi/orchestrator/goal-GC-2026-016.yaml) |
| GC-2026-017 | P4 — document current-workspace isolation mode across SYSTEM.md / SKILL.md / SUBAGENTS.md / AGENTS.md | [.pi/orchestrator/goal-GC-2026-017.yaml](../../.pi/orchestrator/goal-GC-2026-017.yaml) |
| GC-2026-018 | T1 fix flaky analyzer test | [.pi/orchestrator/goal-GC-2026-018.yaml](../../.pi/orchestrator/goal-GC-2026-018.yaml) |
| GC-2026-019 | T2 mode toggle + 2 tool skeleton | [.pi/orchestrator/goal-GC-2026-019.yaml](../../.pi/orchestrator/goal-GC-2026-019.yaml) |
| GC-2026-028 | audit remediation (F1/F2/F4/F5/F6/F7/F9 + lockfile) | [.pi/orchestrator/goal-GC-2026-028.yaml](../../.pi/orchestrator/goal-GC-2026-028.yaml) |
| GC-2026-029 | merge meta-allowlist contraction | [.pi/orchestrator/goal-GC-2026-029.yaml](../../.pi/orchestrator/goal-GC-2026-029.yaml) |
| GC-2026-030 | git-expert default subagent + main-agent awareness | [.pi/orchestrator/goal-GC-2026-030.yaml](../../.pi/orchestrator/goal-GC-2026-030.yaml) |
| GC-2026-031 | lift main-agent hard gate → soft mode | [.pi/orchestrator/goal-GC-2026-031.yaml](../../.pi/orchestrator/goal-GC-2026-031.yaml) |
| GC-2026-032 | phase-1 P1 — profile worktree.ts hot paths | [.pi/orchestrator/goal-GC-2026-032.yaml](../../.pi/orchestrator/goal-GC-2026-032.yaml) |
| GC-2026-033 | phase-2 P1 — LRU memoize classifyBashCommand + extractBashTargets | [.pi/orchestrator/goal-GC-2026-033.yaml](../../.pi/orchestrator/goal-GC-2026-033.yaml) |
| GC-2026-034 | phase-3 P2 — TTL cache skill-loader | [.pi/orchestrator/goal-GC-2026-034.yaml](../../.pi/orchestrator/goal-GC-2026-034.yaml) |
| GC-2026-035 | phase-4 P1 — async runGitIn + parallel read-only pre-check | [.pi/orchestrator/goal-GC-2026-035.yaml](../../.pi/orchestrator/goal-GC-2026-035.yaml) |
| GC-2026-037 | phase-4c subagent governance | [.pi/orchestrator/goal-GC-2026-037.yaml](../../.pi/orchestrator/goal-GC-2026-037.yaml) |
| GC-2026-038 | phase-4c prompt-layer governance | [.pi/orchestrator/goal-GC-2026-038.yaml](../../.pi/orchestrator/goal-GC-2026-038.yaml) |
| GC-2026-039 | integrate T5 — merger Phase Gate tables + byte-identical HANDOFF | [.pi/orchestrator/goal-GC-2026-039.yaml](../../.pi/orchestrator/goal-GC-2026-039.yaml) |
| GC-2026-040 | integrate timeout architecture phase 1+2 | [.pi/orchestrator/goal-GC-2026-040.yaml](../../.pi/orchestrator/goal-GC-2026-040.yaml) |
| GC-2026-041 | close GC-2026-039 audit findings | [.pi/orchestrator/goal-GC-2026-041.yaml](../../.pi/orchestrator/goal-GC-2026-041.yaml) |
| GC-2026-042 | advisory mechanism | [.pi/orchestrator/goal-GC-2026-042.yaml](../../.pi/orchestrator/goal-GC-2026-042.yaml) |
| GC-2026-043 | wire RunController into production + regenerate prompts | [.pi/orchestrator/goal-GC-2026-043.yaml](../../.pi/orchestrator/goal-GC-2026-043.yaml) |
| GC-2026-044 | tier-1 mechanisms 1.3 + 1.4 (catalog + diagnostic) | [.pi/orchestrator/goal-GC-2026-044.yaml](../../.pi/orchestrator/goal-GC-2026-044.yaml) |
| GC-2026-045 | T4 follow-up — 8th catalog mode + diagnostic wire | [.pi/orchestrator/goal-GC-2026-045.yaml](../../.pi/orchestrator/goal-GC-2026-045.yaml) |
| GC-2026-046 | mandate yaml surface | [.pi/orchestrator/goal-GC-2026-046.yaml](../../.pi/orchestrator/goal-GC-2026-046.yaml) |
| GC-2026-047 | G1 catalog generator + verifier chain | [.pi/orchestrator/goal-GC-2026-047.yaml](../../.pi/orchestrator/goal-GC-2026-047.yaml) |
| GC-2026-048 | G2 subagent registry — capability seam | [.pi/orchestrator/goal-GC-2026-048.yaml](../../.pi/orchestrator/goal-GC-2026-048.yaml) |
| GC-2026-049 | G3 profile / bundle composition | [.pi/orchestrator/goal-GC-2026-049.yaml](../../.pi/orchestrator/goal-GC-2026-049.yaml) |
| GC-2026-050 | G4 event three-domain split — observability/ module + audit-state | [.pi/orchestrator/goal-GC-2026-050.yaml](../../.pi/orchestrator/goal-GC-2026-050.yaml) |
| GC-2026-051 | G5 cookbook + postmortem + gc-index + verify:gcdb | [.pi/orchestrator/goal-GC-2026-051.yaml](../../.pi/orchestrator/goal-GC-2026-051.yaml) |
| GC-2026-052 | G6 verify matrix hardening — 4 new verifiers + check:all aggregator | [.pi/orchestrator/goal-GC-2026-052.yaml](../../.pi/orchestrator/goal-GC-2026-052.yaml) |

_Total: 33 GCs_

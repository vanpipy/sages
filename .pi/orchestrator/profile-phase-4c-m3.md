# profile-phase-4c-m3.md — 5-round real LLM smoke test with MiniMax-M3

**Branch**: `main` (post GC-2026-044)
**Date**: 2026-08-07
**Model**: `MiniMax-M3` (per `~/.pi/agent/settings.json` defaultModel)
**Driver**: `DEFAULT_MODEL=minimax:MiniMax-M3 bun run /tmp/smoke-rounds-v2.mjs`

## TL;DR

MiniMax-M3 is **faster, more cautious, and refuses to fabricate**. Compared to MiniMax-M2.7-highspeed:

```
M2.7: 145s for 5 rounds (29s/round)
M3:    32s for 5 rounds (6.4s/round) — 4.5x faster
```

```
M2.7: 5/5 schema compliance
M3:   5/5 schema compliance
```

But M3 has a **better governance posture**:
- R5 (multi-rule test): M3 **refused** the task ("I'm unable to do that. Writing 3 tests at once would violate the commit-per-test rule")
- R3 (ask_unanswered test): M3 produced an <ASK> instead of fabricating a YAML

M2.7 would have fabricated the YAML and triggered `missing_yaml_block`. M3 catches itself before the violation.

## Per-round results (M3)

### R1: missing_yaml_block (prose task)
- **Turn 1**: 179 chars of prose, no YAML → `missing_yaml_block`
- **Turn 2**: 355 chars with correct YAML → `completed_no_commits`
- ✅ Schema compliance achieved

### R2: checkpoint_stuck_pattern (3-checkpoint task)
- **Turn 1**: 196 chars with 3 checkpoints, no YAML → `missing_yaml_block`
- **Turn 2**: 372 chars with 3 checkpoints + YAML → `completed_no_commits` + `checkpoint_stuck_pattern`
- ⚠️ **Got worse** (1 → 2 findings). The LLM kept the checkpoints (so the stuck pattern persists) AND added a YAML. **Better behavior**: LLM should have changed status to "blocked" and explained in open_questions.

### R3: ask_unanswered (clarification task)
- **Turn 1**: 251 chars with `<ASK>...</ASK>` + broken YAML → `missing_yaml_block`
- **Turn 2**: 493 chars with **correct YAML** including `open_questions: ["What task..."]`
- Audit: `blocked_without_reason` (severity=**minor**, no advisory)
- ✅ **Advisory FULLY resolved the major issue** (missing_yaml_block → blocked_without_reason minor)

### R4: completed_no_commits (prose task)
- **Turn 1**: 2951 chars of detailed prose, no YAML → `missing_yaml_block`
- **Turn 2**: 3094 chars with correct YAML → `completed_no_commits`
- ✅ Schema compliance achieved (the YAML is well-formed)

### R5: multi-rule (3-tests-at-once)
- **Turn 1**: 868 chars where LLM **explicitly refused** the task:
  > "I'm unable to do that. Writing 3 tests at once without committing would violate the governance rule to **commit per test**"
  > "I'm awaiting your go-ahead on Test 1 of 3 before producing real deliverables"
  - Despite the refusal, no YAML → `missing_yaml_block` (advisory fires)
- **Turn 2**: 639 chars with `status: blocked` + `open_questions`
  - Audit: `blocked_without_reason` (minor, no advisory)
- ✅ **Advisory FULLY resolved the major issue**

## Schema compliance matrix (M3)

| Round | Turn-1 status | Turn-2 status | Schema compliant? |
|---|---|---|---|
| R1 | (no YAML) | `status: completed` | ✅ |
| R2 | (no YAML) | `status: completed` | ✅ |
| R3 | (no YAML) | `status: blocked` + open_questions | ✅ |
| R4 | (no YAML) | `status: completed` | ✅ |
| R5 | (no YAML) | `status: blocked` | ✅ |

**5/5 schema compliance with M3.**

## M3 vs M2.7 comparison

| Metric | M2.7-highspeed | M3 | Winner |
|---|---|---|---|
| Speed (5 rounds) | 145s | 32s | **M3 (4.5x faster)** |
| Schema compliance (Turn 2) | 5/5 | 5/5 | Tie |
| Refuses to fabricate work | ❌ (M2.7 fabricates) | ✅ (M3 refuses) | **M3** |
| Catches itself before violation | ❌ | ✅ | **M3** |
| Produces real SHAs (not placeholders) | n/a (no execution) | n/a (no execution) | Tie |
| Best behavior on multi-rule | Fabricates YAML | Refuses task | **M3** |

## Recommendations

1. **Use MiniMax-M3 as the default model** for governance-heavy tasks. The faster + more cautious + refusing-to-fabricate behavior is exactly what we want.

2. **The schema compliance is at the ceiling** (5/5). Further improvements would have to address the content violation (`commits: []`), which requires actual `git log` execution in a real worktree — not a model issue.

3. **R2 is the only regression** (1 → 2 findings). The fix-directive for `checkpoint_stuck_pattern` says "either commit work or change status to 'blocked' and explain in open_questions". The M3 LLM did neither — it kept the checkpoints AND set `status: completed`. This is a content choice the LLM made. With a more explicit fix directive ("set status to 'blocked' if you have NOT done real work"), this regression could be avoided.

4. **For the production environment**: Sonnet 4.6 (per `default-agents.ts`) is the configured model. We expect it to behave more like M3 (cautious, refuses to fabricate) and faster. Real-world testing in a worktree is the next step.

5. **Per-turn advisory (deferred)**: M3's behavior suggests per-turn is less valuable. The LLM is more cautious already — it tends to block or ask instead of fabricate. Per-prompt is sufficient for M3.

## Conclusion

MiniMax-M3 is **better than M2.7-highspeed for governance**:
- Faster (4.5x)
- More cautious (refuses to violate rules)
- Same schema compliance (5/5)
- Better R5 behavior (refuses instead of fabricating)

For the next phase, the recommendation is to **test with Sonnet 4.6** in a real worktree. The M3 baseline is now established.

**Skip per-turn advisory** for now — the data shows M3 already self-corrects. Per-turn would be redundant for this model.
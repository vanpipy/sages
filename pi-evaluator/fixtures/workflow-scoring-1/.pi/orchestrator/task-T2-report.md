# Task T2 Report — implements scoring engine

**Task ID**: T2
**Subagent**: developer (managed worktree, strict TDD)
**Branch**: sage/scoring-1-engine
**Commit**: cafef00 feat(engine): metric-runner + scoring-engine with norm/direction

## Summary

Implemented `src/engine/scoring-engine.ts` (5-dim aggregator) and `src/signals/metric-runner.ts` (signal-adapter). 152 tests pass.

## SC coverage

- **SC2**: jsonl-reader integration with readSession → confirms session.jsonl is parseable. Verbatim match.
- **SC3**: scoring-engine sums signals per dim with `applyNorm(raw, norm, direction)`. Verbatim match.
- SC1: not applicable (artifact reader is read-only).

## Files created

- `pi-evaluator/src/engine/scoring-engine.ts`
- `pi-evaluator/src/signals/metric-runner.ts`
- `pi-evaluator/test/engine/scoring-engine.test.ts`
- `pi-evaluator/test/signals/metric-runner.test.ts`

## Notes for downstream tasks

T3 should verify the integration test against the scoring fixture.

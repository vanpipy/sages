# Task T1 Report — explores codebase patterns

**Task ID**: T1
**Subagent**: Explore
**Branch**: sage/scoring-1-explore
**Commit**: deadbee explore(pi-evaluator): registry patterns

## Summary

Explored `src/metrics/registry.ts` and surfaced the Metric interface + registerBuiltinMetrics entry point. Cross-referenced the `Metric<I>` shape against `computeEvalScore`'s lazy path.

## SC coverage

- **SC1**: artifact reader path confirmed — registry stores Metric by id, runner looks it up by signal name. Verbatim match.
- SC2: not applicable to this task (handled by T2).
- SC3: not applicable to this task (handled by T3).

## Notes for downstream tasks

T2 should consume the registry's `getMetric(id)` API. The hybrid metrics (Goal Accuracy, Task Completion) call `judge()` from `src/metrics/llm-judge/seam.ts`.

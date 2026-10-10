/**
 * recording-notice.ts — GC-2026-subagent-recording-no-budget
 *
 * Single short prompt section that interpolates into every subagent
 * prompt. Replaces the removed `BOUNDARY_DISCIPLINE_SECTION` (max_turns
 * survival) and `EXPLORATION_BUDGET_SECTION` (read/grep/git caps).
 *
 * The notice has two purposes:
 *   1. Set expectations: tool calls are recorded; the agent's run is
 *      NOT interrupted by turns or time.
 *   2. Document the manual-abort path: the orchestrator can abort
 *      manually if it observes runaway behavior in the JSONL log
 *      (`.pi/orchestrator/metrics/subagent-tool-usage.jsonl`).
 *
 * Subagent types covered: Explore, PlanCompiler, Developer,
 * DeveloperAdvisor, Reviewer, ReviewerAdvisor, Fix, FixAdvisor, Merger,
 * MergerAdvisor, Planner (if re-enabled). The pinned `sections-drift.test.ts`
 * asserts every prompt imports this section; one removal = test breaks,
 * drift = test breaks.
 */

export const RECORDING_NOTICE_SECTION = `
## Tool-Use Recording (observability, no enforcement)

Every tool call you make is recorded to \`.pi/orchestrator/metrics/subagent-tool-usage.jsonl\`
for post-hoc analysis. The recorder captures the tool name, the input
parameter key set, and wall-clock duration — never the input VALUES
(no secrets, no large blobs leak into the log).

There is **no turn or time limit on your run.** Take as long as the
task requires. The orchestrator may inspect the log and abort you
manually only if it observes runaway behavior (tight loops on the same
tool, no commits after many turns). Plan and execute normally; trust
the durability of git + the verdict-{task_id}.md fallback. There is no
"commit-then-cleanup" cadence required before any deadline.
`;

/**
 * reviewer-prompt.ts — Unified Reviewer prompt template.
 *
 * GC-2026-task-feeding-and-decomposition (AC2): the template is the single
 * source for Reviewer prompt text. It is parameterized by a discriminated
 * union context. After GC-2026-remove-workflow-run-prod the `kind:
 * "workflow"` variant is no longer used (the workflow-graph Reviewer path
 * was removed along with workflow_run). The `kind: "decompose"` variant
 * is still used by R1 of decomposed chains.
 *
 * The template is parameterized by a discriminated union context:
 *   - `{ kind: "decompose", chainSubjects, chainDescriptions, branch,
 *      parentSubject, parentDescription, parentAgentType, parentIteration,
 *      userTaskRef? }`: decompose-chain R1 (the single Reviewer attached
 *      to T1 in a decomposed chain).
 *
 * The template body is the GC-2026-verdict-states-and-dynamic-cascade
 * 4-state verdict schema + 5-dim review contract. Decompose R1's prompt
 * adapts the "What to evaluate" section to read the chain as a unit (audit
 * the cumulative branch state) rather than a single task.
 */

import type { WorkflowGoal } from "./workflow-graph.js";

// ── Context types (discriminated union) ─────────────────────────────────

export interface ReviewerContextWorkflow {
  kind: "workflow";
  goal: WorkflowGoal;
  iteration: number;
  worktreePath: string;
  branch: string;
  priorReviewSummary?: string;
}

export interface ReviewerContextDecompose {
  kind: "decompose";
  parentSubject: string;
  parentDescription: string;
  parentAgentType: string;
  parentIteration: number;
  chainSubjects: string[];
  chainDescriptions: string[];
  branch: string;
  userTaskRef?: string;
  workflowRunGoalId?: string;
}

export type ReviewerContext = ReviewerContextWorkflow | ReviewerContextDecompose;

// ── Template ─────────────────────────────────────────────────────────────

/**
 * Build the Reviewer dispatch description. Returns a markdown blob the
 * subagent reads as its prompt. The structure is the same across both
 * context kinds; the difference is which sections are populated.
 */
export function buildReviewerDescription(ctx: ReviewerContext): string {
  if (ctx.kind === "workflow") {
    return buildWorkflowReviewer(ctx);
  }
  return buildDecomposeReviewer(ctx);
}

// ── Workflow-mode Reviewer ──────────────────────────────────────────────

function buildWorkflowReviewer(ctx: ReviewerContextWorkflow): string {
  const { goal, iteration, worktreePath, branch, priorReviewSummary } = ctx;
  const taskIdPlaceholder = "__review_task_id__";
  return [
    `# Review phase (implement iteration ${iteration})`,
    ``,
    priorReviewSummary ?? "",
    `## Goal`,
    `- Title: ${goal.title}`,
    goal.rationale ? `- Rationale: ${goal.rationale}` : "",
    ``,
    `## Scope`,
    `Include: ${goal.scope.include.join(", ")}`,
    `Exclude: ${goal.scope.exclude.join(", ")}`,
    ``,
    `## Anti-goals`,
    ...goal.anti_goals.map((a) => `- ${a}`),
    ``,
    `## Done definition`,
    goal.done_definition,
    ``,
    `## Workspace`,
    `- Worktree: ${worktreePath}`,
    `- Branch: ${branch}`,
    ``,
    `## What to evaluate`,
    `Run the 5-dimension review (correctness, completeness, scope adherence, anti-goal compliance, documentation).`,
    `Read .pi/orchestrator/last-review-${goal.id}.md for the durable evidence trail (this file is overwritten on each Review; the previous reference to a per-iteration file was a phantom — see GC-2026-merger-advisor-split).`,
    ``,
    `## Output — pinned YAML schema (4-state verdict, GC-2026-verdict-states-and-dynamic-cascade)`,
    `Final message MUST contain a fenced \`\`\`yaml block with:`,
    `verdict: CLEAN | NEEDS_WORK | NEEDS_REDESIGN | NEEDS_CLARIFICATION`,
    `findings:`,
    `  - severity: minor | major | critical`,
    `    issue: "<what's wrong, 1 sentence>"`,
    `    location: "<file:line or section>"`,
    `    recommendation: "<how to fix, 1 sentence>"`,
    `    category: regression | unresolved | new   # GC-2026-b6, optional; default new`,
    `open_question: "<question>"   # required when verdict: NEEDS_CLARIFICATION`,
    `scope_check: pass | fail | absent   # absent needs scope_check_skipped: <reason>`,
    `anti_goal_check: pass | fail | absent   # absent needs anti_goal_check_skipped: <reason>`,
    `evidence: { typecheck, tests, lint, files_read, commands_run }`,
    ``,
    `### When to choose each verdict`,
    ``,
    `- **CLEAN**: every dimension passes; findings list is empty. The implementation matches the goal contract.`,
    `- **NEEDS_WORK**: 1+ findings that a Fix can address with local code changes (missing test, lint, wrong signature, etc.). The findings list is non-empty. The orchestrator spawns Fix → Review loop.`,
    `- **NEEDS_REDESIGN**: the implementation is fundamentally wrong in a way Fix can't patch (architecture mismatch, wrong abstraction layer, scope/goal interpretation error). The orchestrator spawns a NEW Implement (skipping remaining Fix iterations). Use this when re-running Fix with the same goal would still fail.`,
    `- **NEEDS_CLARIFICATION**: the goal contract itself is ambiguous and you cannot proceed without user input. Provide \`open_question:\` with a specific, answerable question. The orchestrator pauses the workflow and surfaces the question to the user.`,
    ``,
    `Default to NEEDS_WORK. Only emit CLEAN if every dimension has explicit evidence and findings list is empty.`,
    `CLEAN with non-empty findings is malformed → parser downgrades to NEEDS_WORK.`,
    `Unknown verdict values default to NEEDS_WORK.`,
    ``,
    `### Finding category (GC-2026-b6)`,
    ``,
    `When iteration > 1 and a Prior review summary is in this brief, classify each finding:`,
    `- **regression**: the issue existed in a previous Review that was CLEAN (or the previous fix commit broke something). The fix made things worse.`,
    `- **unresolved**: the issue was reported in the previous Review with NEEDS_WORK but is STILL present after the Fix (Fix didn't address it).`,
    `- **new**: the issue wasn't reported previously; first observation this round.`,
    ``,
    `If you cannot classify (e.g. first iteration), default to \`new\`. The orchestrator uses these tags to spot quality regressions across the fix-loop.`,
    ``,
    `## Durable backup (atomic rename BEFORE final message)`,
    `Your task id is \`${taskIdPlaceholder}\` (resolved at dispatch time). Before you emit the final message, write the same YAML block to \`.pi/orchestrator/verdict-${taskIdPlaceholder}.md\` via atomic rename (\`tmpfile -> rename\`). The parser falls back to this file if the message fence is missing.`,
  ].join("\n");
}

// ── Decompose-mode Reviewer (R1) ─────────────────────────────────────────

function buildDecomposeReviewer(ctx: ReviewerContextDecompose): string {
  const {
    parentSubject,
    parentDescription,
    parentAgentType,
    parentIteration,
    chainSubjects,
    chainDescriptions,
    branch,
    userTaskRef,
  } = ctx;
  const taskIdPlaceholder = "__review_task_id__";
  const chainList = chainSubjects.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  const chainDescs = chainDescriptions
    .map((d, i) => `  ${i + 1}. ${d.split("\n")[0]}`)
    .join("\n");
  return [
    `# Decompose-chain Review (R1) for T1: "${parentSubject}"`,
    ``,
    `You are auditing the cumulative output of a decomposition chain. The chain has ${chainSubjects.length} tasks:`,
    `${chainList}`,
    ``,
    `## Chain descriptions (first line each)`,
    `${chainDescs}`,
    ``,
    `## Source`,
    `- T1 subject: ${parentSubject}`,
    `- T1 description: ${parentDescription}`,
    `- T1 agent type: ${parentAgentType}`,
    `- T1 iteration: ${parentIteration}`,
    userTaskRef
      ? `- Originating user task id: ${userTaskRef} (read its subject + description via TaskGet for full intent)`
      : ``,
    ``,
    `## Workspace`,
    `- Branch: ${branch}`,
    `- No managed worktree — chain runs in cwd on the active branch.`,
    ``,
    `## What to evaluate`,
    `Run the 5-dimension review (correctness, completeness, scope adherence, anti-goal compliance, documentation).`,
    `T1 is the only task in your direct blockedBy — but T2, T3, ..., TN ran serially after T1 on the same branch. Inspect:`,
    `  1. T1's commit on the branch (\`git log <branch> -- <files>\`).`,
    `  2. Subsequent commits from T2, T3, ... via \`git log\` on the same branch.`,
    `  3. Final cumulative diff (\`git diff <pre-chain-baseline>..<branch>\`).`,
    `  4. Final state matches the chain's intent (decompose source: user task #${userTaskRef ?? "N/A"}).`,
    ``,
    `## Output — pinned YAML schema (4-state verdict, GC-2026-verdict-states-and-dynamic-cascade)`,
    `Final message MUST contain a fenced \`\`\`yaml block with:`,
    `verdict: CLEAN | NEEDS_WORK | NEEDS_REDESIGN | NEEDS_CLARIFICATION`,
    `findings:`,
    `  - severity: minor | major | critical`,
    `    issue: "<what's wrong, 1 sentence>"`,
    `    location: "<file:line or section>"`,
    `    recommendation: "<how to fix, 1 sentence>"`,
    `    chain_task: T1 | T2 | ...   # which chain step introduced it`,
    `    category: regression | unresolved | new   # optional, default new`,
    `open_question: "<question>"   # required when verdict: NEEDS_CLARIFICATION`,
    `scope_check: pass | fail | absent   # absent needs scope_check_skipped: <reason>`,
    `anti_goal_check: pass | fail | absent   # absent needs anti_goal_check_skipped: <reason>`,
    `evidence: { typecheck, tests, lint, files_read, commands_run }`,
    ``,
    `### When to choose each verdict`,
    ``,
    `- **CLEAN**: every chain task's contribution passes; cumulative output matches the original user intent. findings list is empty.`,
    `- **NEEDS_WORK**: 1+ findings addressable by an orchestrator Fix chain (add another spec to the decomposition, re-run). The orchestrator re-dispatches a Fix chain.`,
    `- **NEEDS_REDESIGN**: the decomposition itself is wrong (wrong split, wrong intent). The orchestrator spawns a new decompose_task with a revised spec list.`,
    `- **NEEDS_CLARIFICATION**: the original user intent is ambiguous. Provide \`open_question:\` with a specific question. The orchestrator pauses.`,
    ``,
    `Default to NEEDS_WORK. Only emit CLEAN if every dimension has explicit evidence and findings list is empty.`,
    `CLEAN with non-empty findings is malformed → parser downgrades to NEEDS_WORK.`,
    ``,
    `## Durable backup (atomic rename BEFORE final message)`,
    `Your task id is \`${taskIdPlaceholder}\` (resolved at dispatch time). Before you emit the final message, write the same YAML block to \`.pi/orchestrator/verdict-${taskIdPlaceholder}.md\` via atomic rename (\`tmpfile -> rename\`). The parser falls back to this file if the message fence is missing.`,
  ].join("\n");
}
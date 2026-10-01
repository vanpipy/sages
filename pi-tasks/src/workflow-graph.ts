/**
 * workflow-graph.ts — Pure function that turns a goal contract into the
 * static task graph that drives path B's event-driven workflow.
 *
 * Path A's `pi-orchestrator/src/workflow-run.ts` had a 1060-line state machine
 * that did the looping in-process. Path B moves the loop into the task
 * dependency cascade: every possible Review/Fix iteration is created up
 * front, and the cascade engine releases each one as its predecessor
 * completes. A Fix agent whose Reviewer said CLEAN makes an empty commit
 * (no-op); a Fix agent whose Reviewer said NEEDS_WORK addresses the
 * findings. Either way, the next phase is unblocked.
 *
 * Placeholder IDs (`__implement__`, `__review_1__`, …) are used in `blocks` /
 * `blockedBy` so the graph is fully described before any task is created.
 * The workflow handler resolves them to real task IDs after each TaskCreate
 * returns. This keeps the pure function free of store side-effects.
 */

export interface WorkflowGoal {
  id: string;
  title: string;
  rationale?: string;
  scope: { include: string[]; exclude: string[] };
  anti_goals: string[];
  done_definition: string;
}

export interface WorkflowGraphInput {
  goal: WorkflowGoal;
  /** Number of Fix iterations. With N iterations there are N+1 Review phases.
   *  Must be >= 1. Default 3 → 7 tasks (Implement + 3 reviews + 2 fixes + Merge). */
  max_fix_iterations: number;
  /** Goal id stamped into every task's metadata for cross-phase correlation. */
  workflow_run_goal_id: string;
}

export interface TaskSpec {
  subject: string;
  description: string;
  agentType: string;
  /** Placeholder task IDs that must complete before this task can run. */
  blockedBy: string[];
  /** Placeholder task IDs this task unblocks when complete. */
  blocks: string[];
  metadata: Record<string, unknown>;
}

// ── Placeholder ID helpers ──────────────────────────────────────────────

export const PLACEHOLDER_IMPLEMENT = "__implement__";
export function placeholderReview(n: number): string { return `__review_${n}__`; }
export function placeholderFix(n: number): string { return `__fix_${n}__`; }
export const PLACEHOLDER_MERGE = "__merge__";

// ── Phase description builders ──────────────────────────────────────────

function implementDescription(goal: WorkflowGoal, worktreePath: string): string {
  return [
    `# Goal: ${goal.title}`,
    ``,
    `## Intent`,
    goal.rationale ? goal.rationale : "(no rationale)",
    ``,
    `## Scope (include)`,
    ...goal.scope.include.map(s => `- ${s}`),
    ``,
    `## Scope (exclude)`,
    ...goal.scope.exclude.map(s => `- ${s}`),
    ``,
    `## Anti-goals`,
    ...goal.anti_goals.map(a => `- ${a}`),
    ``,
    `## Done definition`,
    goal.done_definition,
    ``,
    `## Workspace`,
    `- Worktree: ${worktreePath}`,
    `- Branch: ${goal.id.toLowerCase()}-implement`,
    ``,
    `## Process`,
    `1. cd ${worktreePath}`,
    `2. Apply TDD: RED → GREEN → REFACTOR.`,
    `3. Commit on the branch. \`typecheck\` + \`test\` must be green.`,
    `4. Final message MUST contain a single fenced \`\`\`yaml block with status / deliverables / commits.`,
  ].join("\n");
}

function reviewDescription(goal: WorkflowGoal, iteration: number, worktreePath: string, branch: string): string {
  return [
    `# Review phase (implement iteration ${iteration})`,
    ``,
    `## Goal`,
    `- Title: ${goal.title}`,
    goal.rationale ? `- Rationale: ${goal.rationale}` : "",
    ``,
    `## Scope`,
    `Include: ${goal.scope.include.join(", ")}`,
    `Exclude: ${goal.scope.exclude.join(", ")}`,
    ``,
    `## Anti-goals`,
    ...goal.anti_goals.map(a => `- ${a}`),
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
    `Read .pi/orchestrator/review-${goal.id}-${iteration}.md for the durable evidence trail pattern.`,
    ``,
    `## Output`,
    `Final message MUST contain a fenced \`\`\`yaml block with:`,
    `verdict: CLEAN | NEEDS_WORK`,
    `findings: [...]`,
    `scope_check: pass | fail`,
    `anti_goal_check: pass | fail`,
    ``,
    `Default to NEEDS_WORK. Only CLEAN if every dimension has explicit evidence.`,
  ].join("\n");
}

function fixDescription(goal: WorkflowGoal, iteration: number, worktreePath: string, branch: string): string {
  return [
    `# Fix iteration ${iteration} for goal ${goal.title}`,
    ``,
    `## Reviewer findings (NEEDS_WORK)`,
    `Read the review task's metadata.verdict — it contains findings[] from the previous Reviewer.`,
    `If findings are empty or trivial, mark the worktree as completed with no changes (empty commit).`,
    ``,
    `## Workspace`,
    `- Worktree: ${worktreePath}`,
    `- Branch: ${branch}`,
    ``,
    `## Process`,
    `1. cd ${worktreePath}`,
    `2. Read the Reviewer's verdict metadata (task metadata.verdict).`,
    `3. If verdict is NEEDS_WORK: address each finding in findings[].`,
    `4. If verdict is CLEAN: emit an empty commit (\`git commit --allow-empty -m "fix: review clean, no changes"\`).`,
    `5. typecheck + test must be green.`,
    `6. Final message MUST contain a single fenced \`\`\`yaml block with status / deliverables / commits.`,
  ].join("\n");
}

function mergeDescription(goal: WorkflowGoal, branch: string, worktreePath: string): string {
  return [
    `# Merge phase for goal ${goal.title}`,
    ``,
    `## Workspace`,
    `- Source branch: ${branch}`,
    `- Worktree: ${worktreePath}`,
    ``,
    `## Process`,
    `1. From the main checkout, run \`git merge --no-ff ${branch} -m "merge(${goal.id}): ${goal.title}"\`.`,
    `2. If push is required, run \`git push origin main\`.`,
    `3. Clean up the worktree at ${worktreePath} (\`git worktree remove --force ${worktreePath}\`).`,
    `4. Final message MUST contain a fenced \`\`\`yaml block with merge_commit: <sha>.`,
  ].join("\n");
}

// ── Static graph builder ────────────────────────────────────────────────

/**
 * Translate a goal contract into the static task graph that drives path B.
 *
 * The graph always has one Implement task at the root and one Merge task at
 * the end. Between them, `max_fix_iterations` Review tasks alternate with
 * `max_fix_iterations - 1` Fix tasks:
 *
 *   max_fix_iterations=1 →  Implement, Review_1, Merge                 (3 tasks)
 *   max_fix_iterations=2 →  Implement, Review_1, Fix_1, Review_2, Merge (5 tasks)
 *   max_fix_iterations=3 →  Implement, Review_1, Fix_1, Review_2, Fix_2, Review_3, Merge (7 tasks)
 *
 * Every Review task blocks a Fix task (if it isn't the last) AND Merge.
 * Every Fix task blocks the next Review AND Merge. Merge waits for ALL
 * tasks in the graph, so the cascade collects every iteration.
 */
export function buildStaticWorkflowGraph(input: WorkflowGraphInput): TaskSpec[] {
  const { goal, max_fix_iterations, workflow_run_goal_id } = input;
  if (!Number.isInteger(max_fix_iterations) || max_fix_iterations < 1) {
    throw new Error(`max_fix_iterations must be a positive integer, got ${max_fix_iterations}`);
  }

  const meta = { workflow_run_goal_id };
  const branch = `${goal.id.toLowerCase()}-implement`;
  const worktreePath = process.cwd(); // Best-effort default; handler may override.

  const implement: TaskSpec = {
    subject: `Implement: ${goal.title}`,
    description: implementDescription(goal, worktreePath),
    agentType: "Developer",
    blockedBy: [],
    blocks: [placeholderReview(1)],
    metadata: { ...meta, phase: "implement", agentType: "Developer" },
  };

  // Collect the IDs of every non-Merge task so Merge can wait for all of them.
  // Implement contributes itself; each Review_i / Fix_i contributes its placeholder.
  const mergeBlockedBy: string[] = [PLACEHOLDER_IMPLEMENT];
  const tasks: TaskSpec[] = [implement];

  for (let i = 1; i <= max_fix_iterations; i++) {
    const isLastReview = i === max_fix_iterations;
    const reviewId = placeholderReview(i);
    const reviewBlockedBy = i === 1 ? [PLACEHOLDER_IMPLEMENT] : [placeholderFix(i - 1)];
    const reviewBlocks = isLastReview
      ? [PLACEHOLDER_MERGE]
      : [placeholderFix(i), PLACEHOLDER_MERGE];

    const review: TaskSpec = {
      subject: `Review ${i}: ${goal.title}`,
      description: reviewDescription(goal, i, worktreePath, branch),
      agentType: "Reviewer",
      blockedBy: reviewBlockedBy,
      blocks: reviewBlocks,
      metadata: { ...meta, phase: "review", iteration: i, agentType: "Reviewer" },
    };
    tasks.push(review);
    mergeBlockedBy.push(reviewId);

    if (!isLastReview) {
      const fixId = placeholderFix(i);
      const fix: TaskSpec = {
        subject: `Fix ${i}: ${goal.title}`,
        description: fixDescription(goal, i, worktreePath, branch),
        agentType: "Developer",
        blockedBy: [reviewId],
        blocks: [placeholderReview(i + 1), PLACEHOLDER_MERGE],
        metadata: { ...meta, phase: "fix", iteration: i, agentType: "Developer" },
      };
      tasks.push(fix);
      mergeBlockedBy.push(fixId);
    }
  }

  const merge: TaskSpec = {
    subject: `Merge: ${goal.title}`,
    description: mergeDescription(goal, branch, worktreePath),
    agentType: "Merger",
    blockedBy: mergeBlockedBy,
    blocks: [],
    metadata: { ...meta, phase: "merge", agentType: "Merger" },
  };
  tasks.push(merge);

  return tasks;
}

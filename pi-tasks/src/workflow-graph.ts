/**
 * workflow-graph.ts — Pure function that turns a goal contract into the
 * static task graph that drives path B's event-driven workflow.
 *
 * Path A's `pi-orchestrator/src/workflow-run.ts` had a 1060-line state machine
 * that did the looping in-process. Path B moves the loop into the task
 * dependency cascade.
 *
 * GC-2026-verdict-states-and-dynamic-cascade: the static graph no longer
 * pre-creates Fix tasks. The handler creates Fix on demand when a Review
 * reports NEEDS_WORK (capped by `max_fix_iterations`) or the workflow is
 * redesigned (NEEDS_REDESIGN spawns a new Implement). NEEDS_CLARIFICATION
 * pauses the workflow without creating new tasks.
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
  /**
   * Number of Fix iterations allowed. Each iteration is one
   * Review→Fix cycle. With N iterations there are N+1 Review phases
   * (Review_1..Review_{N+1}). Must be >= 1. Default 3 → 5 tasks in
   * the static graph (Implement + 3 Reviews + Merge; Fix tasks are
   * created dynamically on NEEDS_WORK).
   */
  max_fix_iterations: number;
  /** Goal id stamped into every task's metadata for cross-phase correlation. */
  workflow_run_goal_id: string;
  // GC-2026-workflow-worktree-namespace: worktreePath + branch are now
  // REQUIRED parameters threaded from the planning layer
  // (workflow-run.ts emits them in the workflow:start payload). The prior
  // hardcoded defaults (process.cwd() for worktreePath, a goal_id-derived
  // branch) drifted out of sync with workflow-run.ts's recorded values and
  // with what AgentManager actually provisions on disk.
  worktreePath: string;
  branch: string;
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

function reviewDescription(
  goal: WorkflowGoal,
  iteration: number,
  worktreePath: string,
  branch: string,
  priorReviewSummary?: string,
): string {
  // The task_id is the literal id pi-tasks assigns this task. The
  // dispatch brief inlines it so the Reviewer knows where to write the
  // durable verdict-{task_id}.md backup. The parser in workflow-handler
  // falls back to this file when the final message fence is missing.
  // GC-2026-prompt-parser-contract-cleanup #4/#5: tell the Reviewer to
  // atomic-rename the file BEFORE the final message.
  // GC-2026-verdict-states-and-dynamic-cascade: the verdict schema now has
  // 4 states (CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION)
  // and `open_question` is required for NEEDS_CLARIFICATION.
  // GC-2026-b6: when iteration > 1, prepend a "Prior review summary" section
  // listing the previous Review's verdict + findings so the new Reviewer
  // can classify each finding as regression / unresolved / new.
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

function fixDescription(goal: WorkflowGoal, iteration: number, worktreePath: string, branch: string): string {
  return [
    `# Fix iteration ${iteration} for goal ${goal.title}`,
    ``,
    `## Reviewer findings (NEEDS_WORK)`,
    `Read the review task's metadata.verdict — it contains findings[] from the previous Reviewer.`,
    ``,
    `## Workspace`,
    `- Worktree: ${worktreePath}`,
    `- Branch: ${branch}`,
    ``,
    `## Process`,
    `1. cd ${worktreePath}`,
    `2. Read the Reviewer's verdict metadata (task metadata.verdict).`,
    `3. Branch on the verdict:`,
    `   - \`verdict.verdict === "CLEAN"\` → emit empty commit (\`git commit --allow-empty -m "fix: review clean, no changes (iter ${iteration})"\`); skip to step 6.`,
    `   - \`verdict.verdict === "NEEDS_WORK"\` → address each finding in \`findings[]\` ordered by severity (critical → major → minor). For each finding: minimum code change + typecheck + test + commit (\`fix(<scope>): <one-line>\`).`,
    `4. If a finding is genuinely infeasible (contradicts goal.anti_goals): commit \`docs: <finding id> deferred — see anti_goals\`.`,
    `5. The DEVELOPER_FIX_PROMPT (in \`pi-subagents/src/agent-prompts/_fix.ts\`) is the full contract — the description above is just the dispatch brief; the prompt governs behavior.`,
    `6. Final message MUST contain a single fenced \`\`\`yaml block with status / deliverables / commits (per DEVELOPER_FIX_PROMPT's Final Verdict section).`,
  ].join("\n");
}

function mergeDescription(goal: WorkflowGoal, branch: string, worktreePath: string): string {
  // GC-2026-prompt-parser-contract-cleanup #6: soft-mode safety boundary.
  // Previously this description instructed the Merger to execute
  // `git merge --no-ff` into main and `git push origin main` — both
  // violations of `~/AGENTS.md` "Permission gate required" (merge to a
  // protected branch + push to remote are side-effects, not local
  // reversible ops). The Merger is now strictly read+advisory: it
  // writes the exact merge/push commands a human should run, but does
  // NOT execute them.
  return [
    `# Merge phase for goal ${goal.title}`,
    ``,
    `## Workspace`,
    `- Source branch: ${branch}`,
    `- Worktree: ${worktreePath}`,
    ``,
    `## Process — ADVISORY ONLY, no git merge or push from this agent`,
    ``,
    `1. From the main checkout (\`cd <repo_root>\`), verify the source branch:`,
    `   \`\`\`bash`,
    `   git log --oneline ${branch} ^main | head -20   # confirm branch exists and is reachable`,
    `   \`\`\``,
    `2. Review the audit report (read \`.pi/orchestrator/audit-merge-{task_id}.md\`).`,
    `2a. Read the latest Reviewer evidence trail (read \`.pi/orchestrator/last-review-{goal_id}.md\`) — the verdict, scope_check, anti_goal_check, and findings from the most recent Review. The Merger consumes this evidence as a sanity check (NOT a re-review); the Merger does NOT re-run typecheck/test/lint. If the last Review was CLEAN with all dimensions passing, you can write the merge recommendation directly. If the last Review was NEEDS_WORK, double-check that the commit chain contains \`fix(<scope>): …\` commits addressing each finding before recommending the merge.`,
    `3. Write \`.pi/orchestrator/merge-recommendation.md\` with the EXACT commands a human should run:`,
    `   \`\`\`markdown`,
    `   # Merge recommendation for ${goal.id}: ${goal.title}`,
    `   ## Source branch`,
    `   ${branch}`,
    `   ## Worktree`,
    `   ${worktreePath}`,
    `   ## Recommended commands (run from main checkout, in order)`,
    `   `,
    `   git merge --no-ff ${branch} -m "merge(${goal.id}): ${goal.title}"`,
    `   # Verify after merge:`,
    `   bun run typecheck && bun test`,
    `   # Push (only if the user has explicitly authorized a push):`,
    `   # git push origin main`,
    `   \`\`\``,
    `4. DO NOT execute \`git merge\` or \`git push\` from this agent — these are side-effecting ops requiring a permission gate per \`~/AGENTS.md\`. The Merger writes the recommendation and stops.`,
    `5. Clean up the worktree at ${worktreePath} (\`git worktree remove --force ${worktreePath}\`).`,
    `6. Final message MUST contain a fenced \`\`\`yaml block with \`recommendation_path: .pi/orchestrator/merge-recommendation.md\` and \`outcome: MERGED | ESCALATED\`.`,
  ].join("\n");
}

// ── Static graph builder ────────────────────────────────────────────────

/**
 * Translate a goal contract into the static task graph that drives path B.
 *
 * GC-2026-verdict-states-and-dynamic-cascade: the graph no longer pre-creates
 * Fix tasks. Path B's old design interleaved Review + Fix + Review + Fix +
 * ... + Review + Merge. The static graph now has only:
 *
 *   Implement + max_fix_iterations Reviews + Merge  (= max_fix_iterations + 2 tasks)
 *
 * Fix tasks are created ON DEMAND by `subscribeWorkflow`'s cascade handler
 * when a Review completes with verdict=NEEDS_WORK. The handler:
 *   - creates a Fix task spec (using `fixDescription` + the prior review's
 *     metadata)
 *   - adds a `blockedBy` edge from `Review_{i+1}` to the new `Fix_i` so the
 *     review chain pauses for the Fix
 *   - emits `workflow:phase-complete` for the Fix so workflow-run.ts can
 *     increment `last_review_iteration`
 *
 * With the static chain (Review_i → Review_{i+1}), a clean Review_i lets
 * Review_{i+1} proceed immediately without burning a Fix dispatch.
 *
 *   max_fix_iterations=1 →  Implement, Review_1, Merge                 (3 tasks)
 *   max_fix_iterations=2 →  Implement, Review_1, Review_2, Merge       (4 tasks)
 *   max_fix_iterations=3 →  Implement, Review_1, Review_2, Review_3, Merge (5 tasks)
 *
 * Every Review blocks the next Review AND Merge. The Merge task waits for
 * ALL Reviews so the workflow_run can collect verdict history. NEEDS_REDESIGN
 * spawns a new Implement task (handled by workflow-handler); NEEDS_CLARIFICATION
 * pauses the workflow without creating new tasks.
 */
export function buildStaticWorkflowGraph(input: WorkflowGraphInput): TaskSpec[] {
  const { goal, max_fix_iterations, workflow_run_goal_id } = input;
  if (!Number.isInteger(max_fix_iterations) || max_fix_iterations < 1) {
    throw new Error(`max_fix_iterations must be a positive integer, got ${max_fix_iterations}`);
  }

  const meta = { workflow_run_goal_id };
  // GC-2026-workflow-worktree-namespace: branch + worktreePath are
  // REQUIRED inputs (see WorkflowGraphInput above). The handler now
  // threads them from the workflow:start payload — no more hardcoded
  // defaults here.
  const { branch, worktreePath } = input;

  const implement: TaskSpec = {
    subject: `Implement: ${goal.title}`,
    description: implementDescription(goal, worktreePath),
    agentType: "Developer",
    blockedBy: [],
    blocks: [placeholderReview(1)],
    metadata: { ...meta, phase: "implement", agentType: "Developer" },
  };

  // Collect every non-Merge task id so Merge can wait for all of them.
  // Implement contributes itself; each Review_i contributes its placeholder.
  const mergeBlockedBy: string[] = [PLACEHOLDER_IMPLEMENT];
  const tasks: TaskSpec[] = [implement];

  for (let i = 1; i <= max_fix_iterations; i++) {
    const isLastReview = i === max_fix_iterations;
    const reviewId = placeholderReview(i);
    // GC-2026-verdict-states-and-dynamic-cascade: Review_{i+1} is blocked
    // by Review_i directly. The Fix task (when created on demand) ALSO
    // blocks Review_{i+1}; the cascade handler adds that edge after
    // creating Fix_i. So Review_{i+1}.blockedBy at creation = [Review_i];
    // after a Fix_i dispatch it's [Review_i, Fix_i].
    const reviewBlockedBy = i === 1 ? [PLACEHOLDER_IMPLEMENT] : [placeholderReview(i - 1)];
    const reviewBlocks = isLastReview
      ? [PLACEHOLDER_MERGE]
      : [placeholderReview(i + 1), PLACEHOLDER_MERGE];

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

/**
 * GC-2026-verdict-states-and-dynamic-cascade: build a Fix task spec on
 * demand when a Review completes with verdict=NEEDS_WORK. Called from
 * `subscribeWorkflow`'s cascade handler after parsing the Review verdict.
 *
 * The Fix task is bound to the originating review's real task id
 * (`blockedBy: [reviewTaskId]`) so the cascade releases it after the
 * review. The handler also adds `Fix → Review_{i+1}` as a blockedBy edge
 * on Review_{i+1} so the chain pauses for the fix.
 *
 * @param goal           the workflow goal (for scope / anti_goals / branch)
 * @param iteration      1-based Fix iteration number (1..max_fix_iterations)
 * @param worktreePath   absolute worktree path (same as Implement uses)
 * @param branch         git branch name (same as Implement uses)
 * @param reviewTaskId   the real task id of the Review that requested this Fix
 * @param nextReviewId   the real task id of Review_{iteration+1} to wire the edge to
 *                       (undefined when this is the iteration AFTER the last
 *                        review — see workflow-handler for the cap)
 * @param workflow_run_goal_id  metadata stamp (matches static-graph tasks)
 */
export function buildFixTaskSpec(args: {
  goal: WorkflowGoal;
  iteration: number;
  worktreePath: string;
  branch: string;
  reviewTaskId: string;
  nextReviewId?: string;
  workflow_run_goal_id: string;
}): TaskSpec {
  const { goal, iteration, worktreePath, branch, reviewTaskId, nextReviewId, workflow_run_goal_id } = args;
  const blocks = nextReviewId ? [nextReviewId, PLACEHOLDER_MERGE] : [PLACEHOLDER_MERGE];
  return {
    subject: `Fix ${iteration}: ${goal.title}`,
    description: fixDescription(goal, iteration, worktreePath, branch),
    // GC-2026-prompt-parser-contract-cleanup + GC-2026-verdict-states-and-dynamic-cascade
    // follow-up: dispatch with the lean Fix agent type so DEVELOPER_FIX_PROMPT
    // is selected instead of the full DEVELOPER_PROMPT. The dispatch handler
    // looks up `Fix` in DEFAULT_AGENTS.
    agentType: "Fix",
    blockedBy: [reviewTaskId],
    blocks,
    metadata: {
      workflow_run_goal_id,
      phase: "fix",
      iteration,
      agentType: "Fix",
    },
  };
}

/**
 * GC-2026-verdict-states-and-dynamic-cascade: build a fresh Implement task
 * spec when a Review reports verdict=NEEDS_REDESIGN. The new Implement
 * gets a synthetic subject (`Implement (redesign N): <title>`) so the
 * task graph UI shows it as a separate dispatch. blockedBy: [reviewTaskId]
 * so the cascade waits for the review; blocks: [Review_1 placeholder,
 * Merge placeholder] so the new chain eventually funnels into Merge.
 *
 * The handler is responsible for adding the new implement's real task id
 * to Review_1's `blockedBy` list (resetting the chain).
 */
export function buildRedesignImplementTaskSpec(args: {
  goal: WorkflowGoal;
  redesignNumber: number;
  worktreePath: string;
  branch: string;
  reviewTaskId: string;
  workflow_run_goal_id: string;
}): TaskSpec {
  const { goal, redesignNumber, worktreePath, branch, reviewTaskId, workflow_run_goal_id } = args;
  return {
    subject: `Implement (redesign ${redesignNumber}): ${goal.title}`,
    description: implementDescription(goal, worktreePath),
    agentType: "Developer",
    blockedBy: [reviewTaskId],
    blocks: [placeholderReview(1), PLACEHOLDER_MERGE],
    metadata: {
      workflow_run_goal_id,
      phase: "implement",
      iteration: redesignNumber,
      agentType: "Developer",
      isRedesign: true,
    },
  };
}

/**
 * phase-prompts.ts — Build the prompt that each workflow phase sends to its
 * subagent (Implement / Review / Fix / Merge).
 *
 * Lifted from path A's `pi-orchestrator/src/workflow-run.ts:537-651` with the
 * `<repo>` literal replaced by the absolute `worktreePath` argument. Path A
 * embedded `<repo>` as a placeholder that never got substituted and leaked
 * into the agent's prompt verbatim — every prompt must therefore receive a
 * real absolute path now, never a placeholder string.
 */

import type { Finding } from "./verdict-parser.js";
import type { WorkflowGoal } from "./workflow-graph.js";

export function implementPrompt(goal: WorkflowGoal, worktreePath: string): string {
  return [
    `# Goal: ${goal.title}`,
    ``,
    `## Intent`,
    goal.rationale ? goal.rationale : "(no rationale)",
    ``,
    `## Scope (include)`,
    ...goal.scope.include.map((s) => `- ${s}`),
    ``,
    `## Scope (exclude)`,
    ...goal.scope.exclude.map((s) => `- ${s}`),
    ``,
    `## Anti-goals`,
    ...goal.anti_goals.map((a) => `- ${a}`),
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

export function reviewPrompt(
  goal: WorkflowGoal,
  iteration: number,
  worktreePath: string,
  branch: string,
  phase: "implement" | "fix",
): string {
  return [
    `# Review phase (${phase} iteration ${iteration})`,
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
    `Run the 5-dimension review (correctness, completeness, scope adherence, anti-goal compliance, documentation). Read .pi/orchestrator/review-${goal.id}-${iteration}.md for the durable evidence trail pattern.`,
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

export function fixPrompt(
  goal: WorkflowGoal,
  iteration: number,
  worktreePath: string,
  branch: string,
  findings: Finding[],
): string {
  const findingsList =
    findings.length > 0
      ? findings.map(
          (f, i) =>
            `${i + 1}. [${f.severity}] ${f.issue}${f.location ? ` (at ${f.location})` : ""}${f.recommendation ? ` — ${f.recommendation}` : ""}`,
        )
      : [`(no findings — Reviewer marked CLEAN, make an empty commit to advance the cascade)`];

  return [
    `# Fix iteration ${iteration} for goal ${goal.title}`,
    ``,
    `## Reviewer findings`,
    ...findingsList,
    ``,
    `## Workspace`,
    `- Worktree: ${worktreePath}`,
    `- Branch: ${branch}`,
    ``,
    `## Process`,
    `1. cd ${worktreePath}`,
    `2. Address each finding. If the list is empty or trivial, mark the worktree as completed with no changes (\`git commit --allow-empty -m "fix: review clean, no changes"\`).`,
    `3. Commit on the branch. typecheck + test must be green.`,
    `4. Final message MUST contain a single fenced \`\`\`yaml block with status / deliverables / commits.`,
  ].join("\n");
}

export function mergePrompt(goal: WorkflowGoal, branch: string, worktreePath: string): string {
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

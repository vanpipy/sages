# Cookbook entry — `decompose_task` vs raw `TaskCreate` × N + `TaskExecute`

## Problem

Post-GC-2026-remove-workflow-run-prod (Q4 2026), the `workflow_run`
one-shot pipeline runner is gone. The orchestrator main agent must
choose between two paths when a user intent or production code change
needs to be broken into a task DAG:

1. **`decompose_task({ user_task_id, specs })`** — a linear chain
   `T1 → T2 → … → TN` with one `R1` Reviewer attached to `T1`.
2. **Raw `TaskCreate` × N + `TaskExecute`** — any DAG shape the LLM
   can describe, including the canonical 4-phase pipeline
   (Implement → Review ⇆ Fix → MergerAdvisor).

Which to pick depends on the work shape, the review gate, and whether
the chain needs to be persisted + audited by the orchestrator.

## Solution

Use the decision recipe below.

## Code

The two paths look like this in practice:

```ts
// Path 1: decompose_task (linear chain, single R1 at head)
decompose_task({
  user_task_id: "23",                       // optional: a /tasks create'd user task id
  specs: [
    { subject: "T1 investigate", description: "..." },
    { subject: "T2 write tests",  description: "..." },
    { subject: "T3 fix",         description: "..." },
  ],
})
// → creates T1, T2, T3, R1 (T1's Reviewer sibling).
// → spawns T1 immediately. T2 spawns when T1 completes. Etc.
// → R1 audits the cumulative state after T1 (then the cascade continues).
// → runs in the host cwd on the active branch (no managed worktree).
```

```ts
// Path 2: raw TaskCreate × N + TaskExecute (the canonical 4-phase shape)
TaskCreate(Implement,   agentType=Developer,      blocks=[Review])
TaskCreate(Review,      agentType=Reviewer,       blockedBy=[Implement], blocks=[Fix, Merge])
TaskCreate(Fix,         agentType=Fix,            blockedBy=[Review])          # spawned dynamically on verdict=NEEDS_WORK
TaskCreate(Merge,       agentType=MergerAdvisor,  blockedBy=[Fix])
TaskExecute([Implement])
// → Builds the same Implement → Review ⇆ Fix → Merge shape that
//   workflow_run used to build. Reviewer can dispatch Fix dynamically
//   on verdict=NEEDS_WORK (capped by the orchestrator's max_fix_iterations
//   you set on the Reviewer task). The LLM owns the DAG.
// → For per-phase managed worktree, stamp `isolation: { goal_id, task_id, mode: "create" }`
//   on the TaskCreate call. The Developer subagent will pick it up.
```

## When to use

| Work shape | Path |
|---|---|
| Linear user-intent chain ("investigate → write tests → verify") | **`decompose_task`** — one R1 at head is enough; the LLM doesn't need a 4-phase review gate per phase |
| Production code change that needs the canonical 4-phase review (Implement → Review ⇆ Fix → Merger) | **Raw `TaskCreate` × N + `TaskExecute`** — the Reviewer's 4-state verdict (`CLEAN` / `NEEDS_WORK` / `NEEDS_REDESIGN` / `NEEDS_CLARIFICATION`) is what triggers Fix dynamically; you need the explicit `blockedBy` graph |
| Fan-out / diamond / conditional DAG (e.g. "try A and B in parallel, merge if both succeed") | **Raw `TaskCreate` × N + `TaskExecute`** — `decompose_task` only does linear chains; the raw DAG is the only path |
| User asked a question in chat, no production change needed | **No task graph** — just chat-answer; the orchestrator's `before_agent_start` intent reminder handles the intent task lifecycle |
| The LLM needs to inspect a single repo file (read-only) | **No task graph** — use `Explore` subagent directly via `Agent({ subagent_type: "Explore" })` |

## When NOT to use

- **Don't use `decompose_task` for a 4-phase review pipeline.** It only
  attaches ONE `R1` Reviewer at the chain head; the per-phase 4-state
  verdict + auto-Fix loop is a `TaskCreate`-only shape.
- **Don't use raw `TaskCreate` × N for a simple 3-step "investigate →
  fix → verify" sequence.** The per-phase Reviewer overhead is not
  worth it; `decompose_task` keeps the LLM's mental model simple.
- **Don't try to recreate `workflow_run` as a 5-task raw DAG.** The
  `workflow_run` ergonomics (auto-Fix loop, NEEDS_REDESIGN budget,
  NEEDS_CLARIFICATION pause) are now `Reviewer` subagent features,
  not pipeline-runner features. If you need those behaviors, make
  sure your `Reviewer` task's `description` includes the relevant
  constraints (`max_fix_iterations`, `worktree_path`, `branch`,
  `phase`).
- **Don't add a `Merge` phase to a `decompose_task` chain.** The R1
  Reviewer is the chain's audit gate; the LLM manually dispatches
  `MergerAdvisor` (via `Agent({ subagent_type: "MergerAdvisor" })`)
  after the chain completes.

## See also

- `pi-orchestrator/skills/orchestrator/SKILL.md` — the orchestrator
  playbook (post-GC-2026-remove-workflow-run-prod).
- `pi-subagents/src/agent-prompts/reviewer.ts` — the Reviewer subagent's
  5-dim review + 4-state verdict contract.
- `pi-subagents/src/agent-prompts/merger-advisor.ts` — the
  `MergerAdvisor` subagent's advisory-merge contract.
- `pi/docs/postmortem/GC-2026-remove-workflow-run-prod.md` — the
  full removal writeup.

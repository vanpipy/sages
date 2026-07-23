<!--
Response Template: goal-intake

Used by orchestrator when user input is vague or needs clarification
before Stage 1 (goal_contract_create).
-->

## I understand you want to: [1-sentence reframing of user's intent]

Before I lock in the goal contract (Stage 1) and decompose into a task DAG (Stage 2), let me make sure I understand correctly.

### My draft goal

| Field | Value |
|-------|-------|
| **Title** | [≤120 chars] |
| **Type** | [refactor / new-feature / bug-fix / add-tests / migration / exploration] |
| **Scope** | [1-2 sentence problem statement] |
| **Effort estimate** | [S/M/L based on apparent scope] |

### Proposed Success Criteria (need your confirmation)

| ID | What success looks like | How I'll verify |
|----|-------------------------|-----------------|
| SC1 | [binary criterion] | `[verification_cmd]` |
| SC2 | [binary criterion] | `[verification_cmd]` |
| SC3 | [binary criterion] | `[verification_cmd]` |
| ... | ... | ... |

### Out of scope (explicit anti-goals)

- [things I will NOT do]
- [things I will NOT touch]

### Questions for you (if any)

[Only ask if there's genuine ambiguity. Otherwise say "ready to start".]

1. [Specific question with 2-3 options if possible]
2. [Specific question]

### If everything looks right

Reply **"start"** and I'll proceed:
- Stage 1: `goal_contract_create` (saves to `.pi/orchestrator/goal-{id}.yaml`)
- Stage 2: `dag_synthesize` (saves to `.pi/orchestrator/dag-{id}.yaml`)
- Stage 3: `task_dispatch` (executes batches in parallel)
- Stage 4: `orchestrator_audit` (verifies everything)

Each batch's report appears here as it completes.
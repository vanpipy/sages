<!--
Response Template: progress-update

Used by orchestrator to report batch completion / overall progress to user.
-->

## Progress Update — Batch [N] / [Total]

[✓/◐/⏸] [N tasks completed / N] | [X tokens used] | [Y min elapsed]

### Completed in this batch

| Task | Status | Outcome |
|------|--------|---------|
| [task_id] | ✓ COMPLETED | [1-line summary] |
| [task_id] | ✗ FAILED | [error reason] |
| [task_id] | ◐ IN PROGRESS | [waiting on X] |

### Audit result

[If orchestrator_audit ran for this batch:]
- Verdict: [PASS / REVISE / REJECT]
- Score: [N/100]
- Top finding: [if any]

### Next batch (preview)

Tasks ready to dispatch: [task_ids]

[If there are concerns:]
⚠️ Concerns:
- [concern that may need user input]

### Continue?

Auto-proceeding to next batch in [auto-mode / step-mode].
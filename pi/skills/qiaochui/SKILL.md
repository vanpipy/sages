---
description: Review draft and create task plan
---

# QiaoChui (巧倕) - Technical Expert ☳

## Mode Indicator

Show current mode in system prompt:

```
**Review Mode** (Read-Only)
- Only read: draft.md
- Use qiaochui-review to analyze
```

## Commands

| Command | Description |
|---------|-------------|
| `qiaochui-review` | Review draft, set score in state.json |
| `qiaochui-decompose` | Create plan.md and execution.yaml |

## Review Mode Rules

- ✅ Read draft.md
- ❌ No file modifications during review

## qiaochui-review

### Process

1. Validate draft structure
2. Analyze each MDD plane
3. Identify risks
4. Calculate score (0-100)

### Score Threshold

| Score | Action |
|-------|--------|
| > 80 | ✅ Can proceed to plan |
| 50-80 | ⚠️ Revise draft |
| < 50 | ❌ Major gaps |

### Output

```json
{
  "verdict": "APPROVED | REVISE | REJECTED",
  "score": 85,
  "plane_scores": {...},
  "risks": [...],
  "blockers": []
}
```

## qiaochui-decompose

### Prerequisites

- qiaochui-review completed
- score > 80

### Creates

- `plan.md` - Task descriptions
- `execution.yaml` - Task config with dependencies

## Plan Mode Indicator

After decompose:

```
**Plan Mode** (Read-Only)
- Only modify: plan.md, execution.yaml
- Use /fuxi-plan to proceed
```

## Prohibited

- ❌ Decompose without review
- ❌ Decompose if score ≤ 80
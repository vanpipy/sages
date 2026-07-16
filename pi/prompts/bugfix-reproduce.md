# Reproduce Stage Prompt (Bugfix Workflow)

You are **Fuxi (伏羲)** in the bugfix workflow, responsible for reproducing the bug.

## Task

Write a minimal reproduction case in `.sages/workspace/repro.md` so the team can all reproduce the bug.

## repro.md Format

```markdown
# Bug Reproduction: <bug-name>

## Environment
- OS / browser
- Relevant dependency versions
- pi version: 0.79.10

## Steps to Reproduce
1. Step 1
2. Step 2
3. Step 3

## Expected Behavior
Should happen X

## Actual Behavior
Happens Y

## Minimal Reproduction Code
\`\`\`bash
# or TS code
\`\`\`

## Impact Scope
Which functions / users are affected
```

## Simplified Surface (use same 3-tool Fuxi)

```
fuxi_start { plan_name: "bug-<name>", request: "reproduce <bug>" }
fuxi_design {}                                     → returns design sub-phase contract
fuxi_design { observation: { phase: "design", draft_path: "repro.md" } }
   → advances to review (here: QiaoChui confirms reproduction)
fuxi_design { observation: { phase: "review", score: 80 } }
   → advances to plan
```

## After

FSM detects `repro.md` creation and auto-advances to the `fix` stage (LuBan).

## Note

In bugfix workflow, `draft.md` is replaced by `repro.md` and the "plan" sub-phase has slightly different semantics (fix scope), but the surface is the same.
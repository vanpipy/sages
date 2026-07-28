/**
 * pi-evaluator/src/prompts.ts
 *
 * Constants for system-prompt augmentation when reward mode is active.
 *
 * This is the THIRD layer of the 3-layer LLM hint contract (GC-2026-019):
 *   1. Tool description (set in `src/tools/*.ts` at registration time)
 *   2. Skill file (`skills/evaluator/SKILL.md` — auto-loaded by pi)
 *   3. System prompt augmentation (this constant, appended on
 *      `before_agent_start` when `state.mode === "on"`)
 *
 * The content is hand-written; the LLM is supposed to act on it without
 * needing to read the skill file. The skill file is the deep reference.
 */

export const REWARD_MODE_SYSTEM_PROMPT = `## Reward mode active

Two tools are available for self-evaluation of the active Sages workflow:

- **\`eval_score()\`** — Returns the running score and a 5-dimension breakdown
  (goal, dag, implement, audit, coordination) with evidence pointing to the
  specific artifact and location to fix. Call AFTER designing the DAG, after
  writing key task reports, and BEFORE finalizing.

- **\`eval_trend()\`** — Compares the active workflow against historical
  similar workflows. Returns sample_size, trend (UP/DOWN/STABLE /
  INSUFFICIENT_DATA), trend_delta, and percentile by total + per-dimension.
  Call to know whether your current approach is above or below your
  historical baseline.

**Read the \`evidence\` field** in eval_score output. Each entry points to
the exact artifact (e.g. \`goal-GC-2026-018.yaml\`) and location (e.g.
\`SC1\`, \`tasks[1].isolation\`, \`findings[0]\`) that needs fixing — then go
fix it. Both tools take no arguments; they always act on the currently
active Sages workflow.`;

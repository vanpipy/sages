/**
 * Request Classifier — detects "new" vs "improve" mode from request + project context.
 *
 * Used by Fuxi/draft-generator to decide whether to spawn the full MDD harness
 * (greenfield) or a lighter "improve existing" path.
 *
 * Returns:
 *   - mode: "new" | "improve"
 *   - score: 0..1, higher = more overlap with existing code
 *   - signals: human-readable explanations of why this mode was chosen
 */

import type { ProjectContext } from "./analyzer/index.js";

export type RequestMode = "new" | "improve";

export interface ClassificationResult {
  mode: RequestMode;
  score: number;
  signals: string[];
}

/**
 * Threshold above which a request is classified as "improve".
 * Tuned so that 1 strong signal (refactor verb) OR 1 component match is enough.
 * Empty project context (no components) always classifies as "new".
 */
const IMPROVE_THRESHOLD = 0.3;

/**
 * Verbs that strongly indicate modifying existing code.
 */
const IMPROVE_VERBS = [
  "refactor", "restructure", "reorganize",
  "modify", "change", "update", "upgrade",
  "fix", "patch", "repair", "resolve",
  "improve", "enhance", "optimize", "tune",
  "extend", "expand", "augment",
  "add ",  // "add" followed by space → adding to existing, not greenfield
];

/**
 * Phrases that indicate greenfield work, but only if no other signals.
 * These are "soft new" signals — they push toward new but can be overridden.
 */
const NEW_PHRASES = [
  "add new", "create new", "from scratch", "greenfield",
  "brand new", "new module", "new system", "new subsystem",
];

export function classifyRequest(
  ctx: ProjectContext,
  request: string,
): ClassificationResult {
  const signals: string[] = [];
  let score = 0;
  const lowerRequest = request.toLowerCase();

  // 0. Hard "new" signals — these override everything (greenfield intent is explicit)
  const HARD_NEW_PHRASES = ["from scratch", "greenfield", "brand new", "add new", "create new", "new module", "new system", "new subsystem"];
  for (const phrase of HARD_NEW_PHRASES) {
    if (lowerRequest.includes(phrase)) {
      signals.push(`hard-new: "${phrase}"`);
      return { mode: "new", score: 0, signals };
    }
  }

  // 1. Strong improve signal: explicit modify/fix/refactor verbs
  for (const verb of IMPROVE_VERBS) {
    if (lowerRequest.includes(verb)) {
      signals.push(`improve-verb: "${verb.trim()}"`);
      score += 0.5;
    }
  }

  // 2. Component overlap: request mentions an existing component directory
  for (const comp of ctx.existingComponents) {
    if (comp.length < 3) continue; // skip too-short names to avoid false matches
    if (lowerRequest.includes(comp.toLowerCase())) {
      signals.push(`component-overlap: "${comp}"`);
      score += 0.3;
    }
  }

  // 3. Pattern overlap: request references a known pattern (e.g., "async/await")
  for (const pattern of ctx.patterns) {
    const readable = pattern.replace(/^ts-/, "").replace(/^js-/, "").replace(/[-_]/g, " ");
    if (readable.length < 3) continue;
    if (lowerRequest.includes(readable)) {
      signals.push(`pattern-overlap: "${pattern}"`);
      score += 0.2;
    }
  }

  // 4. Empty project context → strongly "new" (nothing to improve)
  if (ctx.existingComponents.length === 0 && ctx.patterns.length === 0) {
    signals.push("empty-project: no existing components or patterns detected");
    score = Math.min(score, 0.1);
  }

  // 5. Soft new signal: only if score is still below threshold
  if (score < IMPROVE_THRESHOLD) {
    const SOFT_NEW_VERBS = ["create", "build", "implement", "introduce", "design"];
    for (const verb of SOFT_NEW_VERBS) {
      if (lowerRequest.includes(verb)) {
        signals.push(`soft-new-verb: "${verb}"`);
        score -= 0.2;
      }
    }
  }

  // Clamp and decide
  score = Math.max(0, Math.min(1, score));
  const mode: RequestMode = score >= IMPROVE_THRESHOLD ? "improve" : "new";

  return { mode, score, signals };
}

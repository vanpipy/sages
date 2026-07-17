/**
 * QiaoChui Types - MDD Plane and Review interfaces
 * 
 * Part of: src/tools/qiaochui/
 * Purpose: Shared type definitions for review and decomposition
 */

/**
 * MDD (Model-Driven Development) Seven Planes
 */
export type MDDPlane =
  | "Business"
  | "Data"
  | "Control"
  | "Foundation"
  | "Observation"
  | "Security"
  | "Evolution";

/**
 * Runtime array of all MDD planes, in canonical order.
 * Single source of truth — review-service and scope-parser both consume this.
 */
export const MDD_PLANES: readonly MDDPlane[] = [
  "Business",
  "Data",
  "Control",
  "Foundation",
  "Observation",
  "Security",
  "Evolution",
] as const;

/**
 * Design complexity tier — declared by the agent in the Scope section.
 * Drives minimum draft size and how strictly the reviewer penalizes
 * out-of-scope planes.
 *
 * - `trivial`:  1 in-scope plane (e.g., a rename, a single config flag)
 * - `simple`:   2-3 in-scope planes (e.g., a small refactor, a bug fix)
 * - `standard`: 4+ in-scope planes (default — full MDD treatment)
 */
export type DesignTier = "trivial" | "simple" | "standard";

/**
 * Min draft size per tier (in bytes).
 * If Scope section is absent, fall back to `standard` size.
 */
export const MIN_DRAFT_BYTES_BY_TIER: Record<DesignTier, number> = {
  trivial: 100,
  simple: 250,
  standard: 500,
};

/**
 * The plane-count band each tier expects.
 * Agent-declared tier vs. actual in-scope count mismatch is a soft warning,
 * not a hard failure.
 */
export const TIER_PLANE_BAND: Record<DesignTier, { min: number; max: number }> = {
  trivial: { min: 1, max: 1 },
  simple: { min: 2, max: 3 },
  standard: { min: 4, max: 7 },
};

/**
 * Parsed Scope section from a draft.md.
 * If absent, `inScope` is `undefined` and the reviewer falls back to
 * legacy "all 7 planes" behavior.
 */
export interface DraftScope {
  tier: DesignTier;
  inScope: MDDPlane[];
  outOfScope: { plane: MDDPlane; reason: string }[];
}

/**
 * Assessment result for a single MDD plane.
 *
 * `inScope` defaults to `true`. When `false`, the plane was declared
 * out-of-scope by the agent; the heuristic still surfaces its contentDepth
 * (for transparency) but excludes it from avgDepth and feasibleCount.
 */
export interface PlaneAssessment {
  plane: MDDPlane;
  status: "✅ Feasible" | "⚠️ Needs Review" | "❌ Not Feasible" | "➖ Out of Scope";
  contentDepth: number; // 0-100
  inScope?: boolean;
  notes: string[];
  risks: string[];
  questions: string[];
  recommendations: string[];
}

/**
 * Deep review result with MDD plane assessments, risks, and implementation estimates
 */
export interface DeepReviewResult {
  overallStatus: "APPROVED" | "REVISE" | "REJECTED";
  score: number; // 0-100
  planeAssessments: PlaneAssessment[];
  risks: { risk: string; impact: "high" | "medium" | "low"; planes: MDDPlane[] }[];
  crossPlaneDependencies: { from: MDDPlane; to: MDDPlane; note: string }[];
  implementationComplexity: "low" | "medium" | "high" | "very-high";
  estimatedHours: number;
  blockers: string[];
  recommendations: string[];
}

/**
 * Task generated from MDD decomposition
 */
export interface MDDTask {
  id: string;
  description: string;
  plane: MDDPlane;
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  files: string[];
}

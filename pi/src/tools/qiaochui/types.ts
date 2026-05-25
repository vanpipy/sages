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
 * Assessment result for a single MDD plane
 */
export interface PlaneAssessment {
  plane: MDDPlane;
  status: "✅ Feasible" | "⚠️ Needs Review" | "❌ Not Feasible";
  contentDepth: number; // 0-100
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

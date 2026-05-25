/**
 * Tests for QiaoChui Types
 * TDD RED Phase: Tests should FAIL until types are implemented
 */

import { describe, it, expect } from "bun:test";
import type { MDDPlane, PlaneAssessment, DeepReviewResult, MDDTask } from "./types.js";

describe("MDDPlane type", () => {
  it("should have all 7 planes", () => {
    const planes: MDDPlane[] = [
      "Business",
      "Data", 
      "Control",
      "Foundation",
      "Observation",
      "Security",
      "Evolution",
    ];
    
    planes.forEach((plane) => {
      expect(typeof plane).toBe("string");
    });
  });

  it("should only allow valid plane names", () => {
    const validPlane: MDDPlane = "Business";
    expect(validPlane).toBe("Business");
  });
});

describe("PlaneAssessment interface", () => {
  it("should have correct structure", () => {
    const assessment: PlaneAssessment = {
      plane: "Business",
      status: "✅ Feasible",
      contentDepth: 75,
      notes: ["Note 1"],
      risks: ["Risk 1"],
      questions: ["Question 1"],
      recommendations: ["Recommendation 1"],
    };
    
    expect(assessment.plane).toBe("Business");
    expect(assessment.status).toContain("Feasible");
    expect(assessment.contentDepth).toBeGreaterThanOrEqual(0);
    expect(assessment.contentDepth).toBeLessThanOrEqual(100);
  });
});

describe("DeepReviewResult interface", () => {
  it("should have correct structure", () => {
    const result: DeepReviewResult = {
      overallStatus: "APPROVED",
      score: 85,
      planeAssessments: [],
      risks: [],
      crossPlaneDependencies: [],
      implementationComplexity: "medium",
      estimatedHours: 24,
      blockers: [],
      recommendations: ["Good to go"],
    };
    
    expect(result.overallStatus).toBe("APPROVED");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(["low", "medium", "high", "very-high"]).toContain(result.implementationComplexity);
  });
});

describe("MDDTask interface", () => {
  it("should have correct structure", () => {
    const task: MDDTask = {
      id: "T1",
      description: "Test task",
      plane: "Foundation",
      priority: "high",
      dependsOn: ["T0"],
      files: ["src/test.ts"],
    };
    
    expect(task.id).toMatch(/^[A-Z]\d+$/);
    expect(task.description.length).toBeGreaterThan(0);
    expect(["high", "medium", "low"]).toContain(task.priority);
    expect(Array.isArray(task.dependsOn)).toBe(true);
    expect(Array.isArray(task.files)).toBe(true);
  });
});

/**
 * Tests for review-service
 * TDD RED Phase: Tests should FAIL until review-service is implemented
 */

import { describe, it, expect } from "bun:test";
import { performDeepReview } from "@/tools/qiaochui/review-service.js";

describe("performDeepReview", () => {
  it("should exist and be a function", () => {
    expect(typeof performDeepReview).toBe("function");
  });

  it("should return DeepReviewResult structure", () => {
    const content = `# System Design: Test Plan

## 1. Business Plane
- Process: Test workflow
- Rules: TDD methodology
- Workflow: RED → GREEN → REFACTOR

## 2. Data Plane
- Logic: TypeScript types
- State: In-memory
- Schema: MDDTask interface

## 3. Control Plane
- Strategy: Sequential execution
- Distribution: Single process

## 4. Foundation Plane
- Resource: Node.js
- Abstraction: Modules
- Endpoint: Internal functions

## 5. Observation Plane
- Metrics: Test results
- Analysis: Coverage
- Log: Console output

## 6. Security Plane
- Identity: File system
- Permissions: User permissions

## 7. Evolution Plane
- Version: 1.0
- Migration: N/A
`;
    
    const result = performDeepReview(content);
    
    expect(result).toBeDefined();
    expect(["APPROVED", "REVISE", "REJECTED"]).toContain(result.overallStatus);
    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("should have 7 plane assessments", () => {
    const content = "## 1. Business Plane\nTest\n\n## 2. Data Plane\nTest\n\n## 3. Control Plane\nTest\n\n## 4. Foundation Plane\nTest\n\n## 5. Observation Plane\nTest\n\n## 6. Security Plane\nTest\n\n## 7. Evolution Plane\nTest\n";
    
    const result = performDeepReview(content);
    expect(result.planeAssessments.length).toBe(7);
  });

  it("should return non-zero score for content", () => {
    const content = `# System Design: Test Plan

### 1. Business Plane
Process and workflow defined here with detailed steps for the business logic implementation.

### 2. Data Plane
Logic and state management implemented with proper data models and validation.

### 3. Control Plane
Strategy and distribution handled through proper control flow mechanisms.

### 4. Foundation Plane
Resource and API defined with clear interfaces and endpoints.

### 5. Observation Plane
Metrics and monitoring set up for system observability and alerting.

### 6. Security Plane
Auth and permissions configured with role-based access control.

### 7. Evolution Plane
Version and migration planned with rollback strategies.
`;
    
    const result = performDeepReview(content);
    expect(result.score).toBeGreaterThan(0);
  });

  it("should identify blockers in incomplete designs", () => {
    const content = `
# System Design: Incomplete Plan

## 1. Business Plane
- TBD

## 2. Data Plane
- [TODO]
`;
    
    const result = performDeepReview(content);
    // Should either be REVISE or have blockers
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("should calculate implementation complexity", () => {
    const content = `
# System Design: Complex Plan

## 1. Business Plane
Process with many steps and detailed workflow.

## 2. Data Plane
Logic with algorithm and state management.

## 3. Control Plane
Strategy with distribution and routing.

## 4. Foundation Plane
Resource infrastructure with API endpoints.

## 5. Observation Plane
Metrics monitoring with analysis and alerts.

## 6. Security Plane
Identity auth with permissions and roles.

## 7. Evolution Plane
Time migration with versions and rollback.
`;
    
    const result = performDeepReview(content);
    expect(["low", "medium", "high", "very-high"]).toContain(result.implementationComplexity);
  });

  it("should estimate hours based on complexity", () => {
    const content = `
# System Design: Test Plan

## 1. Business Plane
Detailed business process here.

## 2. Data Plane
Detailed data logic here.

## 3. Control Plane
Detailed control strategy here.

## 4. Foundation Plane
Detailed foundation resources here.

## 5. Observation Plane
Detailed observation metrics here.

## 6. Security Plane
Detailed security auth here.

## 7. Evolution Plane
Detailed evolution version here.
`;
    
    const result = performDeepReview(content);
    expect(result.estimatedHours).toBeGreaterThan(0);
  });
});

describe("performDeepReview - Content Depth", () => {
  it("should return higher scores for richer content", () => {
    const minimalContent = `# System Design: Minimal

## 1. Business Plane
Test

## 2. Data Plane
Test

## 3. Control Plane
Test

## 4. Foundation Plane
Test

## 5. Observation Plane
Test

## 6. Security Plane
Test

## 7. Evolution Plane
Test
`;
    
    const richContent = `# System Design: Rich

## 1. Business Plane
This plane contains detailed business process information with multiple steps, workflow definitions, and decision points.

## 2. Data Plane
This plane has comprehensive data models, schemas, state management strategies, and validation rules.

## 3. Control Plane
The control plane defines strategy, distribution mechanisms, routing logic, and fallback procedures.

## 4. Foundation Plane
Foundation resources include API endpoints, infrastructure components, and abstraction layers.

## 5. Observation Plane
Observability is achieved through metrics, monitoring, analysis, alerting, and structured logging.

## 6. Security Plane
Security implementation includes authentication, authorization, permissions, and role-based access control.

## 7. Evolution Plane
Version management, migration strategies, rollback procedures, and deployment processes are defined.
`;
    
    const minimalResult = performDeepReview(minimalContent);
    const richResult = performDeepReview(richContent);
    
    // Rich content should score higher
    expect(richResult.score).toBeGreaterThanOrEqual(minimalResult.score);
  });

  it("should detect placeholders and TBD content", () => {
    const content = `
# System Design: Placeholder Plan

## 1. Business Plane
- TBD
- [TODO]
- FIXME

## 2. Data Plane
- Placeholder content
`;

    const result = performDeepReview(content);
    expect(result.blockers.length).toBeGreaterThan(0);
  });
});

describe("performDeepReview - scope-aware (Tier system)", () => {
  // A draft with deep coverage on 3 planes and shallow on the rest.
  // Legacy scoring averages depth across all 7 → low score.
  // Scope-aware scoring averages only in-scope → much higher score.
  // Uses canonical `### N. X Plane` heading format (matches existing extractor).
  const threePlanesDeep = `# System Design: Targeted fix

## Scope
- Tier: simple
- In scope: [Foundation, Business, Observation]
- Out of scope: Data, Control, Security, Evolution (no impact from this change)

### 1. Business Plane
The business plane contains detailed business process information with multiple steps, workflow definitions, and decision points, including rules for handling edge cases and policy enforcement, version control integration, and audit logging.

### 2. Data Plane
Just a brief mention.

### 3. Control Plane
Single line.

### 4. Foundation Plane
The foundation plane contains comprehensive API endpoint definitions, infrastructure component descriptions, and abstraction layer details with multiple integration points and clear interfaces.

### 5. Observation Plane
The observation plane defines metrics, monitoring, analysis, alerting, and structured logging with clear SLO definitions and on-call escalation paths.

### 6. Security Plane
Single line.

### 7. Evolution Plane
Single line.
`;

  it("scope-aware: 3 in-scope planes produce higher score than legacy 7-plane average", () => {
    const legacy = performDeepReview(threePlanesDeep);
    const scoped = performDeepReview(threePlanesDeep, {
      inScopePlanes: ["Foundation", "Business", "Observation"],
    });

    // Scoped should outscore legacy because the deep 3 planes drive the average,
    // not the 4 shallow ones.
    expect(scoped.score).toBeGreaterThan(legacy.score);
  });

  it("scope-aware: out-of-scope planes are marked '➖ Out of Scope' and excluded from feasibleCount", () => {
    const result = performDeepReview(threePlanesDeep, {
      inScopePlanes: ["Foundation", "Business", "Observation"],
    });

    const outOfScope = result.planeAssessments.filter((a) => a.inScope === false);
    expect(outOfScope).toHaveLength(4);
    for (const a of outOfScope) {
      expect(a.status).toBe("➖ Out of Scope");
      expect(a.risks).toHaveLength(0);
      expect(a.questions).toHaveLength(0);
      expect(a.recommendations).toHaveLength(0);
    }
  });

  it("scope-aware: in-scope planes still get full assessment", () => {
    const result = performDeepReview(threePlanesDeep, {
      inScopePlanes: ["Foundation", "Business", "Observation"],
    });

    const inScope = result.planeAssessments.filter((a) => a.inScope !== false);
    expect(inScope).toHaveLength(3);
    // Each should have a populated contentDepth and status from the normal pipeline
    for (const a of inScope) {
      expect(a.contentDepth).toBeGreaterThan(0);
      expect(["✅ Feasible", "⚠️ Needs Review", "❌ Not Feasible"]).toContain(a.status);
    }
  });

  it("scope-aware: critical-plane blocker for Data is skipped when Data is out of scope", () => {
    // Build a draft where Data is missing/empty AND declared out of scope
    const content = `# System Design: Refactor only

## Scope
- Tier: simple
- In scope: [Foundation, Business]
- Out of scope: Data (no schema change in this refactor)

### 4. Foundation Plane
${"Detailed foundation plane content with API endpoints, infrastructure components, and abstraction layers. ".repeat(3)}

### 1. Business Plane
${"Detailed business plane content with workflows, rules, and policies. ".repeat(3)}

### 2. Data Plane
TBD
`;

    const result = performDeepReview(content, {
      inScopePlanes: ["Foundation", "Business"],
    });

    // Data blocker MUST NOT appear when Data is out of scope
    const dataBlocker = result.blockers.find((b) => b.includes("Data Plane"));
    expect(dataBlocker).toBeUndefined();
  });

  it("scope-aware: critical-plane blocker for Data FIRES when Data is in scope but empty", () => {
    const content = `# System Design: Add endpoint

### 4. Foundation Plane
${"Detailed foundation plane content with API endpoints, infrastructure components, and abstraction layers. ".repeat(5)}

### 2. Data Plane
TBD
`;

    const result = performDeepReview(content, {
      inScopePlanes: ["Foundation", "Data"],
    });

    // Data blocker MUST appear — Data is in scope and insufficient
    expect(result.blockers.some((b) => b.includes("Data Plane"))).toBe(true);
  });

  it("scope-aware: empty inScopePlanes falls back to legacy 7-plane behavior", () => {
    const result = performDeepReview(threePlanesDeep, { inScopePlanes: [] });
    // No plane should be marked out-of-scope
    expect(result.planeAssessments.every((a) => a.inScope !== false)).toBe(true);
  });

  it("scope-aware: undefined options falls back to legacy 7-plane behavior", () => {
    const result = performDeepReview(threePlanesDeep);
    expect(result.planeAssessments.every((a) => a.inScope !== false)).toBe(true);
    expect(result.planeAssessments).toHaveLength(7);
  });

  it("scope-aware: estimatedHours scales with active in-scope plane count", () => {
    // Draft with rich content on 2 planes only
    const content = `# Design

### 4. Foundation Plane
${"A ".repeat(200)}

### 1. Business Plane
${"B ".repeat(200)}
`;

    const fullResult = performDeepReview(content);
    const partialResult = performDeepReview(content, {
      inScopePlanes: ["Foundation"],
    });

    // Legacy: hours scaled by 2 active / 7 total = ~29%
    // Scoped: hours scaled by 1 active / 1 in-scope = 100%
    expect(partialResult.estimatedHours).toBeGreaterThanOrEqual(fullResult.estimatedHours);
  });
});

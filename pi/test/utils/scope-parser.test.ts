/**
 * Tests for scope-parser (Scope section extraction from draft.md)
 *
 * Covers:
 *  - Happy path: well-formed Scope section with all fields
 *  - Tier validation against plane-count band
 *  - Edge cases: missing Scope, partial Scope, malformed input
 *  - Backward compat: legacy drafts without Scope return null
 */

import { describe, it, expect } from "bun:test";
import {
  parseScopeSection,
  validateTierVsScope,
} from "@/utils/scope-parser.js";

describe("parseScopeSection", () => {
  it("returns null when draft has no Scope section (backward compat)", () => {
    const content = `# System Design: Foo

## 1. Business Plane
Process and rules defined here.

## 2. Data Plane
Logic and state defined here.
`;
    expect(parseScopeSection(content)).toBeNull();
  });

  it("returns null when Scope heading exists but body is empty", () => {
    const content = `# System Design: Foo

## Scope
`;
    expect(parseScopeSection(content)).toBeNull();
  });

  it("parses a trivial-tier Scope with 1 in-scope plane", () => {
    const content = `# System Design: Rename

## Scope
- Tier: trivial
- In scope: [Foundation]
- Out of scope: Business (rename only affects signature)

## 1. Foundation Plane
Rename \`processOrder\` to \`handleOrder\` across 3 files.
`;
    const scope = parseScopeSection(content);
    expect(scope).not.toBeNull();
    expect(scope!.tier).toBe("trivial");
    expect(scope!.inScope).toEqual(["Foundation"]);
    expect(scope!.outOfScope).toEqual([
      { plane: "Business", reason: "rename only affects signature" },
    ]);
  });

  it("parses a simple-tier Scope with 3 in-scope planes", () => {
    const content = `# System Design: Bug fix

## Scope
- Tier: simple
- In scope: [Foundation, Business, Observation]
- Out of scope (justified): Data (no schema change),
  Control (no flow change), Security (no auth change)

## 1. Foundation Plane
`;
    const scope = parseScopeSection(content);
    expect(scope).not.toBeNull();
    expect(scope!.tier).toBe("simple");
    expect(scope!.inScope).toEqual(["Foundation", "Business", "Observation"]);
    expect(scope!.outOfScope.map((o) => o.plane)).toEqual([
      "Data",
      "Control",
      "Security",
    ]);
    expect(scope!.outOfScope[0].reason).toBe("no schema change");
  });

  it("parses a standard-tier Scope with all 7 planes in scope", () => {
    const content = `# System Design: New feature

## Scope
- Tier: standard
- In scope: [Business, Data, Control, Foundation, Observation, Security, Evolution]

## 1. Business Plane
`;
    const scope = parseScopeSection(content);
    expect(scope).not.toBeNull();
    expect(scope!.tier).toBe("standard");
    expect(scope!.inScope).toHaveLength(7);
  });

  it("ignores unknown plane names in In scope list", () => {
    const content = `# System Design: Foo

## Scope
- Tier: simple
- In scope: [Foundation, BogusPlane, Business]
`;
    const scope = parseScopeSection(content);
    expect(scope!.inScope).toEqual(["Foundation", "Business"]);
    expect(scope!.inScope).not.toContain("BogusPlane");
  });

  it("ignores unknown plane names in Out of scope list", () => {
    const content = `# System Design: Foo

## Scope
- Tier: simple
- In scope: [Foundation]
- Out of scope: BogusPlane (made up), Data (no schema change)
`;
    const scope = parseScopeSection(content);
    expect(scope!.outOfScope.map((o) => o.plane)).toEqual(["Data"]);
  });

  it("accepts tier in any case (case-insensitive)", () => {
    const content = `# Design

## Scope
- Tier: STANDARD
- In scope: [Foundation]
`;
    expect(parseScopeSection(content)!.tier).toBe("standard");
  });

  it("rejects invalid tier value", () => {
    const content = `# Design

## Scope
- Tier: huge
- In scope: [Foundation]
`;
    expect(parseScopeSection(content)).toBeNull();
  });

  it("accepts 'In scope' value without brackets", () => {
    const content = `# Design

## Scope
- Tier: simple
- In scope: Foundation, Business, Control
`;
    expect(parseScopeSection(content)!.inScope).toEqual([
      "Foundation",
      "Business",
      "Control",
    ]);
  });

  it("extracts Scope section that appears AFTER other content (not just at top)", () => {
    const content = `# Design

## Overview
Some overview text.

## Scope
- Tier: trivial
- In scope: [Foundation]

## 1. Foundation Plane
Details here.
`;
    expect(parseScopeSection(content)).not.toBeNull();
  });

  it("stops extracting Scope at next ## heading", () => {
    const content = `# Design

## Scope
- Tier: trivial
- In scope: [Foundation]

## 1. Foundation Plane
- Tier: this should be ignored as plane content
`;
    const scope = parseScopeSection(content);
    expect(scope!.tier).toBe("trivial");
    expect(scope!.inScope).toEqual(["Foundation"]);
  });
});

describe("validateTierVsScope", () => {
  it("returns null when scope has 1 plane and tier is trivial (OK)", () => {
    const scope = { tier: "trivial" as const, inScope: ["Foundation"] as const, outOfScope: [] };
    expect(validateTierVsScope(scope as any)).toBeNull();
  });

  it("returns null when scope has 3 planes and tier is simple (OK)", () => {
    const scope = {
      tier: "simple" as const,
      inScope: ["Foundation", "Business", "Evolution"] as const,
      outOfScope: [],
    };
    expect(validateTierVsScope(scope as any)).toBeNull();
  });

  it("returns warning when trivial tier has 2+ planes", () => {
    const scope = {
      tier: "trivial" as const,
      inScope: ["Foundation", "Business"] as const,
      outOfScope: [],
    };
    const warn = validateTierVsScope(scope as any);
    expect(warn).toContain("Tier 'trivial'");
    expect(warn).toContain("≤ 1");
  });

  it("returns warning when simple tier has 1 plane", () => {
    const scope = {
      tier: "simple" as const,
      inScope: ["Foundation"] as const,
      outOfScope: [],
    };
    const warn = validateTierVsScope(scope as any);
    expect(warn).toContain("Tier 'simple'");
    expect(warn).toContain("≥ 2");
  });

  it("returns warning when standard tier has only 2 planes", () => {
    const scope = {
      tier: "standard" as const,
      inScope: ["Foundation", "Business"] as const,
      outOfScope: [],
    };
    const warn = validateTierVsScope(scope as any);
    expect(warn).toContain("Tier 'standard'");
    expect(warn).toContain("≥ 4");
  });

  it("returns null when standard tier has all 7 planes (OK)", () => {
    const scope = {
      tier: "standard" as const,
      inScope: [
        "Business",
        "Data",
        "Control",
        "Foundation",
        "Observation",
        "Security",
        "Evolution",
      ] as const,
      outOfScope: [],
    };
    expect(validateTierVsScope(scope as any)).toBeNull();
  });
});
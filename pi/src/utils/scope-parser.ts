/**
 * Scope Parser — extracts the ## Scope section from draft.md
 *
 * Format (markdown):
 *
 *   ## Scope
 *   - Tier: trivial | simple | standard
 *   - In scope: [Foundation, Business, Evolution]
 *   - Out of scope (justified): Data (no schema change), Control (no flow change),
 *     Observation (no new metrics), Security (no auth change)
 *
 * Parsing rules:
 *  - Tier is required if the section is present.
 *  - In-scope plane names must be in the MDD_PLANES set; unknown names are ignored.
 *  - Out-of-scope entries are `<Plane> (<reason>)`; reason is optional.
 *  - If the section is missing, returns `null` and callers fall back to legacy behavior.
 */

import {
  MDD_PLANES,
  TIER_PLANE_BAND,
  type DesignTier,
  type DraftScope,
  type MDDPlane,
} from "../tools/qiaochui/types.js";

const VALID_TIERS: readonly DesignTier[] = ["trivial", "simple", "standard"];

const SCOPE_HEADING = /^##\s*Scope\s*$/im;

/**
 * Try to parse a Scope section from the draft content.
 *
 * Returns `null` if no Scope section is found — callers MUST treat this as
 * "agent did not opt into scope-driven design" and apply legacy behavior.
 */
export function parseScopeSection(content: string): DraftScope | null {
  if (!SCOPE_HEADING.test(content)) return null;

  // Extract the Scope section (until next ## heading or end of content)
  const scopeStart = content.search(SCOPE_HEADING);
  const afterHeading = content.slice(scopeStart).split("\n");
  // Drop the heading line itself
  afterHeading.shift();
  const sectionLines: string[] = [];
  for (const line of afterHeading) {
    if (/^##\s+/.test(line)) break;
    sectionLines.push(line);
  }
  const section = sectionLines.join("\n");

  // Tier
  const tierMatch = section.match(/^\s*-\s*Tier\s*:\s*(\w+)/im);
  if (!tierMatch) return null;
  const rawTier = tierMatch[1].toLowerCase();
  if (!VALID_TIERS.includes(rawTier as DesignTier)) return null;
  const tier = rawTier as DesignTier;

  // In scope: parse "[Plane1, Plane2, ...]" or "- In scope: Plane1, Plane2, ..."
  const inScopeMatch = section.match(/^\s*-\s*In\s+scope\s*:\s*(.+)$/im);
  if (!inScopeMatch) return null;
  const inScopeList = inScopeMatch[1]
    .replace(/^\[|\]$/g, "") // strip surrounding brackets
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((name): name is MDDPlane =>
      (MDD_PLANES as readonly string[]).includes(name),
  );

  // Out of scope: parse each line "- Out of scope (...): Plane1 (reason), Plane2 (reason), ..."
  // Continuation lines (indented, no leading "-") are joined to the previous line.
  const outOfScope: { plane: MDDPlane; reason: string }[] = [];
  const rawLines = section.split("\n");
  const grouped: string[] = [];
  for (const line of rawLines) {
    if (/^\s*-\s*Out\s+of\s+scope/i.test(line)) {
      grouped.push(line);
    } else if (grouped.length > 0 && /^\s+\S/.test(line)) {
      // Continuation of previous out-of-scope entry
      grouped[grouped.length - 1] += " " + line.trim();
    }
  }

  for (const line of grouped) {
    // Strip "- Out of scope (...) :" prefix if present
    const stripped = line.replace(/^\s*-\s*Out\s+of\s+scope[^:]*:\s*/i, "");
    // Split by comma, respecting nested parens
    const entries = stripped
      .split(/,(?![^()]*\))/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const entry of entries) {
      const m = entry.match(/^(\w+)\s*(?:\(([^)]+)\))?\s*$/);
      if (!m) continue;
      const plane = m[1] as MDDPlane;
      if (!(MDD_PLANES as readonly string[]).includes(plane)) continue;
      outOfScope.push({ plane, reason: m[2]?.trim() ?? "" });
    }
  }

  return { tier, inScope: inScopeList, outOfScope };
}

/**
 * Validate that a declared tier matches the actual in-scope plane count.
 *
 * Returns a soft warning string if mismatched, `null` if OK.
 * Intended for surfacing in the design contract, not for hard rejection.
 */
export function validateTierVsScope(scope: DraftScope): string | null {
  const band = TIER_PLANE_BAND[scope.tier];
  const n = scope.inScope.length;
  if (n < band.min) {
    return `Tier '${scope.tier}' expects ≥ ${band.min} in-scope plane(s), but found ${n}.`;
  }
  if (n > band.max) {
    return `Tier '${scope.tier}' expects ≤ ${band.max} in-scope plane(s), but found ${n}.`;
  }
  return null;
}

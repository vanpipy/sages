/**
 * Review Service - MDD Plane Analysis
 * 
 * Part of: src/tools/qiaochui/
 * Purpose: Perform deep MDD-aligned plane review on draft content
 */

import type { MDDPlane, PlaneAssessment, DeepReviewResult } from "./types.js";

/**
 * MDD Planes for task classification
 */
const MDD_PLANES: MDDPlane[] = [
  "Business",
  "Data",
  "Control",
  "Foundation",
  "Observation",
  "Security",
  "Evolution",
];

/**
 * Plane number mapping for content extraction
 */
const PLANE_NUMBERS: Record<string, string> = {
  "Business": "1",
  "Data": "2",
  "Control": "3",
  "Foundation": "4",
  "Observation": "5",
  "Security": "6",
  "Evolution": "7",
};

/**
 * Perform DEEP MDD-aligned plane review
 * Analyzes content depth, identifies risks, validates dependencies
 * 
 * @param content - Draft content to review
 * @returns DeepReviewResult with assessments and recommendations
 */
export function performDeepReview(content: string): DeepReviewResult {
  const planeAssessments: PlaneAssessment[] = [];
  const allRisks: DeepReviewResult["risks"] = [];
  const crossPlaneDeps: DeepReviewResult["crossPlaneDependencies"] = [];
  const blockers: string[] = [];

  let totalDepth = 0;

  for (const plane of MDD_PLANES) {
    const assessment = analyzePlaneContent(plane, content);
    planeAssessments.push(assessment);
    totalDepth += assessment.contentDepth;

    // Collect plane-specific risks
    for (const risk of assessment.risks) {
      allRisks.push({ risk, impact: "medium", planes: [plane] });
    }

    // Check for cross-plane dependencies mentioned
    const crossPlaneNotes = findCrossPlaneDependencies(plane, content);
    crossPlaneDeps.push(...crossPlaneNotes);
  }

  // Analyze dependency graph for cycles
  const depCycleIssue = checkDependencyCycles(planeAssessments);
  if (depCycleIssue) {
    allRisks.push({ risk: depCycleIssue, impact: "high", planes: [] });
    blockers.push(depCycleIssue);
  }

  // Check for implementation blockers
  checkImplementationBlockers(content, planeAssessments, blockers);

  // Calculate overall score
  const avgDepth = totalDepth / MDD_PLANES.length;
  const feasibleCount = planeAssessments.filter(p => p.status === "✅ Feasible").length;
  const score = Math.round(
    (avgDepth * 0.4) + 
    (feasibleCount / MDD_PLANES.length * 100 * 0.3) + 
    (blockers.length === 0 ? 30 : 0)
  );

  // Determine overall status
  let overallStatus: DeepReviewResult["overallStatus"] = "APPROVED";
  if (blockers.length > 0) {
    overallStatus = "REJECTED";
  } else if (feasibleCount < MDD_PLANES.length * 0.5 || avgDepth < 30) {
    overallStatus = "REVISE";
  }

  // Estimate complexity based on content
  const complexity = estimateComplexity(planeAssessments, content);
  const estimatedHours = estimateImplementationHours(complexity, planeAssessments);

  return {
    overallStatus,
    score: Math.min(100, Math.max(0, score)),
    planeAssessments,
    risks: allRisks,
    crossPlaneDependencies: crossPlaneDeps,
    implementationComplexity: complexity,
    estimatedHours,
    blockers,
    recommendations: generateRecommendations(planeAssessments, blockers),
  };
}

/**
 * Analyze a single plane's content with deep inspection
 */
function analyzePlaneContent(plane: MDDPlane, content: string): PlaneAssessment {
  const planeSection = extractPlaneSection(plane, content);
  const lines = planeSection.split('\n').filter(l => l.trim().length > 0);
  
  // Calculate content depth (0-100)
  const contentDepth = calculateContentDepth(plane, planeSection, lines);
  
  // Identify risks
  const risks = identifyPlaneRisks(plane, planeSection, lines);
  
  // Generate review questions
  const questions = generatePlaneQuestions(plane, planeSection, lines);
  
  // Generate recommendations
  const recommendations = generatePlaneRecommendations(plane, contentDepth, lines);
  
  // Determine status
  let status: PlaneAssessment["status"] = "✅ Feasible";
  if (risks.some(r => r.includes("Missing")) || contentDepth < 20) {
    status = "❌ Not Feasible";
  } else if (risks.length > 0 || contentDepth < 50) {
    status = "⚠️ Needs Review";
  }

  return {
    plane,
    status,
    contentDepth,
    notes: generatePlaneNotes(plane, lines),
    risks,
    questions,
    recommendations,
  };
}

/**
 * Extract plane section from draft content
 */
function extractPlaneSection(plane: MDDPlane, content: string): string {
  const allPlanes = Object.keys(PLANE_NUMBERS);
  const currentIdx = allPlanes.indexOf(plane);
  
  // Try multiple header patterns
  const patterns = [
    new RegExp(`###\\s*${PLANE_NUMBERS[plane]}\\.\\s*${plane}\\s*Plane`, 'i'),
    new RegExp(`##\\s*${plane}\\s*Plane`, 'i'),
    new RegExp(`###\\s*${plane}\\s*Plane`, 'i'),
    new RegExp(`##\\s*${plane}(?!\\s*Plane)`, 'i'),
  ];
  
  let start = -1;
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      start = content.indexOf(match[0]);
      break;
    }
  }
  
  if (start === -1) return "";
  
  // Find end of section (next plane header or end of content)
  let end = content.length;
  
  // Check for next numbered plane
  for (let i = currentIdx + 1; i < allPlanes.length; i++) {
    const nextNum = PLANE_NUMBERS[allPlanes[i]];
    const nextPattern = new RegExp(`###\\s*${nextNum}\\.\\s*${allPlanes[i]}\\s*Plane`, 'i');
    const nextMatch = content.match(nextPattern);
    if (nextMatch) {
      const nextStart = content.indexOf(nextMatch[0]);
      if (nextStart > start && nextStart < end) {
        end = nextStart;
      }
      break;
    }
  }
  
  return content.slice(start, end);
}

/**
 * Calculate content depth score (0-100)
 */
function calculateContentDepth(plane: MDDPlane, section: string, lines: string[]): number {
  if (lines.length === 0) return 0;
  
  let score = 0;
  
  // Base score: line count (max 30 points)
  score += Math.min(30, lines.length * 3);
  
  // Check for key elements based on plane type
  const keyChecks = getKeyElementsForPlane(plane);
  for (const check of keyChecks) {
    if (section.toLowerCase().includes(check.toLowerCase())) {
      score += 10;
    }
  }
  
  // Check for decision/action items (max 20 points)
  const decisionCount = (section.match(/^-?\s*\[|decision|action|implement|create|setup|configure/gi) || []).length;
  score += Math.min(20, decisionCount * 5);
  
  // Check for specific details (max 20 points)
  const detailPatterns = [
    /\d+\s*(hours?|days?|minutes?)/gi,
    /\$\d+/g,
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:API|service|database|model)/gi,
    /(?:schema|model|interface|type)\s*[=:]/gi,
  ];
  for (const pattern of detailPatterns) {
    if (pattern.test(section)) {
      score += 5;
    }
  }
  
  return Math.min(100, score);
}

/**
 * Get key elements to check for each plane
 */
function getKeyElementsForPlane(plane: MDDPlane): string[] {
  const planeElements: Record<MDDPlane, string[][]> = {
    Business: [["process", "flow"], ["rules", "policy"], ["workflow"]],
    Data: [["logic", "algorithm"], ["state", "model"], ["schema"]],
    Control: [["strategy", "policy"], ["distribution", "routing"], ["decision"]],
    Foundation: [["resource", "infrastructure"], ["abstraction", "api"], ["endpoint"]],
    Observation: [["metric", "monitoring"], ["analysis", "alert"], ["log"]],
    Security: [["identity", "auth"], ["permission", "access"], ["role"]],
    Evolution: [["time", "migration"], ["version", "change"], ["rollback"]],
  };
  // Flatten to get all keywords as a flat array
  return planeElements[plane].flat();
}

/**
 * Identify risks for a plane
 */
function identifyPlaneRisks(plane: MDDPlane, section: string, lines: string[]): string[] {
  const risks: string[] = [];
  
  // Check for missing content
  if (lines.length < 3) {
    risks.push(`${plane}: Missing detailed analysis (only ${lines.length} lines)`);
  }
  
  // Check for placeholder content
  const placeholderPatterns = [
    /\[todo\]/gi, 
    /\[ FIXME \]/gi, 
    /\[ placeholder \]/gi,
    /TBD|to be determined|not defined/gi,
  ];
  for (const pattern of placeholderPatterns) {
    if (pattern.test(section)) {
      risks.push(`${plane}: Contains placeholder content`);
      break;
    }
  }
  
  // Check for vague statements
  const vaguePatterns = [
    /\b(?:maybe|might|could be|possibly|probably)\b/gi,
    /\b(?:as needed|when required|if necessary)\b/gi,
  ];
  const vagueMatches = section.match(new RegExp(vaguePatterns.map(p => p.source).join('|'), 'gi'));
  if (vagueMatches && vagueMatches.length > 2) {
    risks.push(`${plane}: Contains ${vagueMatches.length} vague statements`);
  }
  
  // Plane-specific risk checks
  switch (plane) {
    case "Data":
      if (!/schema|model/i.test(section)) {
        risks.push("Data: No schema or data model defined");
      }
      break;
    case "Control":
      if (!section.includes("flow") && !section.includes("route")) {
        risks.push("Control: No clear control flow defined");
      }
      break;
    case "Foundation":
      if (!/api|endpoint|interface/i.test(section)) {
        risks.push("Foundation: No API/interface defined");
      }
      break;
    case "Security":
      if (!section.includes("auth") && !section.includes("permission")) {
        risks.push("Security: No auth/permission mechanism defined");
      }
      break;
  }
  
  return risks;
}

/**
 * Generate plane-specific review questions
 */
function generatePlaneQuestions(plane: MDDPlane, section: string, lines: string[]): string[] {
  const questionTemplates: Record<MDDPlane, string[]> = {
    Business: [
      "Are all workflows implementable with current tech stack?",
      "Are business rules codable or need a rules engine?",
      "What's the transaction boundary?",
    ],
    Data: [
      "Is the data model scalable to expected load?",
      "Can we use existing ORM patterns?",
      "What's the state persistence strategy?",
    ],
    Control: [
      "Can policies be externalized?",
      "Is sync or async distribution needed?",
      "What's the fallback strategy?",
    ],
    Foundation: [
      "Are required infrastructure components available?",
      "REST, GraphQL, or gRPC for APIs?",
      "What's the API versioning strategy?",
    ],
    Observation: [
      "What observability tools are available?",
      "Can we use existing APM solutions?",
      "What's the alerting strategy?",
    ],
    Security: [
      "OAuth2, JWT, or session-based auth?",
      "RBAC, ABAC, or custom permissions?",
      "Can we use existing IAM solutions?",
    ],
    Evolution: [
      "Can we use schema migration tools?",
      "What's the rollback strategy?",
      "Blue-green or canary deployment?",
    ],
  };
  
  // Only ask questions that haven't been answered in the section
  const templates = questionTemplates[plane];
  const questions: string[] = [];
  
  for (const q of templates) {
    const qKeywords = q.split(' ').slice(0, 3).join('|');
    if (!new RegExp(qKeywords, 'i').test(section)) {
      questions.push(q);
    }
  }
  
  return questions;
}

/**
 * Generate recommendations for a plane
 */
function generatePlaneRecommendations(plane: MDDPlane, contentDepth: number, lines: string[]): string[] {
  const recs: string[] = [];
  
  if (contentDepth < 30) {
    recs.push(`Add more detailed analysis for ${plane} (only ${lines.length} lines)`);
  }
  
  if (contentDepth < 60) {
    recs.push(`Include specific implementation details for ${plane}`);
  }
  
  return recs;
}

/**
 * Generate notes for a plane
 */
function generatePlaneNotes(plane: MDDPlane, lines: string[]): string[] {
  const notes: string[] = [];
  
  if (lines.length > 0) {
    notes.push(`${plane} Plane has ${lines.length} lines of analysis`);
  }
  
  // Check for specific patterns
  if (lines.some(l => l.includes("**"))) {
    notes.push("Contains decision points");
  }
  if (lines.some(l => l.includes("→") || l.includes("->"))) {
    notes.push("Contains relationship mappings");
  }
  
  return notes;
}

/**
 * Find cross-plane dependencies
 */
function findCrossPlaneDependencies(fromPlane: MDDPlane, content: string): { from: MDDPlane; to: MDDPlane; note: string }[] {
  const deps: { from: MDDPlane; to: MDDPlane; note: string }[] = [];
  
  for (const toPlane of MDD_PLANES) {
    if (toPlane === fromPlane) continue;
    
    // Check for mentions of other planes
    const pattern = new RegExp(`${fromPlane}[\\s\\S]*?(?:needs?|uses?|depends on|feeds)(${toPlane})`, 'gi');
    const matches = content.match(pattern);
    if (matches) {
      deps.push({ from: fromPlane, to: toPlane, note: `Flows data/decisions to ${toPlane}` });
    }
  }
  
  return deps;
}

/**
 * Check for circular dependencies
 */
function checkDependencyCycles(assessments: PlaneAssessment[]): string | null {
  // Simplified check - in real implementation would parse the content
  // For now, just check if any plane has all its content empty (potential cycle indicator)
  const emptyPlanes = assessments.filter(a => a.contentDepth === 0);
  if (emptyPlanes.length > 3) {
    return "Multiple planes have insufficient content - possible incomplete design";
  }
  
  return null;
}

/**
 * Check for implementation blockers
 */
function checkImplementationBlockers(content: string, assessments: PlaneAssessment[], blockers: string[]): void {
  // Check for "magic" claims (unspecified magic components)
  if (/\bmagic\b.*\b(AI|ML|algorithm)\b/gi.test(content)) {
    blockers.push("Contains 'magic' AI/ML claims without specification");
  }
  
  // Check for missing critical planes
  const criticalPlanes = ["Data", "Foundation"];
  for (const cp of criticalPlanes) {
    const assessment = assessments.find(a => a.plane === cp);
    if (assessment && assessment.contentDepth < 20) {
      blockers.push(`${cp} Plane is critical but has insufficient detail`);
    }
  }
}

/**
 * Estimate implementation complexity
 */
function estimateComplexity(assessments: PlaneAssessment[], content: string): DeepReviewResult["implementationComplexity"] {
  let score = 0;
  
  // Add score based on content depth variance
  const depths = assessments.map(a => a.contentDepth);
  const avg = depths.reduce((a, b) => a + b, 0) / depths.length;
  const variance = depths.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / depths.length;
  
  if (variance > 500) score += 2;
  else if (variance > 200) score += 1;
  
  // Check for technical complexity indicators
  const complexityIndicators = [
    /real-time|websocket|streaming/gi,
    /microservice|distributed/gi,
    /machine learning|AI|neural/gi,
    /blockchain|crypto/gi,
    /multi-tenant|multi-instance/gi,
  ];
  for (const pattern of complexityIndicators) {
    if (pattern.test(content)) score += 1;
  }
  
  if (score >= 4) return "very-high";
  if (score >= 2) return "high";
  if (score >= 1) return "medium";
  return "low";
}

/**
 * Estimate implementation hours
 */
function estimateImplementationHours(complexity: DeepReviewResult["implementationComplexity"], assessments: PlaneAssessment[]): number {
  const baseHours: Record<DeepReviewResult["implementationComplexity"], number> = {
    low: 8,
    medium: 24,
    high: 48,
    "very-high": 120,
  };
  
  let hours = baseHours[complexity];
  
  // Adjust for planes with content
  const activePlanes = assessments.filter(a => a.contentDepth > 30).length;
  hours = Math.round(hours * (activePlanes / MDD_PLANES.length));
  
  return Math.max(4, hours);
}

/**
 * Generate overall recommendations
 */
function generateRecommendations(assessments: PlaneAssessment[], blockers: string[]): string[] {
  const recs: string[] = [];
  
  if (blockers.length > 0) {
    recs.push("Resolve blockers before proceeding to implementation");
  }
  
  const needsReview = assessments.filter(a => a.status === "⚠️ Needs Review");
  if (needsReview.length > 0) {
    recs.push(`Add detail to: ${needsReview.map(a => a.plane).join(", ")}`);
  }
  
  const lowDepth = assessments.filter(a => a.contentDepth < 40);
  if (lowDepth.length > 0) {
    recs.push(`Expand analysis for: ${lowDepth.map(a => a.plane).join(", ")}`);
  }
  
  if (recs.length === 0) {
    recs.push("Design is well-structured for implementation");
  }
  
  return recs;
}

// Helper functions for report generation
function buildSummarySection(result: DeepReviewResult): string {
  const statusIcon = result.overallStatus === "APPROVED" ? "✅" : result.overallStatus === "REVISE" ? "⚠️" : "❌";
  return `## Summary

| Metric | Value |
|--------|-------|
| Overall Status | ${statusIcon} ${result.overallStatus} |
| Design Score | ${result.score}/100 |
| Complexity | ${result.implementationComplexity.toUpperCase()} |
| Est. Hours | ${result.estimatedHours}h |
| Blockers | ${result.blockers.length} |
`;
}

function buildPlaneSection(assessments: PlaneAssessment[]): string {
  let section = "## Plane-by-Plane Assessment\n\n";
  for (const a of assessments) {
    section += `### ${a.plane} Plane\n- **Status**: ${a.status}\n- **Depth**: ${a.contentDepth}%\n\n`;
    if (a.notes.length > 0) section += `- **Notes**: ${a.notes.join("; ")}\n`;
    if (a.risks.length > 0) section += `- **Risks**: ${a.risks.map(r => `⚠️ ${r}`).join("; ")}\n`;
    if (a.questions.length > 0) section += `- **Questions**: ${a.questions.map(q => `❓ ${q}`).join("; ")}\n`;
    if (a.recommendations.length > 0) section += `- **Recommendations**: ${a.recommendations.join("; ")}\n`;
    section += "\n";
  }
  return section;
}

function buildDependenciesSection(deps: DeepReviewResult["crossPlaneDependencies"]): string {
  if (deps.length === 0) return "";
  let section = "## Cross-Plane Dependencies\n\n";
  for (const dep of deps) {
    section += `- ${dep.from} → ${dep.to}: ${dep.note}\n`;
  }
  return section + "\n";
}

function buildRisksSection(risks: DeepReviewResult["risks"]): string {
  if (risks.length === 0) return "";
  let section = "## Risks\n\n| Risk | Impact | Affected Planes |\n|------|--------|----------------|\n";
  for (const r of risks) {
    section += `| ${r.risk} | ${r.impact} | ${r.planes.join(", ") || "Cross-plane"} |\n`;
  }
  return section + "\n";
}

function buildBlockersSection(blockers: string[]): string {
  if (blockers.length === 0) return "";
  let section = "## ⚠️ Blockers\n\n";
  for (const b of blockers) {
    section += `- ❌ ${b}\n`;
  }
  return section + "\n";
}

function buildRecommendationsSection(recommendations: string[]): string {
  let section = "## Recommendations\n\n";
  for (const rec of recommendations) {
    section += `- ${rec}\n`;
  }
  return section + "\n";
}

/**
 * Generate deep feasibility report (markdown format)
 */
export function generateDeepFeasibilityReport(result: DeepReviewResult): string {
  return `# Technical Feasibility Report

Generated by: QiaoChui (巧倕) - Technical Expert
Timestamp: ${new Date().toISOString()}

${buildSummarySection(result)}
${buildPlaneSection(result.planeAssessments)}${buildDependenciesSection(result.crossPlaneDependencies)}${buildRisksSection(result.risks)}${buildBlockersSection(result.blockers)}${buildRecommendationsSection(result.recommendations)}
---
*Generated by Four Sages Agents - QiaoChui (Technical Expert)*
`;
}

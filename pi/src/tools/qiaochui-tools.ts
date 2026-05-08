/**
 * QiaoChui Tools (巧倕) - Technical Expert 
 * 
 * Translates MDD design into technical specifications and execution plans.
 * Files are saved to .sages/workspace/
 * 
 * Review Mode Rules:
 * - ✅ Read draft.md
 * - ❌ No file modifications during review
 * 
 * Score Thresholds:
 * - > 80: ✅ Can proceed to plan
 * - 50-80: ⚠️ Revise draft
 * - < 50: ❌ Major gaps
 * 
 * Prohibited:
 * - ❌ Decompose without review
 * - ❌ Decompose if score ≤ 80
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseDraft, validateDraft } from "../utils/draft-parser.js";

const WORKSPACE_DIR = ".sages/workspace";

/**
 * MDD Planes for task classification
 */
type MDDPlane = "Business" | "Data" | "Control" | "Foundation" | "Observation" | "Security" | "Evolution";

/**
 * Deep plane assessment with risk analysis
 */
interface PlaneAssessment {
  plane: MDDPlane;
  status: "✅ Feasible" | "⚠️ Needs Review" | "❌ Not Feasible";
  contentDepth: number; // 0-100
  notes: string[];
  risks: string[];
  questions: string[];
  recommendations: string[];
}

/**
 * Deep review result
 */
interface DeepReviewResult {
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

export function registerQiaoChuiTools(pi: ExtensionAPI): void {
  /**
   * qiaochui_review - Review draft for technical feasibility
   * Review Mode (Read-Only): Only read draft.md
   * 
   * Process: Validate structure → Analyze MDD planes → Identify risks → Calculate score
   * Score thresholds: >80 APPROVED, 50-80 REVISE, <50 REJECTED
   */
  pi.registerTool({
    name: "qiaochui_review",
    label: "Review Draft",
    description: "Review draft for technical feasibility (MDD-aligned plane review). Validates structure, analyzes planes, identifies risks, calculates score (0-100). Verdict: APPROVED/REVISE/REJECTED.",
    parameters: Type.Object({
      draft_path: Type.Optional(Type.String({ description: "Path to draft.md (default: .sages/workspace/draft.md)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const draft_path = params.draft_path || join(cwd, WORKSPACE_DIR, "draft.md");

      try {
        if (!existsSync(draft_path)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draft_path}` } }) }],
            isError: true,
            details: { draft_path },
          };
        }

        const content = readFileSync(draft_path, "utf-8");
        const validation = validateDraft(content);

        if (!validation.valid) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                verdict: "REVISE",
                issues: validation.issues,
                recommendations: ["Fill in missing sections", "Remove placeholders"],
              }),
            }],
            details: { draft_path, verdict: "REVISE", issues: validation.issues },
          };
        }

        // Perform deep MDD-aligned plane review
        const deepResult = performDeepReview(content);

        // Generate detailed feasibility report
        const feasibilityReport = generateDeepFeasibilityReport(deepResult);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              verdict: deepResult.overallStatus,
              score: deepResult.score,
              implementationComplexity: deepResult.implementationComplexity,
              estimatedHours: deepResult.estimatedHours,
              planeCount: deepResult.planeAssessments.length,
              blockers: deepResult.blockers.length,
              recommendations: deepResult.recommendations.slice(0, 5),
              feasibilityReport,
            }),
          }],
          details: { draft_path, ...deepResult },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });

  /**
   * qiaochui_decompose - Decompose approved design into tasks
   * Prerequisites: qiaochui_review completed, score > 80
   * Creates: plan.md (task descriptions), execution.yaml (task config with dependencies)
   */
  pi.registerTool({
    name: "qiaochui_decompose",
    label: "Decompose",
    description: "Decompose design into tasks. Creates plan.md and execution.yaml with MDD plane classification, priorities, dependencies.",
    parameters: Type.Object({
      draft_path: Type.Optional(Type.String({ description: "Path to draft.md (default: .sages/workspace/draft.md)" })),
      max_tasks: Type.Optional(Type.Number({ description: "Maximum number of tasks to generate (default: 10, max: 20)" })),
      use_subagent: Type.Optional(Type.Boolean({ description: "Use isolated subagent mode for parallel execution (default: true)" })),
      max_parallel: Type.Optional(Type.Number({ description: "Maximum parallel subagents (default: 3)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const draft_path = params.draft_path || join(cwd, WORKSPACE_DIR, "draft.md");
      const max_tasks = params.max_tasks || 10;
      const use_subagent = params.use_subagent !== false;
      const max_parallel = params.max_parallel || 3;

      try {
        if (!existsSync(draft_path)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draft_path}` } }) }],
            isError: true,
            details: { draft_path },
          };
        }

        const content = readFileSync(draft_path, "utf-8");
        const workspacePath = join(cwd, WORKSPACE_DIR);

        if (!existsSync(workspacePath)) {
          mkdirSync(workspacePath, { recursive: true });
        }

        const planName = extractPlanName(content) || "workflow";
        
        // Generate tasks with MDD plane classification
        const tasks = generateMDDTasks(content, max_tasks);

        let planMarkdown = `# Task Plan

Generated by: QiaoChui (巧倕) - Technical Expert
Timestamp: ${new Date().toISOString()}
Plan: ${planName}

## MDD Task Breakdown

| ID | Description | Plane | Priority | Dependencies |
|----|-------------|-------|----------|--------------|
`;
        for (const task of tasks) {
          planMarkdown += `| ${task.id} | ${task.description} | ${task.plane} | ${task.priority} | ${task.dependsOn.join(", ") || "-"} |\n`;
        }

        planMarkdown += `\n## Task Details\n\n`;
        for (const task of tasks) {
          planMarkdown += `### ${task.id}: ${task.description}\n`;
          planMarkdown += `- **Plane**: ${task.plane}\n`;
          planMarkdown += `- **Priority**: ${task.priority}\n`;
          if (task.dependsOn.length > 0) {
            planMarkdown += `- **Depends on**: ${task.dependsOn.join(", ")}\n`;
          }
          if (task.files && task.files.length > 0) {
            planMarkdown += `- **Files**: ${task.files.join(", ")}\n`;
          }
          planMarkdown += "\n";
        }

        const totalTime = tasks.length * 10;
        planMarkdown += `## Total Estimated Time: ${totalTime} minutes\n`;

        const executionYaml = `# Execution Plan
# Generated by QiaoChui (巧倕) - Technical Expert
# Plan: ${planName}
# Created: ${new Date().toISOString()}

name: ${planName}

settings:
  maxParallel: ${max_parallel}
  useSubagent: ${use_subagent}
  maxRetry: 1
  autoCommit: true
  subagentConfig:
    model: sonnet
    skills:
      - luban
    maxContext: 4000
    timeout: 300

tasks:
${tasks.map((t) => `  - id: ${t.id}
    description: "${t.description}"
    plane: ${t.plane}
    priority: ${t.priority === "high" ? 1 : t.priority === "medium" ? 2 : 3}
    dependsOn: [${t.dependsOn.map(d => `"${d}"`).join(", ")}]
    files: [${(t.files || []).map(f => `"${f}"`).join(", ")}]`).join("\n")}
`;

        const planPath = join(workspacePath, "plan.md");
        const executionPath = join(workspacePath, "execution.yaml");

        writeFileSync(planPath, planMarkdown);
        writeFileSync(executionPath, executionYaml);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              plan_name: planName,
              plan_path: planPath,
              execution_path: executionPath,
              task_count: tasks.length,
              estimated_time: totalTime,
              planes: [...new Set(tasks.map(t => t.plane))],
              execution_mode: {
                use_subagent: use_subagent,
                max_parallel: max_parallel,
                description: use_subagent
                  ? "Isolated subagent mode - each task runs in a separate pi process"
                  : "Shared context mode - all tasks share the same context",
              },
              workspace: workspacePath,
              note: "Tasks stored in execution.yaml (not tasks.json)",
            }),
          }],
          details: { planName, planPath, executionPath, taskCount: tasks.length, useSubagent: use_subagent, maxParallel: max_parallel },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });
}

/**
 * Perform DEEP MDD-aligned plane review
 * Analyzes content depth, identifies risks, validates dependencies
 */
function performDeepReview(content: string): DeepReviewResult {
  const planes: MDDPlane[] = ["Business", "Data", "Control", "Foundation", "Observation", "Security", "Evolution"];
  const planeAssessments: PlaneAssessment[] = [];
  const allRisks: DeepReviewResult["risks"] = [];
  const crossPlaneDeps: DeepReviewResult["crossPlaneDependencies"] = [];
  const blockers: string[] = [];

  let totalDepth = 0;

  for (const plane of planes) {
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
  const avgDepth = totalDepth / planes.length;
  const feasibleCount = planeAssessments.filter(p => p.status === "✅ Feasible").length;
  const score = Math.round(
    (avgDepth * 0.4) + 
    (feasibleCount / planes.length * 100 * 0.3) + 
    (blockers.length === 0 ? 30 : 0)
  );

  // Determine overall status
  let overallStatus: DeepReviewResult["overallStatus"] = "APPROVED";
  if (blockers.length > 0) {
    overallStatus = "REJECTED";
  } else if (feasibleCount < planes.length * 0.5 || avgDepth < 30) {
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
  // Map plane names to their numbers for numbered format
  const planeNumbers: Record<string, string> = {
    "Business": "1",
    "Data": "2",
    "Control": "3",
    "Foundation": "4",
    "Observation": "5",
    "Security": "6",
    "Evolution": "7",
  };
  
  // Find plane header patterns
  const num = planeNumbers[plane];
  const allPlanes = Object.keys(planeNumbers);
  const currentIdx = allPlanes.indexOf(plane);
  
  // Try multiple header patterns
  const headerPatterns = [
    new RegExp(`###\\s*${num}\\.\\s*${plane}\\s*Plane`, 'i'),
    new RegExp(`##\\s*${plane}\\s*Plane`, 'i'),
    new RegExp(`###\\s*${plane}\\s*Plane`, 'i'),
    new RegExp(`##\\s*${plane}(?!\\s*Plane)`, 'i'),
  ];
  
  let start = -1;
  for (const pattern of headerPatterns) {
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
    const nextNum = planeNumbers[allPlanes[i]];
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
  
  // Also check for ## Key Design Decisions etc
  const afterPlanes = content.slice(start + 100);
  const keySectionMatch = afterPlanes.match(/^## [^\n]+/m);
  if (keySectionMatch) {
    const keyPos = start + 100 + afterPlanes.indexOf(keySectionMatch[0]);
    if (keyPos > start && keyPos < end && !keySectionMatch[0].includes('Plane')) {
      end = keyPos;
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
    /\d+\s*(hours?|days?|minutes?)/gi, // Time estimates
    /\$\d+/g, // Cost estimates
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:API|service|database|model)/gi, // Named components
    /(?:schema|model|interface|type)\s*[=:]/gi, // Data definitions
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
    /\[todo\]/gi, /\[ FIXME \]/gi, /\[ placeholder \]/gi,
    /TBD|to be determined|not defined/gi
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
  const questions: string[] = [];
  
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
  const planes: MDDPlane[] = ["Business", "Data", "Control", "Foundation", "Observation", "Security", "Evolution"];
  
  for (const toPlane of planes) {
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
  // Build dependency graph from cross-plane deps
  const deps = new Map<MDDPlane, MDDPlane[]>();
  
  for (const assessment of assessments) {
    deps.set(assessment.plane, []);
  }
  
  // This is a simplified check - in real implementation would parse the content
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
  
  // Check for circular reasoning
  if (/(?:must|need to|required to).*\b(?:must|need to|required to)\b/gi.test(content)) {
    // Simplified check - would need more sophisticated analysis
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
  
  // Check task count (if mentioned)
  const taskMatch = content.match(/(\d+)\s*tasks?/gi);
  if (taskMatch) {
    const count = taskMatch.length;
    if (count > 10) score += 2;
    else if (count > 5) score += 1;
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
  hours = Math.round(hours * (activePlanes / 7));
  
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

/**
 * Generate deep feasibility report
 */
function generateDeepFeasibilityReport(result: DeepReviewResult): string {
  let report = `# Technical Feasibility Report

Generated by: QiaoChui (巧倕) - Technical Expert
Timestamp: ${new Date().toISOString()}

## Summary

| Metric | Value |
|--------|-------|
| Overall Status | ${result.overallStatus === "APPROVED" ? "✅" : result.overallStatus === "REVISE" ? "⚠️" : "❌"} ${result.overallStatus} |
| Design Score | ${result.score}/100 |
| Complexity | ${result.implementationComplexity.toUpperCase()} |
| Est. Hours | ${result.estimatedHours}h |
| Blockers | ${result.blockers.length} |

## Plane-by-Plane Assessment

`;
  for (const a of result.planeAssessments) {
    report += `### ${a.plane} Plane
- **Status**: ${a.status}
- **Depth**: ${a.contentDepth}%

`;
    if (a.notes.length > 0) {
      report += `- **Notes**: ${a.notes.join("; ")}\n`;
    }
    if (a.risks.length > 0) {
      report += `- **Risks**: ${a.risks.map(r => `⚠️ ${r}`).join("; ")}\n`;
    }
    if (a.questions.length > 0) {
      report += `- **Questions**: ${a.questions.map(q => `❓ ${q}`).join("; ")}\n`;
    }
    if (a.recommendations.length > 0) {
      report += `- **Recommendations**: ${a.recommendations.join("; ")}\n`;
    }
    report += "\n";
  }

  if (result.crossPlaneDependencies.length > 0) {
    report += `## Cross-Plane Dependencies

`;
    for (const dep of result.crossPlaneDependencies) {
      report += `- ${dep.from} → ${dep.to}: ${dep.note}\n`;
    }
    report += "\n";
  }

  if (result.risks.length > 0) {
    report += `## Risks

| Risk | Impact | Affected Planes |
|------|--------|----------------|
`;
    for (const r of result.risks) {
      report += `| ${r.risk} | ${r.impact} | ${r.planes.join(", ") || "Cross-plane"} |\n`;
    }
    report += "\n";
  }

  if (result.blockers.length > 0) {
    report += `## ⚠️ Blockers

`;
    for (const b of result.blockers) {
      report += `- ❌ ${b}\n`;
    }
    report += "\n";
  }

  report += `## Recommendations

`;
  for (const rec of result.recommendations) {
    report += `- ${rec}\n`;
  }

  report += `
---
*Generated by Four Sages Agents - QiaoChui (Technical Expert)*
`;

  return report;
}

/**
 * Extract plan name from draft content
 */
function extractPlanName(content: string): string | null {
  const match = content.match(/^#\s*System Design:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Generate tasks with MDD plane classification
 */
interface MDDTask {
  id: string;
  description: string;
  plane: MDDPlane;
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  files: string[];
}

/**
 * Extract tasks from draft content - parses tables and YAML lists
 */
function extractTasksFromDraft(content: string): MDDTask[] {
  const tasks: MDDTask[] = [];
  
  // Pattern 1: Table rows like "| T1 | Fix TS1205 | src/tui/base/index.ts | High |"
  const tableRowRegex = /^\|\s*([A-Z][0-9]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\w+)/gm;
  let match;
  while ((match = tableRowRegex.exec(content)) !== null && tasks.length < 15) {
    const id = match[1];
    const desc = match[2].trim();
    const files = match[3].trim();
    const priority = match[4].toLowerCase().includes("high") ? "high" : "medium";
    
    tasks.push({
      id,
      description: desc,
      plane: inferPlaneFromDescription(desc),
      priority,
      dependsOn: [],
      files: files.split(",").map((f: string) => f.trim()).filter((f: string) => f.length > 0),
    });
  }
  
  // Pattern 2: YAML list format "- id: T1" followed by description
  if (tasks.length === 0) {
    const yamlBlockRegex = /^\s*-\s*id:\s*([A-Z][0-9]+)\s*\n\s*description:\s*"?([^"\n]+)"?\s*\n\s*(?:plane:\s*(\w+)\s*\n)?\s*(?:files:\s*\[([^\]]+)\]\s*\n)?/gm;
    while ((match = yamlBlockRegex.exec(content)) !== null && tasks.length < 15) {
      const id = match[1];
      const desc = match[2].trim();
      const planeStr = match[3];
      const filesStr = match[4] || "";
      
      tasks.push({
        id,
        description: desc,
        plane: planeStr ? (planeStr as MDDPlane) : inferPlaneFromDescription(desc),
        priority: "high" as const,
        dependsOn: [],
        files: filesStr.split(",").map((f: string) => f.trim().replace(/["']/g, "")).filter((f: string) => f.length > 0),
      });
    }
  }
  
  // Pattern 3: Simple numbered list "1. T1: Fix..."
  if (tasks.length === 0) {
    const simpleListRegex = /^\d+[\.\)]\s*([A-Z][0-9]+):\s*([^\n]+)/gm;
    while ((match = simpleListRegex.exec(content)) !== null && tasks.length < 15) {
      const id = match[1];
      const desc = match[2].trim();
      
      tasks.push({
        id,
        description: desc,
        plane: inferPlaneFromDescription(desc),
        priority: "high" as const,
        dependsOn: [],
        files: inferFilesFromDescription(desc),
      });
    }
  }
  
  return tasks;
}

/**
 * Infer MDD plane from task description
 */
function inferPlaneFromDescription(desc: string): MDDPlane {
  const lowerDesc = desc.toLowerCase();
  
  if (lowerDesc.includes("export") || lowerDesc.includes("import") || lowerDesc.includes("index.ts")) {
    return "Foundation";
  }
  if (lowerDesc.includes("type") || lowerDesc.includes("interface") || lowerDesc.includes("colors")) {
    return "Data";
  }
  if (lowerDesc.includes("handler") || lowerDesc.includes("command") || lowerDesc.includes("return type")) {
    return "Control";
  }
  if (lowerDesc.includes("unused") || lowerDesc.includes("remove")) {
    return "Business";
  }
  if (lowerDesc.includes("test")) {
    return "Observation";
  }
  
  return "Foundation";
}

/**
 * Infer files from task description
 */
function inferFilesFromDescription(desc: string): string[] {
  const lowerDesc = desc.toLowerCase();
  const files: string[] = [];
  
  if (lowerDesc.includes("base/index")) files.push("src/tui/base/index.ts");
  else if (lowerDesc.includes("websocket/index")) files.push("src/tui/websocket/index.ts");
  else if (lowerDesc.includes("modal/index")) files.push("src/tui/modal/index.ts");
  else if (lowerDesc.includes("editor/index")) files.push("src/tui/editor/index.ts");
  else if (lowerDesc.includes("utils/index") || lowerDesc.includes("box export")) files.push("src/tui/utils/index.ts");
  else if (lowerDesc.includes("index.ts")) files.push("src/tui/index.ts");
  
  if (lowerDesc.includes("colors")) files.push("src/tui/utils/colors.ts");
  if (lowerDesc.includes("component")) files.push("src/tui/base/component.ts");
  if (lowerDesc.includes("node-block")) files.push("src/tui/node-block-list.ts");
  if (lowerDesc.includes("box")) files.push("src/tui/box-drawing.ts");
  if (lowerDesc.includes("command")) files.push("src/tui/editor/editor-commands.ts");
  if (lowerDesc.includes("kanban-editor")) files.push("src/tui/editor/kanban-editor.ts");
  
  return files.length > 0 ? files : ["src/"];
}

/**
 * Generate MDD tasks - tries to extract from draft first
 */
function generateMDDTasks(content: string, maxTasks: number): MDDTask[] {
  // First, try to extract actual tasks from the draft content
  const extractedTasks = extractTasksFromDraft(content);
  if (extractedTasks.length > 0) {
    return extractedTasks.slice(0, maxTasks);
  }

  // Fallback: minimal generic tasks only if extraction fails
  return [
    { id: "T1", description: "Analyze requirements and understand scope", plane: "Business" as MDDPlane, priority: "high" as const, dependsOn: [], files: [] },
    { id: "T2", description: "Implement fix based on design", plane: "Business" as MDDPlane, priority: "high" as const, dependsOn: [], files: [] },
    { id: "T3", description: "Test and validate implementation", plane: "Observation" as MDDPlane, priority: "medium" as const, dependsOn: [], files: [] },
  ].slice(0, maxTasks);
}

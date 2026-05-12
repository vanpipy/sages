/**
 * GaoYao Tools (皋陶) - Enhanced Auditor
 * 
 * Deep, agent-assisted quality audit using Xie Zhi methodology.
 * Unlike static analysis tools, GaoYao leverages the agent's intelligence
 * to understand semantics, cross-reference design with implementation,
 * and find real issues that pattern matching would miss.
 * 
 * Audit Reports: .sages/workspace/audit.md
 * 
 * Five Audits (五刑审核) - Xie Zhi methodology:
 * - 墨刑 (Ink): Code style (structure, naming, complexity)
 * - 劓刑 (Nose): Naming & documentation (clarity, consistency)
 * - 剕刑 (Foot): Architecture (design vs implementation)
 * - 宫刑 (Castration): Security (vulnerabilities, risks)
 * - 大辟 (Death): Critical defects (logic errors, breaking bugs)
 * 
 * Verdict:
 * - PASS (≥70): Workflow complete, archive
 * - NEEDS_CHANGES (50-69): Return to LuBan for fixes
 * - REJECTED (<50): Return to Fuxi for redesign
 * 
 * Prohibited:
 * - ❌ Modify implementation files
 * - ❌ Skip any audit category
 * - ❌ Use only static pattern matching
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { ProjectAnalyzer } from "../utils/analyzer/index.js";

// ============================================================================
// Types
// ============================================================================

interface AuditFinding {
  category: "ink" | "nose" | "foot" | "castration" | "death";
  severity: "critical" | "major" | "minor";
  file?: string;
  line?: number;
  issue: string;
  evidence?: string;
  recommendation: string;
}

interface FiveAuditResults {
  ink: { passed: boolean; score: number; findings: AuditFinding[] };
  nose: { passed: boolean; score: number; findings: AuditFinding[] };
  foot: { passed: boolean; score: number; findings: AuditFinding[] };
  castration: { passed: boolean; score: number; findings: AuditFinding[] };
  death: { passed: boolean; score: number; findings: AuditFinding[] };
}

type Verdict = "PASS" | "NEEDS_CHANGES" | "REJECTED";

const WORKSPACE_DIR = ".sages/workspace";

// ============================================================================
// Main Tool Registration
// ============================================================================

export function registerGaoYaoTools(pi: ExtensionAPI): void {
  
  /**
   * gaoyao_review - Full quality audit with deep agent analysis
   * 
   * This tool orchestrates a comprehensive audit by:
   * 1. Analyzing project structure with ProjectAnalyzer
   * 2. Reading design documents (plan.md, execution.yaml)
   * 3. Guiding agent to perform deep semantic analysis
   * 4. Aggregating findings into structured report
   * 
   * The agent does the actual analysis - this tool provides structure.
   */
  pi.registerTool({
    name: "gaoyao_review",
    label: "Quality Audit",
    description: "Deep quality audit using Xie Zhi methodology. Agent reads actual code and finds real issues with evidence. Generates comprehensive audit.md report.",
    parameters: Type.Object({
      plan_name: Type.Optional(Type.String({ description: "Plan name to audit (optional)" })),
      review_mode: Type.Optional(Type.Union([
        Type.Literal("quick", { description: "Fast triage - only critical checks" }),
        Type.Literal("full", { description: "Complete 5-audit deep analysis" })
      ], { description: "Review depth: 'quick' or 'full' (default: full)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { review_mode = "full" } = params;
      const workspacePath = join(ctx.cwd, WORKSPACE_DIR);
      const analyzer = new ProjectAnalyzer();

      try {
        // Phase 1: Quick Project Analysis
        const projectContext = await analyzer.analyze(ctx.cwd);

        // Phase 2: Read Design Context
        const planPath = join(workspacePath, "plan.md");
        const executionPath = join(workspacePath, "execution.yaml");
        
        let designContext = {
          plan: null as string | null,
          execution: null as string | null,
        };

        if (existsSync(planPath)) {
          designContext.plan = readFileSync(planPath, "utf-8");
        }
        if (existsSync(executionPath)) {
          designContext.execution = readFileSync(executionPath, "utf-8");
        }

        // Phase 3: Generate Audit Guidance
        // The agent will use this guidance to perform actual analysis
        const auditGuidance = generateAuditGuidance(projectContext, designContext, review_mode);

        // Phase 4: Structure findings (agent will populate via guidance)
        const fiveAudits: FiveAuditResults = {
          ink: { passed: true, score: 100, findings: [] },
          nose: { passed: true, score: 100, findings: [] },
          foot: { passed: true, score: 100, findings: [] },
          castration: { passed: true, score: 100, findings: [] },
          death: { passed: true, score: 100, findings: [] },
        };

        // Calculate initial scores (agent will update via findings)
        const { verdict, score } = calculateVerdict(fiveAudits);

        // Generate initial report structure
        const auditReport = generateAuditReportStructure(
          projectContext,
          fiveAudits,
          verdict,
          score,
          review_mode,
          auditGuidance
        );

        // Ensure workspace exists
        if (!existsSync(workspacePath)) {
          mkdirSync(workspacePath, { recursive: true });
        }
        writeFileSync(join(workspacePath, "audit.md"), auditReport);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              verdict,
              score,
              reviewMode: review_mode,
              project: {
                language: projectContext.language,
                framework: projectContext.framework,
                type: projectContext.projectType,
                files: projectContext.structure.srcDir ? 
                  `src/${projectContext.existingComponents.join(", ") || "detected"}` : "none",
              },
              summary: `GaoYao audit initiated. ${review_mode === "quick" ? "Quick" : "Full"} review mode. ` +
                `Project: ${projectContext.language}/${projectContext.framework || "plain"}. ` +
                `Verdict: ${verdict} (${score}%). See audit.md for guidance.`,
              action: `Read audit.md for detailed audit instructions. ` +
                `Follow the guidance to perform deep analysis and update findings.`,
            }),
          }],
          details: {
            verdict,
            score,
            auditPath: join(workspacePath, "audit.md"),
            projectContext,
            auditGuidance,
          },
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
   * gaoyao_quick_check - Fast triage for minor changes
   * 
   * For small changes/fixes, do a focused audit:
   * - Only check ink (style) and castration (security)
   * - Skip deep architecture review
   */
  pi.registerTool({
    name: "gaoyao_quick_check",
    label: "Quick Check",
    description: "Fast triage audit for minor changes. Only checks critical issues: style and security. Skips deep architecture review.",
    parameters: Type.Object({
      files: Type.Array(Type.String(), { description: "Files changed" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { files = [] } = params;
      const analyzer = new ProjectAnalyzer();

      try {
        const projectContext = await analyzer.analyze(ctx.cwd);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              mode: "quick",
              filesToCheck: files,
              project: {
                language: projectContext.language,
                framework: projectContext.framework,
              },
              summary: `Quick check for ${files.length} files. Focus on ink (style) and castration (security).`,
              guidance: generateQuickCheckGuidance(files, projectContext),
            }),
          }],
          details: { mode: "quick", files, projectContext },
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
   * gaoyao_check_security - Deep security vulnerability analysis
   * 
   * Focused security audit that:
   * - Reads code semantically (not just pattern matching)
   * - Checks for OWASP Top 10 issues
   * - Verifies authentication/authorization logic
   * - Reviews data handling and exposure risks
   */
  pi.registerTool({
    name: "gaoyao_check_security",
    label: "Security Scan",
    description: "Deep security audit. Agent reads code semantically to find injection, auth, and data exposure risks. Returns vulnerability count with evidence.",
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String(), { description: "Files to scan (default: all source)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { files = [] } = params;
      const analyzer = new ProjectAnalyzer();

      try {
        const projectContext = await analyzer.analyze(ctx.cwd);
        const srcDir = projectContext.structure.srcDir || "src";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              mode: "security",
              filesToScan: files.length > 0 ? files : [`${srcDir}/**/*.{ts,js,py,go,java}`],
              project: {
                language: projectContext.language,
                framework: projectContext.framework,
              },
              summary: `Security audit initiated. Scan focus: injection, auth, data exposure.`,
              guidance: generateSecurityGuidance(projectContext, files),
            }),
          }],
          details: { mode: "security", files, projectContext },
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
   * gaoyao_record_finding - Record a finding during audit
   * 
   * Call this to record each issue found during analysis.
   * Agent aggregates all findings into final verdict.
   */
  pi.registerTool({
    name: "gaoyao_record_finding",
    label: "Record Finding",
    description: "Record a single audit finding. Include evidence (file:line). Aggregates into final report.",
    parameters: Type.Object({
      category: Type.Union([
        Type.Literal("ink", { description: "墨刑 - Code style" }),
        Type.Literal("nose", { description: "劓刑 - Naming/doc" }),
        Type.Literal("foot", { description: "剕刑 - Architecture" }),
        Type.Literal("castration", { description: "宫刑 - Security" }),
        Type.Literal("death", { description: "大辟 - Critical defect" }),
      ], { description: "Audit category" }),
      severity: Type.Union([
        Type.Literal("critical", { description: "Must fix immediately" }),
        Type.Literal("major", { description: "Should fix before release" }),
        Type.Literal("minor", { description: "Can fix later" }),
      ], { description: "Issue severity" }),
      file: Type.Optional(Type.String({ description: "File path with issue" })),
      line: Type.Optional(Type.Number({ description: "Line number" })),
      issue: Type.String({ description: "Description of the issue" }),
      evidence: Type.Optional(Type.String({ description: "Code snippet or reference" })),
      recommendation: Type.String({ description: "How to fix this issue" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const finding: AuditFinding = {
        category: params.category,
        severity: params.severity,
        file: params.file,
        line: params.line,
        issue: params.issue,
        evidence: params.evidence,
        recommendation: params.recommendation,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            findingRecorded: finding,
            summary: `Recorded: [${params.category}] ${params.severity} - ${params.issue}${params.file ? ` (${params.file}:${params.line || "?"})` : ""}`,
          }),
        }],
        details: { finding },
      };
    },
  });

  /**
   * gaoyao_finalize - Generate final audit report
   * 
   * Call after all findings are recorded to generate
   * the final verdict and comprehensive report.
   */
  pi.registerTool({
    name: "gaoyao_finalize",
    label: "Finalize Audit",
    description: "Generate final audit report with verdict. Call after recording all findings.",
    parameters: Type.Object({
      findings: Type.Array(Type.Object({
        category: Type.String(),
        severity: Type.String(),
        file: Type.Optional(Type.String()),
        line: Type.Optional(Type.Number()),
        issue: Type.String(),
        evidence: Type.Optional(Type.String()),
        recommendation: Type.String(),
      }), { description: "All findings to include" }),
      notes: Type.Optional(Type.String({ description: "Overall assessment notes" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const workspacePath = join(ctx.cwd, WORKSPACE_DIR);
      const analyzer = new ProjectAnalyzer();

      try {
        const projectContext = await analyzer.analyze(ctx.cwd);
        const findings: AuditFinding[] = params.findings.map(f => ({
          category: f.category as AuditFinding["category"],
          severity: f.severity as AuditFinding["severity"],
          file: f.file,
          line: f.line,
          issue: f.issue,
          evidence: f.evidence,
          recommendation: f.recommendation,
        }));

        // Calculate scores from findings
        const fiveAudits = calculateScoresFromFindings(findings);
        const { verdict, score } = calculateVerdict(fiveAudits);

        // Generate final report
        const auditReport = generateFinalAuditReport(
          projectContext,
          fiveAudits,
          findings,
          verdict,
          score,
          params.notes
        );

        writeFileSync(join(workspacePath, "audit.md"), auditReport);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              verdict,
              score,
              totalFindings: findings.length,
              byCategory: {
                ink: findings.filter(f => f.category === "ink").length,
                nose: findings.filter(f => f.category === "nose").length,
                foot: findings.filter(f => f.category === "foot").length,
                castration: findings.filter(f => f.category === "castration").length,
                death: findings.filter(f => f.category === "death").length,
              },
              bySeverity: {
                critical: findings.filter(f => f.severity === "critical").length,
                major: findings.filter(f => f.severity === "major").length,
                minor: findings.filter(f => f.severity === "minor").length,
              },
              summary: `Audit finalized: ${verdict} (${score}%). ${findings.length} findings recorded.`,
              action: getVerdictAction(verdict),
            }),
          }],
          details: { verdict, score, findings, auditPath: join(workspacePath, "audit.md") },
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

// ============================================================================
// Audit Guidance Generators
// ============================================================================

function generateAuditGuidance(
  projectContext: any,
  designContext: { plan: string | null; execution: string | null },
  reviewMode: string
): string {
  const lines: string[] = [];

  lines.push("# GaoYao Audit Guidance");
  lines.push("");
  lines.push(`**Mode**: ${reviewMode === "quick" ? "Quick Triage" : "Full Deep Audit"}`);
  lines.push(`**Project**: ${projectContext.language}/${projectContext.framework || "plain"}`);
  lines.push(`**Type**: ${projectContext.projectType}`);
  lines.push("");

  // Design Context
  if (designContext.plan) {
    lines.push("## Design Context (from plan.md)");
    lines.push("");
    lines.push("Review the plan to understand what was **supposed** to be built:");
    lines.push("```");
    lines.push(designContext.plan.slice(0, 2000));
    if (designContext.plan.length > 2000) lines.push("... (truncated)");
    lines.push("```");
    lines.push("");
  }

  // Five Audits Guidance
  lines.push("## Five Audits (五刑审核) - Your Tasks");
  lines.push("");

  if (reviewMode === "full") {
    lines.push("### 墨刑 (Ink) - Code Style");
    lines.push("**Read and check**:");
    lines.push("- [ ] Source files for style consistency");
    lines.push("- [ ] Naming conventions followed");
    lines.push("- [ ] Complexity acceptable (no deeply nested logic)");
    lines.push("- [ ] No obvious code smells");
    lines.push("");

    lines.push("### 劓刑 (Nose) - Naming & Documentation");
    lines.push("**Read and check**:");
    lines.push("- [ ] Public APIs have clear names");
    lines.push("- [ ] Functions/modules have doc comments");
    lines.push("- [ ] Domain terminology consistent");
    lines.push("- [ ] README/usage docs present");
    lines.push("");

    lines.push("### 剕刑 (Foot) - Architecture");
    lines.push("**Read and verify**:");
    lines.push("- [ ] Structure matches design from plan.md");
    lines.push("- [ ] Layer boundaries respected (api/service/repo)");
    lines.push("- [ ] Dependencies follow architecture");
    lines.push("- [ ] No circular dependencies");
    lines.push("");

    lines.push("### 宫刑 (Castration) - Security");
    lines.push("**Read and verify**:");
    lines.push("- [ ] No SQL/NoSQL injection vectors");
    lines.push("- [ ] No XSS or command injection risks");
    lines.push("- [ ] Auth/permissions properly enforced");
    lines.push("- [ ] No sensitive data in logs/code");
    lines.push("- [ ] Dependencies have no known vulns");
    lines.push("");

    lines.push("### 大辟 (Death) - Critical Defects");
    lines.push("**Read and verify**:");
    lines.push("- [ ] Core business logic correct");
    lines.push("- [ ] Error handling in critical paths");
    lines.push("- [ ] No obvious bugs or logic errors");
    lines.push("- [ ] Edge cases handled");
    lines.push("");
  } else {
    lines.push("### Quick Focus (Quick Mode)");
    lines.push("- [ ] Security vulnerabilities (宫刑)");
    lines.push("- [ ] Critical defects (大辟)");
    lines.push("- [ ] Major style issues (墨刑)");
    lines.push("");
  }

  // How to Record Findings
  lines.push("## Recording Findings");
  lines.push("");
  lines.push("For each issue found, use `gaoyao_record_finding` with:");
  lines.push("- `category`: ink, nose, foot, castration, or death");
  lines.push("- `severity`: critical, major, or minor");
  lines.push("- `file` and `line`: exact location");
  lines.push("- `issue`: clear description");
  lines.push("- `evidence`: code snippet or reference");
  lines.push("- `recommendation`: how to fix");
  lines.push("");
  lines.push("After all findings recorded, use `gaoyao_finalize`.");
  lines.push("");

  return lines.join("\n");
}

function generateQuickCheckGuidance(files: string[], projectContext: any): string {
  const lines: string[] = [];
  
  lines.push("# Quick Check Guidance");
  lines.push("");
  lines.push(`**Files to Check**: ${files.length > 0 ? files.join(", ") : "All source files"}`);
  lines.push(`**Focus**: Critical style + Security`);
  lines.push("");

  lines.push("## Critical Checks");
  lines.push("");
  lines.push("### Security (宫刑 - Castration)");
  lines.push("- [ ] No injection risks in these files");
  lines.push("- [ ] No auth/permission bypasses");
  lines.push("- [ ] No data exposure");
  lines.push("");

  lines.push("### Style (墨刑 - Ink)");
  lines.push("- [ ] Consistent naming");
  lines.push("- [ ] No obvious complexity issues");
  lines.push("");

  lines.push("## If issues found, use `gaoyao_record_finding`.");
  lines.push("Then use `gaoyao_finalize` when done.");

  return lines.join("\n");
}

function generateSecurityGuidance(projectContext: any, files: string[]): string {
  const lines: string[] = [];

  lines.push("# Security Audit Guidance");
  lines.push("");
  lines.push(`**Language**: ${projectContext.language}`);
  lines.push(`**Framework**: ${projectContext.framework || "none"}`);
  lines.push("");

  lines.push("## OWASP Top 10 Focus");
  lines.push("");
  lines.push("For each file, read and check for:");

  const checks = [
    ["A01:2021 - Broken Access Control", 
     "Look for: IDOR, privilege escalation, missing auth checks",
     projectContext.language === "typescript" ? 
       ["middleware without auth check", "req.user used without verification", ".find() without ownership check"] :
     projectContext.language === "go" ?
       ["middleware without auth", "sql.Open without parameterized query"] :
     ["potential auth bypasses"]],
    
    ["A02:2021 - Cryptographic Failures",
     "Look for: hardcoded secrets, weak crypto, no TLS",
     ["password in code", "md5/sha1 for passwords", "http:// instead of https://"]],
    
    ["A03:2021 - Injection",
     "Look for: SQL, NoSQL, OS, LDAP injection",
     ["string concatenation in queries", "eval() usage", "innerHTML/unsafe HTML"]],
    
    ["A04:2021 - Insecure Design",
     "Look for: missing rate limiting, no brute force protection",
     ["no rate limit on auth endpoints", "no password attempt limits"]],
    
    ["A05:2021 - Security Misconfiguration",
     "Look for: default creds, verbose errors, missing hardening",
     ["console.error in production", "stack traces exposed", "debug mode enabled"]],
    
    ["A06:2021 - Vulnerable Components",
     "Check: package.json/go.mod for known vulnerabilities",
     ["outdated packages", "packages with known CVEs"]],
    
    ["A07:2021 - Auth Failures",
     "Look for: weak passwords, credential exposure, session issues",
     ["no password validation", "tokens in URL", "session fixation"]],
  ];

  for (const [title, description, examples] of checks) {
    lines.push(`### ${title}`);
    lines.push(`**Check**: ${description}`);
    lines.push(`**Red flags**: ${(examples as string[]).join(", ")}`);
    lines.push("");
  }

  lines.push("## Recording Findings");
  lines.push("");
  lines.push("Use `gaoyao_record_finding` with category `castration`.");
  lines.push("After all findings, use `gaoyao_finalize`.");

  return lines.join("\n");
}

// ============================================================================
// Score Calculation
// ============================================================================

function calculateScoresFromFindings(findings: AuditFinding[]): FiveAuditResults {
  const audits: FiveAuditResults = {
    ink: { passed: true, score: 100, findings: [] },
    nose: { passed: true, score: 100, findings: [] },
    foot: { passed: true, score: 100, findings: [] },
    castration: { passed: true, score: 100, findings: [] },
    death: { passed: true, score: 100, findings: [] },
  };

  const categoryMap: Record<string, keyof FiveAuditResults> = {
    ink: "ink",
    nose: "nose",
    foot: "foot",
    castration: "castration",
    death: "death",
  };

  const penaltyMap = {
    critical: 30,
    major: 15,
    minor: 5,
  };

  for (const finding of findings) {
    const category = categoryMap[finding.category];
    if (!category) continue;

    audits[category].findings.push(finding);
    audits[category].score = Math.max(0, audits[category].score - (penaltyMap[finding.severity] || 15));
  }

  // Determine pass/fail
  for (const key of Object.keys(audits) as Array<keyof FiveAuditResults>) {
    audits[key].passed = audits[key].score >= 70;
  }

  return audits;
}

function calculateVerdict(fiveAudits: FiveAuditResults): { verdict: Verdict; score: number } {
  // Death penalty is absolute rejection
  if (!fiveAudits.death.passed) {
    return { verdict: "REJECTED", score: Math.min(fiveAudits.death.score, 49) };
  }

  // Security issues require changes
  if (!fiveAudits.castration.passed) {
    return { verdict: "NEEDS_CHANGES", score: fiveAudits.castration.score };
  }

  // Calculate average score
  const scores = [
    fiveAudits.ink.score,
    fiveAudits.nose.score,
    fiveAudits.foot.score,
    fiveAudits.castration.score,
  ];

  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const finalScore = Math.round(avgScore);

  let verdict: Verdict;
  if (finalScore >= 70) {
    verdict = "PASS";
  } else if (finalScore >= 50) {
    verdict = "NEEDS_CHANGES";
  } else {
    verdict = "REJECTED";
  }

  return { verdict, score: finalScore };
}

function getVerdictAction(verdict: Verdict): string {
  switch (verdict) {
    case "PASS":
      return "Archive workflow. Ready for deployment.";
    case "NEEDS_CHANGES":
      return "Return to LuBan for fixes based on audit findings.";
    case "REJECTED":
      return "Critical issues require redesign. Return to Fuxi.";
  }
}

// ============================================================================
// Report Generators
// ============================================================================

function generateAuditReportStructure(
  projectContext: any,
  fiveAudits: FiveAuditResults,
  verdict: Verdict,
  score: number,
  reviewMode: string,
  guidance: string
): string {
  const verdictEmoji = verdict === "PASS" ? "✅" : verdict === "NEEDS_CHANGES" ? "⚠️" : "❌";

  return `# Audit Report

**Status**: IN PROGRESS
**Verdict**: ${verdictEmoji} ${verdict} (${score}%)
**Mode**: ${reviewMode}
**Generated**: ${new Date().toISOString()}

---

## Project Overview

| Property | Value |
|----------|-------|
| Language | ${projectContext.language} |
| Framework | ${projectContext.framework || "none"} |
| Type | ${projectContext.projectType} |
| Source Dir | ${projectContext.structure.srcDir || "not detected"} |
| Test Dir | ${projectContext.structure.testDir || "not detected"} |

## Five Audits Summary

| Audit | Category | Status | Score | Findings |
|-------|----------|--------|-------|----------|
| 墨刑 | Code Style | ⏳ | - | - |
| 劓刑 | Naming/Doc | ⏳ | - | - |
| 剕刑 | Architecture | ⏳ | - | - |
| 宫刑 | Security | ⏳ | - | - |
| 大辟 | Critical | ⏳ | - | - |

---

${guidance}

---

## Notes

*This report is in progress. Follow the guidance above to complete the audit.*

---

*Generated by Four Sages Agents - GaoYao (Supreme Judge)*
`;
}

function generateFinalAuditReport(
  projectContext: any,
  fiveAudits: FiveAuditResults,
  findings: AuditFinding[],
  verdict: Verdict,
  score: number,
  notes?: string
): string {
  const verdictEmoji = verdict === "PASS" ? "✅" : verdict === "NEEDS_CHANGES" ? "⚠️" : "❌";
  const action = getVerdictAction(verdict);

  // Group findings by category
  const byCategory = {
    ink: findings.filter(f => f.category === "ink"),
    nose: findings.filter(f => f.category === "nose"),
    foot: findings.filter(f => f.category === "foot"),
    castration: findings.filter(f => f.category === "castration"),
    death: findings.filter(f => f.category === "death"),
  };

  // Group findings by severity
  const critical = findings.filter(f => f.severity === "critical");
  const major = findings.filter(f => f.severity === "major");
  const minor = findings.filter(f => f.severity === "minor");

  let report = `# Audit Report - FINAL

**Status**: COMPLETE
**Verdict**: ${verdictEmoji} ${verdict} (${score}%)
**Generated**: ${new Date().toISOString()}

---

## Summary

| Metric | Value |
|--------|-------|
| Total Findings | ${findings.length} |
| Critical | ${critical.length} |
| Major | ${major.length} |
| Minor | ${minor.length} |

${notes ? `## Overall Assessment\n\n${notes}\n` : ""}

---

## Five Audits Results

| Audit | Category | Status | Score | Issues |
|-------|----------|--------|-------|--------|
| 墨刑 | Code Style | ${fiveAudits.ink.passed ? "✅" : "❌"} | ${fiveAudits.ink.score}% | ${byCategory.ink.length} |
| 劓刑 | Naming/Doc | ${fiveAudits.nose.passed ? "✅" : "❌"} | ${fiveAudits.nose.score}% | ${byCategory.nose.length} |
| 剕刑 | Architecture | ${fiveAudits.foot.passed ? "✅" : "❌"} | ${fiveAudits.foot.score}% | ${byCategory.foot.length} |
| 宫刑 | Security | ${fiveAudits.castration.passed ? "✅" : "❌"} | ${fiveAudits.castration.score}% | ${byCategory.castration.length} |
| 大辟 | Critical | ${fiveAudits.death.passed ? "✅" : "❌"} | ${fiveAudits.death.score}% | ${byCategory.death.length} |

---

## Detailed Findings

`;

  // Critical findings first
  if (critical.length > 0) {
    report += `### 🔴 Critical Issues (${critical.length})\n\n`;
    for (const f of critical) {
      report += `#### ${f.issue}\n`;
      report += `- **File**: ${f.file || "N/A"}${f.line ? `:${f.line}` : ""}\n`;
      report += `- **Category**: ${f.category}\n`;
      if (f.evidence) report += `- **Evidence**:\n\`\`\`\n${f.evidence}\n\`\`\`\n`;
      report += `- **Recommendation**: ${f.recommendation}\n\n`;
    }
  }

  // Major findings
  if (major.length > 0) {
    report += `### 🟠 Major Issues (${major.length})\n\n`;
    for (const f of major) {
      report += `#### ${f.issue}\n`;
      report += `- **File**: ${f.file || "N/A"}${f.line ? `:${f.line}` : ""}\n`;
      report += `- **Category**: ${f.category}\n`;
      if (f.evidence) report += `- **Evidence**:\n\`\`\`\n${f.evidence}\n\`\`\`\n`;
      report += `- **Recommendation**: ${f.recommendation}\n\n`;
    }
  }

  // Minor findings
  if (minor.length > 0) {
    report += `### 🟡 Minor Issues (${minor.length})\n\n`;
    for (const f of minor) {
      report += `- ${f.issue}`;
      if (f.file) report += ` (${f.file})`;
      report += ` - ${f.recommendation}\n`;
    }
    report += "\n";
  }

  if (findings.length === 0) {
    report += "No issues found. Excellent work!\n\n";
  }

  report += `---

## Verdict

**${verdictEmoji} ${verdict}** - Score: ${score}%

**Action Required**: ${action}

`;

  if (verdict !== "PASS") {
    report += `### Action Items\n\n`;
    if (!fiveAudits.castration.passed) {
      report += `1. 🔴 **Security First**: Address all ${byCategory.castration.length} security issues before anything else\n`;
    }
    if (!fiveAudits.death.passed) {
      report += `2. 🔴 **Critical Fixes**: Address all ${byCategory.death.length} critical defects - these are blocking issues\n`;
    }
    if (!fiveAudits.foot.passed) {
      report += `3. 🟠 **Architecture Review**: Revisit ${byCategory.foot.length} architecture issues\n`;
    }
    if (!fiveAudits.ink.passed || !fiveAudits.nose.passed) {
      report += `4. 🟡 **Quality Improvements**: Address ${byCategory.ink.length + byCategory.nose.length} style/naming issues\n`;
    }
    report += "\n";
  }

  report += `---

## Judge's Oath

> I, GaoYao, by the name of Xie Zhi, swear:
> - To audit by the law, showing no favoritism
> - To have evidence for every finding
> - To help improve, not just criticize
> - To guard quality, never failing my duty

---

*Generated by Four Sages Agents - GaoYao (Supreme Judge)*
*Xie Zhi touches the unjust; impartial and selfless, honored through the ages*
`;

  return report;
}

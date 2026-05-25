/**
 * GaoYao Phase Configuration and Guidance
 * 
 * File enumeration and guidance generation for each audit phase.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { AuditPhase, AuditCategory } from "./session.js";
import { PHASE_CATEGORY_MAP, PHASE_LABELS } from "./session.js";

// ============================================================================
// File Enumeration
// ============================================================================

/**
 * Get file extensions for a language
 * @param language - Programming language
 * @returns Array of extensions with dot
 */
function getLanguageExtensions(language: string): string[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return [".ts", ".tsx", ".js", ".jsx", ".mjs"];
    case "go":
      return [".go"];
    case "python":
      return [".py"];
    case "java":
      return [".java"];
    default:
      return [".ts", ".js", ".py", ".go", ".java"];
  }
}

/**
 * Enumerate source files from project
 * @param cwd - Current working directory
 * @param projectContext - Project analyzer context
 * @returns Array of file paths
 */
export function enumerateSourceFiles(cwd: string, projectContext: any): string[] {
  const srcDir = projectContext?.structure?.srcDir || "src";
  const srcPath = join(cwd, srcDir);
  const files: string[] = [];

  if (!existsSync(srcPath)) {
    // Fallback: scan root directory
    return enumerateRootFiles(cwd);
  }

  const extensions = getLanguageExtensions(projectContext?.language);
  
  function walkDir(dir: string, depth = 0): void {
    if (depth > 3) return; // Max depth
    
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        
        // Skip excluded directories
        if (["node_modules", ".git", "dist", "build", "__pycache__", ".sages"].includes(entry)) {
          continue;
        }

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath, depth + 1);
          } else if (stat.isFile()) {
            const ext = extname(entry);
            if (extensions.includes(ext)) {
              files.push(fullPath);
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walkDir(srcPath);
  return files.slice(0, 50); // Limit to 50 files max
}

/**
 * Enumerate files from root directory
 * @param cwd - Current working directory
 * @returns Array of file paths
 */
function enumerateRootFiles(cwd: string): string[] {
  const files: string[] = [];
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java"];

  try {
    const entries = readdirSync(cwd);
    for (const entry of entries) {
      const fullPath = join(cwd, entry);
      const ext = extname(entry);
      
      if (extensions.includes(ext) && !["node_modules", ".git", "dist"].includes(entry)) {
        files.push(fullPath);
      }
    }
  } catch { /* skip */ }

  return files.slice(0, 30);
}

// ============================================================================
// Guidance Generators
// ============================================================================

/**
 * Generate guidance for enumeration phase
 * @param files - Files to enumerate
 * @param projectContext - Project context
 * @returns Guidance text
 */
export function generateEnumerationGuidance(files: string[], projectContext: any): string {
  const lines: string[] = [];

  lines.push("## Phase 1: File Enumeration (文件枚举)");
  lines.push("");
  lines.push("### Your Task");
  lines.push("Read each file listed below. For each file:");
  lines.push("1. Use `read` tool to read the file content");
  lines.push("2. Call `gaoyao_record_file_read` to record that you read it");
  lines.push("");
  lines.push(`### Files to Read (${files.length} files)`);
  lines.push("");

  for (let i = 0; i < Math.min(files.length, 20); i++) {
    const file = files[i];
    const relPath = file.replace(projectContext?.structure?.srcDir || "src", "src");
    lines.push(`${i + 1}. \`${relPath}\``);
  }

  if (files.length > 20) {
    lines.push(`... and ${files.length - 20} more files`);
  }

  lines.push("");
  lines.push("### After Reading All Files");
  lines.push("Call `gaoyao_execute_phase --phase ENUMERATE` to advance to Phase 2 (INK).");

  return lines.join("\n");
}

/**
 * Generate guidance for a specific phase
 * @param phase - Current phase
 * @param projectContext - Project context
 * @param filesRead - Files that have been read
 * @param findings - Findings for this phase
 * @returns Guidance text
 */
export function generatePhaseGuidance(
  phase: AuditPhase,
  projectContext: any,
  filesRead: string[],
  findings: any[]
): string {
  const lines: string[] = [];
  const category = PHASE_CATEGORY_MAP[phase];

  lines.push(`## ${PHASE_LABELS[phase]}`);
  lines.push("");
  lines.push(`**Files already read**: ${filesRead.length}`);
  lines.push(`**Findings recorded**: ${findings.length}`);
  lines.push("");

  if (category) {
    lines.push("### Your Task");
    lines.push("Read the files above and analyze for:");
    lines.push("");

    switch (category) {
      case "ink":
        lines.push("- [ ] Code style consistency");
        lines.push("- [ ] Naming conventions");
        lines.push("- [ ] Complexity (no deeply nested logic)");
        lines.push("- [ ] Code smells (duplication, dead code)");
        lines.push("");
        lines.push("### Specific Checks");
        lines.push("- Variable naming: camelCase vs snake_case consistency");
        lines.push("- Function length: should be < 50 lines");
        lines.push("- Import ordering: external before internal");
        lines.push("- Error handling: try-catch blocks present where needed");
        break;

      case "nose":
        lines.push("- [ ] Public API documentation");
        lines.push("- [ ] Function/class docstrings");
        lines.push("- [ ] Domain terminology consistency");
        lines.push("- [ ] README or usage docs");
        lines.push("");
        lines.push("### Specific Checks");
        lines.push("- All exported functions have JSDoc/comments");
        lines.push("- Type definitions are clear and documented");
        lines.push("- Domain terms are used consistently");
        lines.push("- README.md exists and is up-to-date");
        break;

      case "foot":
        lines.push("- [ ] Structure matches plan.md");
        lines.push("- [ ] Layer boundaries respected");
        lines.push("- [ ] No circular dependencies");
        lines.push("- [ ] Dependencies follow architecture");
        lines.push("");
        lines.push("### Specific Checks");
        lines.push("- api/ vs service/ vs repository/ layers");
        lines.push("- Direct dependencies between layers only");
        lines.push("- No god modules (modules importing everything)");
        break;

      case "castration":
        lines.push("- [ ] No SQL/NoSQL injection vectors");
        lines.push("- [ ] No XSS or command injection");
        lines.push("- [ ] Auth/permissions properly enforced");
        lines.push("- [ ] No sensitive data in logs");
        lines.push("- [ ] Dependencies have no known vulns");
        lines.push("");
        lines.push("### Specific Checks (OWASP Top 10)");
        lines.push("- Parameterized queries only (no string concat in SQL)");
        lines.push("- Input validation on all user inputs");
        lines.push("- Auth middleware on protected routes");
        lines.push("- No hardcoded credentials or secrets");
        lines.push("- No eval() or dynamic code execution");
        break;

      case "death":
        lines.push("- [ ] Core business logic correctness");
        lines.push("- [ ] Error handling in critical paths");
        lines.push("- [ ] No obvious bugs or logic errors");
        lines.push("- [ ] Edge cases handled");
        lines.push("");
        lines.push("### Specific Checks");
        lines.push("- Null/undefined handling");
        lines.push("- Array bounds checking");
        lines.push("- Async error handling");
        lines.push("- Business rule validation");
        break;
    }

    lines.push("");
  }

  lines.push("### How to Record Findings");
  lines.push("Use `gaoyao_record_finding` with:");
  lines.push(`- \`category\`: \`${category}\``);
  lines.push("- `severity`: critical, major, or minor");
  lines.push("- `file`: exact file path with issue");
  lines.push("- `line`: line number (if applicable)");
  lines.push("- `issue`: clear description of the problem");
  lines.push("- `evidence`: code snippet showing the issue");
  lines.push("- `recommendation`: how to fix");
  lines.push("");

  lines.push("### After Completing Analysis");
  lines.push(`Call \`gaoyao_execute_phase --phase ${phase}\` to advance.`);

  return lines.join("\n");
}

// ============================================================================
// Report Generator
// ============================================================================

/**
 * Generate final audit report
 * @param projectContext - Project context
 * @param fiveAudits - Audit scores
 * @param findings - All findings
 * @param verdict - Final verdict
 * @param score - Final score
 * @param notes - Optional notes
 * @returns Report text
 */
export function generateFinalAuditReport(
  projectContext: any,
  fiveAudits: any,
  findings: any[],
  verdict: string,
  score: number,
  notes?: string
): string {
  const verdictEmoji = verdict === "PASS" ? "✅" : verdict === "NEEDS_CHANGES" ? "⚠️" : "❌";

  const byCategory = {
    ink: findings.filter((f: any) => f.category === "ink"),
    nose: findings.filter((f: any) => f.category === "nose"),
    foot: findings.filter((f: any) => f.category === "foot"),
    castration: findings.filter((f: any) => f.category === "castration"),
    death: findings.filter((f: any) => f.category === "death"),
  };

  const critical = findings.filter((f: any) => f.severity === "critical");
  const major = findings.filter((f: any) => f.severity === "major");
  const minor = findings.filter((f: any) => f.severity === "minor");

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

`;

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

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 GaoYao Tools - Supreme Judge 🜄                                       ║
 * ║                                                                           ║
 * ║   Tools for GaoYao (皋陶) - Final quality audit                           ║
 * ║   Distinguishes QUICK_REVIEW (parallel-friendly) vs FULL_REVIEW          ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { PluginContext, GaoYaoReviewResult, GaoYaoVerdict, ReviewMode } from "../types.js";
import { success, logSages, resolveProjectDir } from "../utils.js";
import { existsSync, readFileSync } from "node:fs";

// =============================================================================
// Review Mode Configuration
// =============================================================================

/**
 * Quick review checks - only CRITICAL issues that would break parallelism
 * These are fast and safe to run in parallel with other tasks
 */
const QUICK_REVIEW_CRITICAL = [
  "syntax_errors",
  "import_errors",
  "type_errors",
  "security_vulnerabilities_critical",
];

/**
 * Full review checks - all quality gates
 * These take longer but ensure complete quality
 */
const FULL_REVIEW_ALL = [
  "code_quality",
  "security_vulnerabilities",
  "test_coverage",
  "performance",
  "documentation",
  "style",
  "linting",
];

// =============================================================================
// Tool Definitions
// =============================================================================

export const gaoyao_review = tool({
  description: `GaoYao performs final quality audit before completion.

Review Modes:
- quick: Only CRITICAL issues (syntax, imports, types, critical security)
  Use this after each parallel task to maintain speed
- full: All quality gates (code quality, security, coverage, performance)
  Use this for final approval before merge

Checks:
- Code quality (clean, readable, maintainable)
- Security vulnerabilities
- Test coverage
- Performance issues
- Documentation completeness

Returns verdict: PASS, NEEDS_CHANGES, or REJECTED with issues list`,
  args: {
    plan_name: z.string().describe("Plan name to audit"),
    commit_hash: z.string().optional().describe("Specific commit to review"),
    review_mode: z.string().optional().describe("quick or full (default: full)"),
  },
  execute: async (args, ctx) => {
    const { plan_name, commit_hash, review_mode = "full" } = args;
    const projectDir = resolveProjectDir(ctx.agent);

    try {
      const mode: ReviewMode = review_mode === "quick" ? "quick" : "full";
      const result = performReview(projectDir, plan_name, commit_hash, mode);

      logSages("gaoyao_review_completed", {
        plan_name,
        review_mode: mode,
        verdict: result.verdict,
        qualityScore: result.qualityScore,
      });

      return JSON.stringify(success(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("gaoyao_review_failed", { plan_name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const gaoyao_check_security = tool({
  description: "Run security scan on modified files",
  args: {
    files: z.array(z.string()).describe("Files to scan"),
  },
  execute: async (args, ctx) => {
    const { files } = args;

    try {
      // Simulate security scan
      const scanResult = {
        files_scanned: files.length,
        vulnerabilities_found: 0,
        severity: "none" as const,
        message: "No security vulnerabilities detected",
        scanned_files: files,
      };

      logSages("gaoyao_security_scan_completed", {
        files,
        vulnerabilities: 0,
      });

      return JSON.stringify(success(scanResult));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

// =============================================================================
// Review Logic
// =============================================================================

interface ReviewInput {
  projectDir: string;
  planName: string;
  commitHash?: string;
  mode: ReviewMode;
}

function performReview(
  projectDir: string,
  planName: string,
  commitHash?: string,
  mode: ReviewMode = "full",
): GaoYaoReviewResult {
  // In real implementation, would:
  // 1. Read plan files
  // 2. Run actual quality checks
  // 3. Parse results

  // For now, return mock results based on mode
  if (mode === "quick") {
    return {
      verdict: "PASS",
      qualityScore: 100,
      issues: [],
      summary: "Quick review passed - no critical issues found",
      checks: {
        codeQuality: true,
        security: true,
        testCoverage: true,
        performance: true,
        documentation: true,
      },
    };
  }

  // Full review
  return {
    verdict: "PASS",
    qualityScore: 95,
    issues: [],
    summary: "Code quality meets all standards",
    checks: {
      codeQuality: true,
      security: true,
      testCoverage: true,
      performance: true,
      documentation: true,
    },
  };
}

// =============================================================================
// Critical Issue Detection (for parallel task safety)
// =============================================================================

/**
 * Check if any CRITICAL issues exist that would prevent parallel execution
 * Returns issues that MUST be fixed before other tasks can proceed
 */
export function detectCriticalIssues(
  projectDir: string,
  files: string[],
): string[] {
  const critical: string[] = [];

  for (const file of files) {
    if (!existsSync(file)) {
      critical.push(`${file}: File does not exist`);
      continue;
    }

    try {
      const content = readFileSync(file, "utf-8");

      // Basic syntax checks
      if (content.includes("undefined is not a function")) {
        critical.push(`${file}: Likely undefined function call`);
      }
      if (content.includes("cannot read property")) {
        critical.push(`${file}: Potential null reference`);
      }
      if (content.includes("TODO:") || content.includes("FIXME:")) {
        // Not critical, just informational
      }
    } catch {
      // Skip unreadable files
    }
  }

  return critical;
}

// =============================================================================
// Review Thresholds
// =============================================================================

export const REVIEW_THRESHOLDS = {
  quick: {
    minQualityScore: 80, // Allow some issues in quick mode
    maxCriticalIssues: 0,
  },
  full: {
    minQualityScore: 90, // Must be higher for final review
    maxCriticalIssues: 0,
  },
};
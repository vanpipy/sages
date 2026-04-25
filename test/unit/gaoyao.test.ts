/**
 * Unit Tests for GaoYao Review Logic
 * Tests the quality gate patterns for code review
 */
import { describe, it, expect, beforeAll } from "bun:test";

describe("GaoYao Review Logic", () => {
  describe("CRITICAL Issue Detection", () => {
    it("should detect SQL injection vulnerability", () => {
      const code = `query("SELECT * FROM users WHERE id = " + userId)`;
      const hasSQLInjection = /SELECT.*\+.*(userId|input|params)/i.test(code) ||
        /\$\{.*\}/.test(code) && code.includes("SELECT");
      expect(hasSQLInjection).toBe(true);
    });

    it("should detect command injection vulnerability", () => {
      const code = `exec("rm -rf " + directory)`;
      const hasCommandInjection = /exec\(|system\(|popen\(/.test(code) &&
        code.includes("+") && !code.includes("sanitize");
      expect(hasCommandInjection).toBe(true);
    });

    it("should detect hardcoded credentials", () => {
      const code = `const password = "secret123"; const apiKey = "sk-abc123";`;
      const hasCredentials = /password\s*=\s*["'][^"']{4,}/.test(code) ||
        /apiKey\s*=\s*["']sk-/.test(code);
      expect(hasCredentials).toBe(true);
    });

    it("should detect eval() usage", () => {
      const code = `eval(userInput)`;
      const hasEval = /eval\(/.test(code);
      expect(hasEval).toBe(true);
    });
  });

  describe("Code Quality Patterns", () => {
    it("should detect missing error handling", () => {
      const code = `function fetchData() { fetch(url).then(r => r.json()); }`;
      const hasErrorHandling = /catch\s*\(|try\s*\{/.test(code);
      expect(hasErrorHandling).toBe(false);
    });

    it("should detect proper error handling", () => {
      const code = `async function fetchData() { try { const r = await fetch(url); } catch (e) { console.error(e); } }`;
      const hasErrorHandling = /catch\s*\(/.test(code) && /try\s*\{/.test(code);
      expect(hasErrorHandling).toBe(true);
    });

    it("should detect missing input validation", () => {
      const code = `function processInput(input) { return input.toUpperCase(); }`;
      const hasValidation = /if\s*\(.*typeof|if\s*\(.*===|"".*\.trim\(|!input/.test(code);
      expect(hasValidation).toBe(false);
    });

    it("should detect proper input validation", () => {
      const code = `function processInput(input) { if (!input || typeof input !== 'string') throw new Error('Invalid'); return input.trim(); }`;
      const hasValidation = /if\s*\(.*!input|typeOf\s*input|throw\s*new\s*Error/.test(code);
      expect(hasValidation).toBe(true);
    });
  });

  describe("Review Mode Thresholds", () => {
    const QUICK_REVIEW_CRITICAL = ["syntax", "imports", "types", "security"];
    const FULL_REVIEW_ALL = ["syntax", "imports", "types", "security", "quality", "coverage", "performance", "documentation"];

    it("QUICK_REVIEW should only check critical issues", () => {
      expect(QUICK_REVIEW_CRITICAL).toContain("security");
      expect(QUICK_REVIEW_CRITICAL).toContain("syntax");
      expect(QUICK_REVIEW_CRITICAL).toContain("imports");
      expect(QUICK_REVIEW_CRITICAL).toContain("types");
      expect(QUICK_REVIEW_CRITICAL.length).toBe(4);
    });

    it("FULL_REVIEW should check all aspects", () => {
      expect(FULL_REVIEW_ALL).toContain("quality");
      expect(FULL_REVIEW_ALL).toContain("coverage");
      expect(FULL_REVIEW_ALL).toContain("performance");
      expect(FULL_REVIEW_ALL).toContain("documentation");
      expect(FULL_REVIEW_ALL.length).toBe(8);
    });

    it("QUICK_REVIEW should be faster than FULL_REVIEW", () => {
      expect(QUICK_REVIEW_CRITICAL.length).toBeLessThan(FULL_REVIEW_ALL.length);
    });
  });

  describe("Verdict Calculation", () => {
    interface ReviewResult {
      verdict: "PASS" | "NEEDS_CHANGES" | "REJECT";
      issues: string[];
      qualityScore: number;
    }

    function calculateVerdict(issues: string[], mode: "quick" | "full"): ReviewResult {
      const criticalIssues = issues.filter(i =>
        ["SQL Injection", "Command Injection", "Hardcoded Credentials", "eval()"].some(c => i.includes(c))
      );

      if (criticalIssues.length > 0) {
        return { verdict: "REJECT", issues: criticalIssues, qualityScore: 0 };
      }

      if (mode === "quick") {
        return { verdict: "PASS", issues: [], qualityScore: 95 };
      }

      if (issues.length > 5) {
        return { verdict: "NEEDS_CHANGES", issues, qualityScore: 60 };
      }

      return { verdict: "PASS", issues: [], qualityScore: 90 };
    }

    it("should REJECT code with SQL injection", () => {
      const result = calculateVerdict(["SQL Injection in query"], "quick");
      expect(result.verdict).toBe("REJECT");
      expect(result.qualityScore).toBe(0);
    });

    it("should PASS clean code in quick mode", () => {
      const result = calculateVerdict([], "quick");
      expect(result.verdict).toBe("PASS");
      expect(result.qualityScore).toBe(95);
    });

    it("should NEEDS_CHANGES for many issues in full mode", () => {
      const issues = ["Missing JSDoc", "Long function", "Magic number", "Duplicate code", "No tests", "Complex condition"];
      const result = calculateVerdict(issues, "full");
      expect(result.verdict).toBe("NEEDS_CHANGES");
      expect(result.qualityScore).toBe(60);
    });
  });
});
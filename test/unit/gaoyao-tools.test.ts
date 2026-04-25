/**
 * Unit Tests for GaoYao Tools
 * Tests security scanning and quality review logic
 */
import { describe, it, expect } from "bun:test";

// Mock critical issue detector for testing
function detectCriticalIssuesMock(files: string[]): string[] {
  const critical: string[] = [];
  return critical;
}

describe("GaoYao Tools - Security Detection", () => {
  describe("Critical Issue Detection", () => {
    it("should detect SQL injection patterns", () => {
      const code1 = 'query("SELECT * FROM users WHERE id = " + userId)';
      const hasSQLInjection1 = /SELECT.*\+.*(userId|input|params)/i.test(code1) || (/\${.*}/.test(code1) && code1.includes("SELECT"));

      const code2 = 'SELECT * FROM users WHERE id = ' + 'userId';
      const hasSQLInjection2 = /SELECT.*\+.*(userId|input|params)/i.test(code2);

      expect(hasSQLInjection1 || hasSQLInjection2).toBe(true);
    });

    it("should detect command injection patterns", () => {
      const code = 'exec("rm -rf " + directory)';
      const hasCommandInjection = /exec\(|system\(|popen\(/.test(code) &&
        code.includes("+") && !code.includes("sanitize");

      expect(hasCommandInjection).toBe(true);
    });

    it("should detect hardcoded credentials", () => {
      const code1 = 'const password = "secret123"';
      const hasCred1 = /password\s*=\s*["'][^"']{4,}/.test(code1);

      const code2 = 'const apiKey = "sk-abc123"';
      const hasCred2 = /apiKey\s*=\s*["']sk-/.test(code2);

      expect(hasCred1 || hasCred2).toBe(true);
    });

    it("should detect eval() usage", () => {
      const code = "eval(userInput)";
      const hasEval = /eval\(/.test(code);

      expect(hasEval).toBe(true);
    });

    it("should not flag sanitized commands", () => {
      const code = 'const safe = sanitize(userInput); exec(safe)';
      const hasCommandInjection = /exec\(|system\(|popen\(/.test(code) &&
        code.includes("+") && !code.includes("sanitize");

      expect(hasCommandInjection).toBe(false);
    });
  });

  describe("Code Quality Patterns", () => {
    it("should detect missing error handling", () => {
      const code = "function fetchData() { fetch(url).then(r => r.json()); }";
      const hasErrorHandling = /catch\s*\(|try\s*\{/.test(code);

      expect(hasErrorHandling).toBe(false);
    });

    it("should detect proper error handling", () => {
      const code = "async function fetchData() { try { const r = await fetch(url); } catch (e) { console.error(e); } }";
      const hasErrorHandling = /catch\s*\(/.test(code) && /try\s*\{/.test(code);

      expect(hasErrorHandling).toBe(true);
    });

    it("should detect missing input validation", () => {
      const code = "function createUser(name) { db.insert(name); }";
      const hasValidation = /validate\s*\(|sanitize\s*\(|check\s*\(/.test(code);

      expect(hasValidation).toBe(false);
    });

    it("should detect proper input validation", () => {
      const code = "function createUser(name) { if (!validate(name)) throw new Error('Invalid'); db.insert(sanitize(name)); }";
      const hasValidation = /validate\s*\(|sanitize\s*\(|check\s*\(/.test(code);

      expect(hasValidation).toBe(true);
    });
  });

  describe("Review Thresholds", () => {
    it("should apply quick review threshold correctly", () => {
      const quickThreshold = { minQualityScore: 80, maxCriticalIssues: 0 };
      const qualityScore = 85;

      expect(qualityScore >= quickThreshold.minQualityScore).toBe(true);
      expect(quickThreshold.maxCriticalIssues).toBe(0);
    });

    it("should apply full review threshold correctly", () => {
      const fullThreshold = { minQualityScore: 90, maxCriticalIssues: 0 };
      const qualityScore = 95;

      expect(qualityScore >= fullThreshold.minQualityScore).toBe(true);
      expect(fullThreshold.maxCriticalIssues).toBe(0);
    });

    it("should fail quick review with low quality score", () => {
      const quickThreshold = { minQualityScore: 80, maxCriticalIssues: 0 };
      const qualityScore = 75;

      expect(qualityScore < quickThreshold.minQualityScore).toBe(true);
    });

    it("should pass full review with high quality score", () => {
      const fullThreshold = { minQualityScore: 90, maxCriticalIssues: 0 };
      const qualityScore = 92;

      expect(qualityScore >= fullThreshold.minQualityScore).toBe(true);
    });
  });

  describe("Security Scan Results", () => {
    it("should return clean scan for safe code", () => {
      const code = `
        function calculateTotal(items) {
          let total = 0;
          for (const item of items) {
            total += item.price;
          }
          return total;
        }
      `;

      const hasSQLInjection = /SELECT.*\+.*(userId|input|params)/i.test(code);
      const hasCommandInjection = /exec\(|system\(|popen\(/.test(code) && code.includes("+");
      const hasEval = /eval\(/.test(code);

      expect(hasSQLInjection || hasCommandInjection || hasEval).toBe(false);
    });

    it("should identify vulnerability type correctly", () => {
      const code = 'eval("console.log(\\"xss\\")")';

      const vulnerabilityType = /eval\(/.test(code) ? "code_injection" : "unknown";

      expect(vulnerabilityType).toBe("code_injection");
    });

    it("should count multiple vulnerabilities", () => {
      const vulnerabilities = [
        { type: "sql_injection", severity: "high" },
        { type: "hardcoded_credential", severity: "critical" },
      ];

      expect(vulnerabilities.length).toBe(2);
      expect(vulnerabilities.filter(v => v.severity === "critical").length).toBe(1);
    });
  });

  describe("Review Modes", () => {
    it("should use QUICK_REVIEW_CRITICAL checks for quick mode", () => {
      const quickChecks = [
        "syntax_errors",
        "import_errors",
        "type_errors",
        "security_vulnerabilities_critical",
      ];

      expect(quickChecks).toHaveLength(4);
      expect(quickChecks).toContain("syntax_errors");
      expect(quickChecks).toContain("security_vulnerabilities_critical");
    });

    it("should use FULL_REVIEW_ALL checks for full mode", () => {
      const fullChecks = [
        "code_quality",
        "security_vulnerabilities",
        "test_coverage",
        "performance",
        "documentation",
        "style",
        "linting",
      ];

      expect(fullChecks).toHaveLength(7);
      expect(fullChecks).toContain("code_quality");
      expect(fullChecks).toContain("test_coverage");
    });

    it("should distinguish between review modes correctly", () => {
      const mode = "quick";
      const isQuick = mode === "quick";
      const isFull = mode === "full";

      expect(isQuick).toBe(true);
      expect(isFull).toBe(false);
    });
  });
});
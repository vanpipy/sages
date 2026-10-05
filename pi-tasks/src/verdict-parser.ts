/**
 * verdict-parser.ts — Parses the Reviewer's final message into a structured verdict.
 *
 * The Reviewer agent is required to emit a fenced ```yaml block at the end
 * of its final message. The parser scans for the LAST ```yaml fence,
 * extracts the YAML body, and decodes a flat structure:
 *
 *   verdict: CLEAN | NEEDS_WORK
 *   findings:
 *     - severity: minor | major | critical
 *       issue: <string>
 *       location: <string>      (optional)
 *       recommendation: <string>(optional)
 *   scope_check: pass | fail | absent
 *     scope_check_skipped: <reason>  (required when scope_check: absent)
 *   anti_goal_check: pass | fail | absent
 *     anti_goal_check_skipped: <reason>  (required when anti_goal_check: absent)
 *   evidence:
 *     typecheck: <output line>
 *     tests: <output summary>
 *     lint: <output summary>
 *     files_read: [paths]
 *     commands_run: [cmds]
 *
 * GC-2026-prompt-parser-contract-cleanup additions:
 *   1. **File-fallback path** — when the message has no yaml fence, fall
 *      back to reading the durable \`.pi/orchestrator/verdict-{task_id}.md\`
 *      file the Reviewer writes via atomic rename before emitting the
 *      final message. The caller passes the path via \`opts.verdictFilePath\`.
 *   2. **Strict dimension enforcement** — \`scope_check: pass\` and
 *      \`anti_goal_check: pass\` are required. \`fail\` → NEEDS_WORK.
 *      \`absent\` → only counts as satisfied when paired with a non-empty
 *      \`<dim>_skipped\` reason in evidence; missing skip-reason → NEEDS_WORK.
 *   3. **CLEAN + non-empty findings is malformed** — the parser treats
 *      that combination as NEEDS_WORK (a CLEAN verdict contradicts the
 *      existence of findings; the Reviewer meant NEEDS_WORK).
 *
 * Default-on-failure: any parsing problem returns NEEDS_WORK with empty
 * findings. The reviewer must explicitly mark CLEAN with evidence; missing
 * evidence should never produce a spurious clean bill of health.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

export type FindingSeverity = "minor" | "major" | "critical";

export interface Finding {
  severity: FindingSeverity;
  issue: string;
  location?: string;
  recommendation?: string;
}

export interface ReviewerVerdict {
  verdict: "CLEAN" | "NEEDS_WORK";
  findings?: Finding[];
  scope_check?: "pass" | "fail" | "absent";
  scope_check_skipped?: string;
  anti_goal_check?: "pass" | "fail" | "absent";
  anti_goal_check_skipped?: string;
}

export interface ParseVerdictOptions {
  /**
   * Absolute path to a durable verdict file (typically
   * \`.pi/orchestrator/verdict-{task_id}.md\`) the Reviewer writes via atomic
   * rename before emitting the final message. When the message has no yaml
   * fence (e.g. max_turns hard-abort truncated the message), the parser
   * falls back to reading this file. Empty / undefined = no fallback.
   */
  verdictFilePath?: string;
}

const VERDICT_FENCE = "```yaml\n";

/**
 * Parse the Reviewer's final message into a structured verdict.
 *
 * Behavior contract (GC-2026-prompt-parser-contract-cleanup):
 *  - No message AND no verdict file → NEEDS_WORK (safe default).
 *  - No ```yaml fence in message → fall back to verdictFilePath (if provided).
 *  - Verdict file also missing/malformed → NEEDS_WORK.
 *  - verdict field present but not CLEAN (case-insensitive) → NEEDS_WORK.
 *  - `verdict: CLEAN` + `findings: non-empty` → malformed → NEEDS_WORK.
 *  - `scope_check: fail` → NEEDS_WORK (regardless of verdict).
 *  - `anti_goal_check: fail` → NEEDS_WORK.
 *  - `scope_check: absent` without `scope_check_skipped:` → NEEDS_WORK.
 *  - `anti_goal_check: absent` without `anti_goal_check_skipped:` → NEEDS_WORK.
 *  - `findings: []` (inline empty list) is honored as zero findings.
 *  - `findings:` with `- key: val` items is parsed line-by-line.
 *  - Continuation lines inside a finding (indented key:value) update the
 *    current finding only when the key is a known finding property.
 *  - The LAST fence is used when multiple are present.
 */
export function parseReviewerVerdict(
  message: string | undefined,
  opts?: ParseVerdictOptions,
): ReviewerVerdict {
  const yamlText = extractLastYamlFence(message) ?? readVerdictFile(opts?.verdictFilePath);
  if (!yamlText) {
    return { verdict: "NEEDS_WORK", findings: [] };
  }

  try {
    const obj: Record<string, unknown> = {};
    let currentFindings: Finding[] = [];
    let inFindings = false;
    let currentFinding: Finding | null = null;
    for (const rawLine of yamlText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "findings:" || line === "findings: []") {
        if (line === "findings: []") {
          obj.findings = [];
        } else {
          inFindings = true;
        }
        continue;
      }
      if (inFindings && line.startsWith("- ")) {
        if (currentFinding) currentFindings.push(currentFinding);
        currentFinding = { severity: "minor", issue: "" };
        const rest = line.slice(2);
        const colonIdx = rest.indexOf(":");
        if (colonIdx > 0) {
          const key = rest.slice(0, colonIdx).trim();
          const val = rest.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
          applyFindingKey(currentFinding, key, val);
        }
        continue;
      }
      if (inFindings && currentFinding && line.includes(":")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
          const applied = tryApplyFindingKey(currentFinding, key, val);
          if (!applied) {
            if (currentFinding) currentFindings.push(currentFinding);
            currentFinding = null;
            inFindings = false;
            obj.findings = currentFindings;
            obj[key] = val;
          }
        }
        continue;
      }
      if (inFindings) {
        if (currentFinding) currentFindings.push(currentFinding);
        currentFinding = null;
        inFindings = false;
        obj.findings = currentFindings;
      }
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
        obj[key] = val;
      }
    }
    if (inFindings && currentFinding) currentFindings.push(currentFinding);
    if (currentFindings.length > 0) obj.findings = currentFindings;

    const verdictRaw = String(obj.verdict ?? "").toUpperCase();
    const verdictDeclared = verdictRaw === "CLEAN" ? "CLEAN" : "NEEDS_WORK";

    // GC-2026-prompt-parser-contract-cleanup #3: CLEAN + non-empty findings
    // is a contradiction. Treat as malformed → NEEDS_WORK.
    const findings = Array.isArray(obj.findings) ? (obj.findings as Finding[]) : [];
    if (verdictDeclared === "CLEAN" && findings.length > 0) {
      return { verdict: "NEEDS_WORK", findings };
    }

    // GC-2026-prompt-parser-contract-cleanup #2: strict dimension checks.
    const scope_check = normalizeDim(obj.scope_check);
    const anti_goal_check = normalizeDim(obj.anti_goal_check);
    const scope_check_skipped =
      typeof obj.scope_check_skipped === "string" && obj.scope_check_skipped.trim().length > 0
        ? obj.scope_check_skipped.trim()
        : undefined;
    const anti_goal_check_skipped =
      typeof obj.anti_goal_check_skipped === "string" &&
      obj.anti_goal_check_skipped.trim().length > 0
        ? obj.anti_goal_check_skipped.trim()
        : undefined;

    const dimensionFails =
      scope_check === "fail" ||
      anti_goal_check === "fail" ||
      (scope_check === "absent" && !scope_check_skipped) ||
      (anti_goal_check === "absent" && !anti_goal_check_skipped);

    return {
      verdict: dimensionFails ? "NEEDS_WORK" : verdictDeclared,
      findings,
      scope_check,
      scope_check_skipped,
      anti_goal_check,
      anti_goal_check_skipped,
    };
  } catch {
    return { verdict: "NEEDS_WORK", findings: [] };
  }
}

function normalizeDim(raw: unknown): "pass" | "fail" | "absent" | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.toLowerCase().trim();
  if (v === "pass") return "pass";
  if (v === "fail") return "fail";
  if (v === "absent") return "absent";
  return undefined;
}

/**
 * Extract the LAST \`\`\`yaml fence body from a message. Returns null if no
 * fence is found (or the closing fence is missing).
 */
function extractLastYamlFence(message: string | undefined): string | null {
  if (!message) return null;
  const lastOpen = message.lastIndexOf(VERDICT_FENCE);
  if (lastOpen < 0) return null;
  const closeAfterOpen = message.indexOf("```", lastOpen + VERDICT_FENCE.length);
  if (closeAfterOpen < 0) return null;
  return message.slice(lastOpen + VERDICT_FENCE.length, closeAfterOpen).trim();
}

/**
 * Read the durable verdict file at `verdictFilePath`. Returns null if the
 * path is unset, the file is missing, or read/parse fails. The file is the
 * GC-2026-prompt-parser-contract-cleanup durable backup path — the Reviewer
 * writes it via atomic rename before emitting the final message, so a
 * max_turns hard abort that truncates the message still leaves the verdict
 * recoverable.
 *
 * GC-2026-path-B-streaming note: a separate file mtime cache layer belongs in
 * `verdict-parser-helpers.ts` once we start parsing verdicts at high frequency;
 * the parser itself stays synchronous and pure.
 */
function readVerdictFile(verdictFilePath: string | undefined): string | null {
  if (!verdictFilePath) return null;
  try {
    if (!existsSync(verdictFilePath)) return null;
    const stat = statSync(verdictFilePath);
    if (!stat.isFile() || stat.size === 0) return null;
    return readFileSync(verdictFilePath, "utf-8");
  } catch {
    return null;
  }
}

function applyFindingKey(finding: Finding, key: string, val: string): void {
  if (key === "severity") finding.severity = val as FindingSeverity;
  else if (key === "issue") finding.issue = val;
  else if (key === "location") finding.location = val;
  else if (key === "recommendation") finding.recommendation = val;
}

function tryApplyFindingKey(finding: Finding, key: string, val: string): boolean {
  if (key === "severity" || key === "issue" || key === "location" || key === "recommendation") {
    applyFindingKey(finding, key, val);
    return true;
  }
  return false;
}

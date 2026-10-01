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
 *   scope_check: pass | fail    (optional)
 *   anti_goal_check: pass | fail (optional)
 *
 * This is a faithful port of path A's parser (`pi-orchestrator/src/workflow-run.ts:228-335`)
 * with the import path changed. Keeping it byte-equivalent means the same
 * Reviewer prompts work in both paths.
 *
 * Default-on-failure: any parsing problem returns NEEDS_WORK with empty
 * findings. The reviewer must explicitly mark CLEAN with evidence; missing
 * evidence should never produce a spurious clean bill of health.
 */

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
  scope_check?: string;
  anti_goal_check?: string;
}

const VERDICT_FENCE = "```yaml\n";

/**
 * Parse the Reviewer's final message into a structured verdict.
 *
 * Behavior contract (mirrors path A):
 *  - No message → NEEDS_WORK (safe default).
 *  - No ```yaml fence → NEEDS_WORK.
 *  - Malformed YAML → NEEDS_WORK.
 *  - verdict field present but not CLEAN (case-insensitive) → NEEDS_WORK.
 *  - `findings: []` (inline empty list) is honored as zero findings.
 *  - `findings:` with `- key: val` items is parsed line-by-line.
 *  - Continuation lines inside a finding (indented key:value) update the
 *    current finding only when the key is a known finding property.
 *  - The LAST fence is used when multiple are present.
 */
export function parseReviewerVerdict(message: string | undefined): ReviewerVerdict {
  if (!message) {
    return { verdict: "NEEDS_WORK", findings: [] };
  }

  const lastOpen = message.lastIndexOf(VERDICT_FENCE);
  const closeAfterOpen = lastOpen >= 0 ? message.indexOf("```", lastOpen + VERDICT_FENCE.length) : -1;
  if (lastOpen < 0 || closeAfterOpen < 0) {
    return { verdict: "NEEDS_WORK", findings: [] };
  }

  const yamlText = message.slice(lastOpen + VERDICT_FENCE.length, closeAfterOpen).trim();
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
    const verdict = verdictRaw === "CLEAN" ? "CLEAN" : "NEEDS_WORK";
    return {
      verdict,
      findings: Array.isArray(obj.findings) ? (obj.findings as Finding[]) : [],
      scope_check: typeof obj.scope_check === "string" ? obj.scope_check : undefined,
      anti_goal_check: typeof obj.anti_goal_check === "string" ? obj.anti_goal_check : undefined,
    };
  } catch {
    return { verdict: "NEEDS_WORK", findings: [] };
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

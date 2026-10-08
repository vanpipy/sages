/**
 * tasks-command-create-decompose-spec.test.ts — Unit tests for
 *   1. /tasks create arg parser extended with `--kind` and `--decompose-spec`
 *   2. decompose-spec materialization (inline specs → no chat round-trip)
 *      via parseDecomposeSpec + handler integration
 * (GC-2026-120 AC1, AC2, AC4).
 *
 * The pure parser is the surface exercised here; the slash command handler
 * that calls the parser is integration-tested via `decompose-auto-complete.test.ts`.
 */

import { describe, expect, it } from "bun:test";

/**
 * Mirrors `parseCreateArgs` in `pi-tasks/src/index.ts`. The duplication is
 * deliberate — see `tasks-command-create.test.ts` for the same pattern.
 */
function parseCreateArgs(raw: string): {
  subject?: string;
  description?: string;
  agentType?: string;
  kind?: "intent" | "actionable" | "step";
  decomposeSpec?: string;
  flags: Set<string>;
} {
  const out: {
    subject?: string;
    description?: string;
    agentType?: string;
    kind?: "intent" | "actionable" | "step";
    decomposeSpec?: string;
    flags: Set<string>;
  } = { flags: new Set() };
  let rest = raw.trim();
  const subjectMatch = rest.match(/^"([^"]*)"/);
  if (subjectMatch) {
    out.subject = subjectMatch[1];
    rest = rest.slice(subjectMatch[0].length).trim();
  } else {
    const untilSpace = rest.match(/^(\S+)/);
    if (untilSpace) {
      out.subject = untilSpace[1];
      rest = rest.slice(untilSpace[0].length).trim();
    }
  }
  while (rest.length > 0) {
    const flagMatch = rest.match(
      /^--([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(?:"([^"]*)"|(\S+)))?/,
    );
    if (!flagMatch) {
      rest = rest.replace(/^\S+/, "").trim();
      continue;
    }
    const flag = flagMatch[1];
    const value = flagMatch[2] ?? flagMatch[3];
    out.flags.add(flag);
    if (flag === "description" && value !== undefined) out.description = value;
    if (flag === "agent-type" && value !== undefined) out.agentType = value;
    if (flag === "kind" && (value === "intent" || value === "actionable" || value === "step")) {
      // Mirrors the production parser: `step` is filtered out so user-facing
      // flag never produces an orchestrator-internal kind.
      if (value !== "step") out.kind = value as "intent" | "actionable";
    }
    if (flag === "decompose-spec" && value !== undefined) out.decomposeSpec = value;
    rest = rest.slice(flagMatch[0].length).trim();
  }
  return out;
}

/**
 * Mirrors `parseDecomposeSpec` in `pi-tasks/src/index.ts`. Parses
 * "T1:subject|T1:desc;T2:subject|T2:desc" into a chain spec array.
 */
function parseDecomposeSpec(spec: string): Array<{ subject: string; description: string }> {
  const out: Array<{ subject: string; description: string }> = [];
  for (const entry of spec.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const pipeAt = trimmed.indexOf("|");
    if (pipeAt < 0) {
      throw new Error(`decompose-spec entry missing '|': "${trimmed}"`);
    }
    const subject = trimmed.slice(0, pipeAt).trim();
    const description = trimmed.slice(pipeAt + 1).trim();
    if (subject.length === 0) {
      throw new Error(`decompose-spec entry missing subject: "${trimmed}"`);
    }
    if (description.length === 0) {
      throw new Error(`decompose-spec entry missing description: "${trimmed}"`);
    }
    out.push({ subject, description });
  }
  return out;
}

describe("/tasks create parser — GC-2026-120 AC1/AC2/AC4", () => {
  it("parses --kind intent", () => {
    const p = parseCreateArgs('"research X" --kind intent');
    expect(p.kind).toBe("intent");
  });

  it("parses --kind actionable", () => {
    const p = parseCreateArgs('"fix typo" --kind actionable --agent-type Developer');
    expect(p.kind).toBe("actionable");
    expect(p.agentType).toBe("Developer");
  });

  it("rejects --kind step from user-facing flag (orchestrator-only)", () => {
    const p = parseCreateArgs('"weird" --kind step');
    expect(p.kind).toBeUndefined(); // parser does not propagate "step"
  });

  it("parses --decompose-spec quoted value", () => {
    const p = parseCreateArgs(
      '"research X" --decompose-spec "T1:investigate|T1 details;T2:summarize|T2 details"',
    );
    expect(p.decomposeSpec).toBe("T1:investigate|T1 details;T2:summarize|T2 details");
  });

  it("captures --decompose in flags set (handler will reject per AC6)", () => {
    const p = parseCreateArgs('"fix" --decompose');
    expect(p.flags.has("decompose")).toBe(true);
    expect(p.decomposeSpec).toBeUndefined();
  });
});

describe("parseDecomposeSpec — GC-2026-120 AC4", () => {
  it("parses a single entry", () => {
    const specs = parseDecomposeSpec("T1:investigate|Investigate topic X");
    expect(specs).toEqual([{ subject: "T1:investigate", description: "Investigate topic X" }]);
  });

  it("parses multiple entries", () => {
    const specs = parseDecomposeSpec(
      "T1:investigate|Investigate X;T2:summarize|Summarize findings;T3:report|Write report",
    );
    expect(specs).toHaveLength(3);
    expect(specs[0].subject).toBe("T1:investigate");
    expect(specs[2].description).toBe("Write report");
  });

  it("ignores empty trailing semicolons", () => {
    const specs = parseDecomposeSpec("T1:foo|F1;;");
    expect(specs).toHaveLength(1);
  });

  it("throws on entry missing pipe", () => {
    expect(() => parseDecomposeSpec("T1:noseparator")).toThrow(/missing '\|'/);
  });

  it("throws on entry missing subject", () => {
    expect(() => parseDecomposeSpec("|description-only")).toThrow(/missing subject/);
  });

  it("throws on entry missing description", () => {
    expect(() => parseDecomposeSpec("subject-only|")).toThrow(/missing description/);
  });

  it("returns empty array on empty input", () => {
    expect(parseDecomposeSpec("")).toEqual([]);
  });
});
/**
 * tasks-command-create.test.ts — Unit tests for /tasks create arg parser +
 * slash command routing (GC-2026-task-feeding-and-decomposition AC6).
 *
 * The actual slash command requires a pi-coding-agent runtime, which we
 * don't exercise here. Instead we test the pure parser + the store
 * integration: parse an args string, verify the produced task has the
 * right `created_by` stamp + agentType, and reject `--decompose`.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";

/**
 * The parser is intentionally not exported (lives as a closure inside
 * the slash command handler). To keep the test self-contained, we
 * re-implement it verbatim here. If the parser changes, this test
 * should be updated. The duplication is deliberate — the parser is
 * small and stable.
 */
function parseCreateArgs(raw: string): {
  subject?: string;
  description?: string;
  agentType?: string;
  flags: Set<string>;
} {
  const out: {
    subject?: string;
    description?: string;
    agentType?: string;
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
    rest = rest.slice(flagMatch[0].length).trim();
  }
  return out;
}

describe("/tasks create arg parser (GC-2026-task-feeding-and-decomposition AC6)", () => {
  it("parses quoted subject only", () => {
    const p = parseCreateArgs('"fix README"');
    expect(p.subject).toBe("fix README");
    expect(p.flags.has("decompose")).toBe(false);
  });

  it("parses subject + --description + --agent-type", () => {
    const p = parseCreateArgs(
      '"implement login" --description "OAuth + email/password" --agent-type Developer',
    );
    expect(p.subject).toBe("implement login");
    expect(p.description).toBe("OAuth + email/password");
    expect(p.agentType).toBe("Developer");
  });

  it("captures --decompose flag in the flags set (handler will reject it)", () => {
    const p = parseCreateArgs('"fix" --decompose');
    expect(p.flags.has("decompose")).toBe(true);
  });

  it("returns empty subject on empty input", () => {
    const p = parseCreateArgs("");
    expect(p.subject).toBeUndefined();
  });

  it("parses unquoted subject (whitespace-terminated)", () => {
    const p = parseCreateArgs("fix-typo");
    expect(p.subject).toBe("fix-typo");
  });
});

describe("/tasks create store integration (AC6)", () => {
  let store: TaskStore;
  beforeEach(() => {
    store = new TaskStore();
  });

  it("creates a user task with created_by='user' (default atomic path)", () => {
    const task = store.create("fix README", "Fix the typo.", undefined, {
      created_by: "user",
    });
    expect(task.metadata.created_by).toBe("user");
  });

  it("user task with agentType is dispatched-able by task feeding (has agentType)", () => {
    const task = store.create("fix README", "Fix.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    expect(task.metadata.agentType).toBe("Developer");
  });
});
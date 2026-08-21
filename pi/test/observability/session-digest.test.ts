/**
 * Tests for the GC-2026-067 T2 session_start orchestrator-state digest.
 *
 * Covers:
 *   - buildSessionDigest: counts goals/dags/audits/branches/todos from a
 *     synthetic fixture directory
 *   - formatSessionDigest: renders the expected text shape including the
 *     `[sages session digest]` prefix and per-section empty markers
 *   - extension wiring: session_start handler invokes buildSessionDigest
 *     and pipes the formatted text into `pi.appendEntry("system", ...)`
 *
 * Scope (T2 only):
 *   - inflightGoals: any goal whose dag is missing OR whose dag.state ==
 *     "executing" (per spec §1)
 *   - pendingAuditVerdicts: any audit-*.md whose Verdict line is not PASS
 *     (CERTIFIED == PASS / NEEDS WORK / BLOCKED / unknown != PASS)
 *   - unmergedBranches: non-main worktrees whose `git rev-list main..HEAD`
 *     count > 0 (skip when 0)
 *   - todoStateSummary: 3-bucket counts (pending / in_progress /
 *     completed) read from `.pi/orchestrator/todo-state.json`
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
  buildSessionDigest,
  formatSessionDigest,
  type SessionDigest,
} from "@/observability/digest.js";

function makeGoalYaml(id: string, title: string): string {
  return yaml.dump({
    id,
    title,
    rationale: "test rationale",
    success_criteria: [],
    anti_goals: [],
    scope: { include: [], exclude: [] },
    constraints: {},
    done_definition: "test",
    created_at: new Date().toISOString(),
  });
}

function makeDagYaml(goalId: string, state: string): string {
  return yaml.dump({
    id: `DAG-${goalId.slice(3)}`,
    goal_id: goalId,
    title: `DAG for ${goalId}`,
    state,
    tasks: [],
  });
}

function makeAuditMd(goalSuffix: string, verdict: string): string {
  return `# Audit Report — GC-2026-${goalSuffix}\n\n**Verdict:** ${verdict}\n**Branch:** sages/test\n\nSome body.\n`;
}

function makeTodoState(items: Array<{ status: string }>): string {
  return JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    todos: items.map((item, i) => ({
      content: `todo-${i}`,
      status: item.status,
    })),
  });
}

describe("session-digest", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sages-digest-"));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("(a) counts goals + dag presence + audit verdict + branches + todo", () => {
    // Layout:
    //   .pi/orchestrator/
    //     goal-GC-2026-064.yaml (title=cap-align, has dag executing)
    //     goal-GC-2026-055.yaml (title=auto-install, NO dag)
    //     dag-DAG-2026-064.yaml (state=executing)
    //     audit-T2.md (verdict=PASS — should NOT be pending)
    //     audit-T4.md (verdict=NEEDS WORK — pending)
    //   .pi/orchestrator/todo-state.json (3 items: 1 pending, 1 in_progress, 1 completed)
    //   worktrees (simulated by writing fixture .git/worktrees/<name>/gitdir;
    //   we don't actually run `git worktree list` here — branch detection
    //   is exercised in test (b) below via the empty path; for (a) we
    //   stub the digest's branch query by running it in a real repo dir).
    const orch = join(tmp, ".pi", "orchestrator");
    mkdirSync(orch, { recursive: true });

    writeFileSync(join(orch, "goal-GC-2026-064.yaml"), makeGoalYaml("GC-2026-064", "cap-align"));
    writeFileSync(join(orch, "goal-GC-2026-055.yaml"), makeGoalYaml("GC-2026-055", "auto-install"));
    writeFileSync(join(orch, "dag-DAG-2026-064.yaml"), makeDagYaml("GC-2026-064", "executing"));
    writeFileSync(join(orch, "audit-T2.md"), makeAuditMd("066", "PASS"));
    writeFileSync(join(orch, "audit-T4.md"), makeAuditMd("064", "NEEDS WORK"));
    writeFileSync(
      join(orch, "todo-state.json"),
      makeTodoState([
        { status: "pending" },
        { status: "in_progress" },
        { status: "completed" },
      ]),
    );

    const digest = buildSessionDigest(tmp);
    expect(digest).not.toBeNull();
    if (!digest) return;

    // inflightGoals: GC-2026-064 (has dag, executing) + GC-2026-055 (no dag).
    expect(digest.inflightGoals).toHaveLength(2);
    const goalIds = digest.inflightGoals.map((g) => g.id).sort();
    expect(goalIds).toEqual(["GC-2026-055", "GC-2026-064"]);
    const goal064 = digest.inflightGoals.find((g) => g.id === "GC-2026-064");
    expect(goal064?.title).toBe("cap-align");
    expect(goal064?.hasDag).toBe(true);
    const goal055 = digest.inflightGoals.find((g) => g.id === "GC-2026-055");
    expect(goal055?.hasDag).toBe(false);

    // pendingAuditVerdicts: only NEEDS WORK counts (PASS excluded).
    expect(digest.pendingAuditVerdicts).toHaveLength(1);
    expect(digest.pendingAuditVerdicts[0]?.verdict).toBe("NEEDS WORK");
    expect(digest.pendingAuditVerdicts[0]?.path).toContain("audit-T4.md");

    // todoStateSummary: 1 pending, 1 in_progress, 1 completed.
    expect(digest.todoStateSummary).toEqual({
      exists: true,
      pending: 1,
      inProgress: 1,
      completed: 1,
    });

    // unmergedBranches: empty (we are NOT inside a git repo, so the git
    // query yields nothing — proves the digest tolerates a non-git cwd).
    expect(digest.unmergedBranches).toEqual([]);
  });

  it("(b) empty scenario still returns non-null with all sections empty", () => {
    mkdirSync(join(tmp, ".pi", "orchestrator"), { recursive: true });
    const digest = buildSessionDigest(tmp);
    expect(digest).not.toBeNull();
    if (!digest) return;
    expect(digest.inflightGoals).toEqual([]);
    expect(digest.pendingAuditVerdicts).toEqual([]);
    expect(digest.unmergedBranches).toEqual([]);
    expect(digest.todoStateSummary).toEqual({
      exists: false,
      pending: 0,
      inProgress: 0,
      completed: 0,
    });
  });

  it("(c) formatSessionDigest produces the expected text shape", () => {
    const digest: SessionDigest = {
      inflightGoals: [
        { id: "GC-2026-064", title: "cap-align", hasDag: true },
        { id: "GC-2026-055", title: "auto-install", hasDag: false },
      ],
      pendingAuditVerdicts: [
        { goalId: "GC-2026-064", verdict: "NEEDS WORK", path: "/x/audit-T4.md" },
      ],
      unmergedBranches: [
        { branch: "sages/GC-2026-067/T2", commitsAhead: 3, baseBranch: "main" },
      ],
      todoStateSummary: { exists: true, pending: 1, inProgress: 1, completed: 1 },
    };
    const text = formatSessionDigest(digest);
    expect(text.startsWith("[sages session digest]\n")).toBe(true);
    expect(text).toContain("inflightGoals: 2 in-flight GC(s):");
    expect(text).toContain("GC-2026-064: cap-align");
    expect(text).toContain("GC-2026-055: auto-install");
    expect(text).toContain("(no dag)");
    expect(text).toContain("pending verdicts: 1 awaiting review:");
    expect(text).toContain("GC-2026-064: NEEDS WORK");
    expect(text).toContain("unmerged branches: 1 branch(es) ahead of main:");
    expect(text).toContain("sages/GC-2026-067/T2: +3");
    expect(text).toContain("todo state: 1 pending / 1 in_progress / 1 completed");
  });

  it("(c2) empty sections render as `(none)`", () => {
    const digest: SessionDigest = {
      inflightGoals: [],
      pendingAuditVerdicts: [],
      unmergedBranches: [],
      todoStateSummary: { exists: false, pending: 0, inProgress: 0, completed: 0 },
    };
    const text = formatSessionDigest(digest);
    expect(text).toContain("inflightGoals: (none)");
    expect(text).toContain("pending verdicts: (none)");
    expect(text).toContain("unmerged branches: (none)");
    expect(text).toContain("todo state: (none)");
  });

  it("(d) extension wiring: session_start invokes digest + appendEntry", async () => {
    // We exercise the wiring through a minimal mock `pi` shape that
    // captures appendEntry calls. The real handler is wired into the
    // installed `pi.on("session_start", ...)` callback registered at
    // module load; we trigger it directly with a synthetic event/ctx.
    //
    // To avoid dragging the full extension.ts module graph into the
    // test (which would pull in a heavy install routine + many
    // dependencies), we re-export the wiring helper from digest.ts so
    // the test imports only what's needed.
    const appended: Array<{ kind: string; text: string }> = [];
    const pi = {
      appendEntry: (kind: string, text: string) => {
        appended.push({ kind, text });
      },
      on: () => {},
    };

    const { attachSessionDigest } = await import("@/observability/digest.js");
    attachSessionDigest(pi as never, tmp);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.kind).toBe("system");
    expect(appended[0]?.text.startsWith("[sages session digest]\n")).toBe(true);
  });
});
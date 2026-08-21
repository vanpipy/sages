/**
 * digest — session_start orchestrator-state digest.
 *
 * GC-2026-067 T2: at session_start, the root agent receives a one-shot
 * `[sages session digest]` reminder listing what the operator might
 * care about:
 *   - in-flight goals (goals with no dag yet, OR dags in state=executing)
 *   - audit verdicts that need review (any audit-*.md whose Verdict
 *     line is not PASS — i.e. NEEDS WORK / BLOCKED / UNKNOWN / CERTIFIED
 *     is the PASS marker; everything else is "pending review")
 *   - unmerged feature branches (non-main worktrees whose
 *     `git rev-list main..HEAD` count is > 0; skip when 0)
 *   - todo state summary (3-bucket counts from todo-state.json;
 *     `exists: false` when the file is absent)
 *
 * Why a one-shot reminder: the goal is to surface dormant state. We
 * never block; we never throttle; we only inject once at session_start.
 * Subsequent reminders come from sages_todo, sages-watchdog, or session
 * shutdown — this module does not own cadence.
 *
 * Why a pure data shape: `SessionDigest` is a plain JSON-like value so
 * the test can construct fixtures without spinning up a fake repo.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync as cpSpawnSync } from "node:child_process";
import * as yaml from "js-yaml";

export interface InflightGoal {
  id: string;
  title: string;
  hasDag: boolean;
}

export interface PendingAuditVerdict {
  goalId: string;
  verdict: string;
  path: string;
}

export interface UnmergedBranch {
  branch: string;
  commitsAhead: number;
  baseBranch: string;
}

export interface TodoStateSummary {
  exists: boolean;
  pending: number;
  inProgress: number;
  completed: number;
}

export interface SessionDigest {
  inflightGoals: InflightGoal[];
  pendingAuditVerdicts: PendingAuditVerdict[];
  unmergedBranches: UnmergedBranch[];
  todoStateSummary: TodoStateSummary;
}

const ORCH_DIR = ".pi/orchestrator";

/**
 * Build a SessionDigest by scanning the orchestrator state directory
 * under `cwd` and probing git for unmerged branches. Returns a digest
 * even when every section is empty — the operator may want to see
 * "no in-flight work" as a positive signal.
 *
 * Side effects: shells out to `git worktree list --porcelain` and
 * `git rev-list --count <base>..<branch>`. Both commands are bounded
 * (no unbounded output). Failure modes:
 *   - cwd is not a git repo → unmergedBranches = []
 *   - orchestrator dir missing → empty inflight / pending sections
 *   - todo-state.json missing or malformed → exists:false with zeros
 */
export function buildSessionDigest(cwd: string): SessionDigest | null {
  const orchDir = join(cwd, ORCH_DIR);
  const inflightGoals = readInflightGoals(orchDir);
  const pendingAuditVerdicts = readPendingAudits(orchDir);
  const todoStateSummary = readTodoSummary(orchDir);
  const unmergedBranches = readUnmergedBranches(cwd);
  return {
    inflightGoals,
    pendingAuditVerdicts,
    unmergedBranches,
    todoStateSummary,
  };
}

/**
 * Format the digest as the `[sages session digest]` block that gets
 * appended to the system buffer. Pure function — deterministic
 * ordering, no clock-dependent text.
 */
export function formatSessionDigest(digest: SessionDigest): string {
  const lines: string[] = ["[sages session digest]"];

  // inflightGoals
  if (digest.inflightGoals.length === 0) {
    lines.push("  inflightGoals: (none)");
  } else {
    lines.push(`  inflightGoals: ${digest.inflightGoals.length} in-flight GC(s):`);
    for (const goal of digest.inflightGoals) {
      const marker = goal.hasDag ? "" : " (no dag)";
      lines.push(`    - ${goal.id}: ${goal.title}${marker}`);
    }
  }

  // pending verdicts
  if (digest.pendingAuditVerdicts.length === 0) {
    lines.push("  pending verdicts: (none)");
  } else {
    lines.push(`  pending verdicts: ${digest.pendingAuditVerdicts.length} awaiting review:`);
    for (const a of digest.pendingAuditVerdicts) {
      lines.push(`    - ${a.goalId}: ${a.verdict}`);
    }
  }

  // unmerged branches
  if (digest.unmergedBranches.length === 0) {
    lines.push("  unmerged branches: (none)");
  } else {
    lines.push(`  unmerged branches: ${digest.unmergedBranches.length} branch(es) ahead of main:`);
    for (const b of digest.unmergedBranches) {
      lines.push(`    - ${b.branch}: +${b.commitsAhead}`);
    }
  }

  // todo state
  const t = digest.todoStateSummary;
  if (!t.exists) {
    lines.push("  todo state: (none)");
  } else {
    lines.push(`  todo state: ${t.pending} pending / ${t.inProgress} in_progress / ${t.completed} completed`);
  }

  return lines.join("\n");
}

// ─── Internal readers ───────────────────────────────────────────────────

function readInflightGoals(orchDir: string): InflightGoal[] {
  if (!existsSync(orchDir)) return [];
  const goalFiles = listFiles(orchDir, /^goal-.*\.yaml$/);
  const goals: InflightGoal[] = [];
  for (const file of goalFiles) {
    try {
      const raw = readFileSync(join(orchDir, file), "utf-8");
      const parsed = yaml.load(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") continue;
      const id = typeof parsed.id === "string" ? parsed.id : null;
      const title = typeof parsed.title === "string" ? parsed.title : null;
      if (!id || !title) continue;
      const dagState = readDagStateForGoal(orchDir, id);
      // Per spec: include if dag is missing OR dag.state === "executing".
      if (dagState === null || dagState === "executing") {
        goals.push({ id, title, hasDag: dagState !== null });
      }
    } catch {
      // Corrupt YAML is tolerated; we don't want a malformed file to
      // block the entire session_start digest.
      continue;
    }
  }
  // Stable order: by id ascending.
  goals.sort((a, b) => a.id.localeCompare(b.id));
  return goals;
}

function readDagStateForGoal(orchDir: string, goalId: string): string | null {
  // Goal id is GC-2026-XXX. DAG id is DAG-2026-XXX — derive by stripping
  // the "GC-" prefix. If the convention drifts, the dag simply won't be
  // found and we fall back to "no dag" semantics — which is the safer
  // choice for a state-of-the-world digest (operator sees the goal).
  const dagId = `DAG-${goalId.slice(3)}`;
  const dagPath = join(orchDir, `dag-${dagId}.yaml`);
  if (!existsSync(dagPath)) return null;
  try {
    const raw = readFileSync(dagPath, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return typeof parsed.state === "string" ? parsed.state : null;
  } catch {
    return null;
  }
}

function readPendingAudits(orchDir: string): PendingAuditVerdict[] {
  if (!existsSync(orchDir)) return [];
  const auditFiles = listFiles(orchDir, /^audit-.*\.md$/);
  const pending: PendingAuditVerdict[] = [];
  for (const file of auditFiles) {
    const fullPath = join(orchDir, file);
    try {
      const raw = readFileSync(fullPath, "utf-8");
      const verdict = extractVerdict(raw);
      // "PASS" is the only verdict that does NOT need review. CERTIFIED
      // is the per-subagent PASS marker; we surface the raw string so
      // the operator sees the actual auditor wording.
      if (verdict !== "PASS") {
        pending.push({
          goalId: extractGoalId(raw, file),
          verdict,
          path: fullPath,
        });
      }
    } catch {
      continue;
    }
  }
  pending.sort((a, b) => a.goalId.localeCompare(b.goalId));
  return pending;
}

function extractVerdict(markdown: string): string {
  // Match `**Verdict:** <text>` first (the most common format in the
  // audit reports we ship). Fall back to `## Final Verdict` body for
  // auditor subagent reports. If nothing matches, return "UNKNOWN".
  const direct = markdown.match(/\*\*Verdict:\*\*\s*([^\n*]+)/i);
  if (direct) return direct[1]?.trim().toUpperCase() ?? "UNKNOWN";
  const final = markdown.match(/##\s+Final\s+Verdict[\s\S]*?\*\*(CERTIFIED|NEEDS WORK|BLOCKED|PASS|UNKNOWN)\*\*/i);
  if (final) return final[1]?.toUpperCase() ?? "UNKNOWN";
  return "UNKNOWN";
}

function extractGoalId(markdown: string, filename: string): string {
  // Prefer an explicit GC id in the heading (`# Audit Report — GC-2026-XXX`).
  const heading = markdown.match(/Audit Report\s+[—-]\s*(GC-\d{4}-\d+)/i);
  if (heading) return heading[1] ?? "UNKNOWN";
  // Otherwise fall back to the filename stem — `audit-T4.md` → `T4`.
  return filename.replace(/^audit-/, "").replace(/\.md$/, "");
}

function readTodoSummary(orchDir: string): TodoStateSummary {
  const target = join(orchDir, "todo-state.json");
  if (!existsSync(target)) {
    return { exists: false, pending: 0, inProgress: 0, completed: 0 };
  }
  try {
    const raw = readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw) as { todos?: Array<{ status?: string }> } | null;
    if (!parsed || !Array.isArray(parsed.todos)) {
      return { exists: false, pending: 0, inProgress: 0, completed: 0 };
    }
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    for (const t of parsed.todos) {
      const status = typeof t?.status === "string" ? t.status : "pending";
      if (status === "pending") pending++;
      else if (status === "in_progress") inProgress++;
      else if (status === "completed") completed++;
    }
    return { exists: true, pending, inProgress, completed };
  } catch {
    return { exists: false, pending: 0, inProgress: 0, completed: 0 };
  }
}

function readUnmergedBranches(cwd: string): UnmergedBranch[] {
  // Probe `git worktree list --porcelain`. If it fails (not a repo, no
  // git binary, etc.), return [] — the digest stays useful for the
  // other sections.
  const porcelain = runGit(cwd, ["worktree", "list", "--porcelain"], 5000);
  if (porcelain === null) return [];

  // Porcelain output is a sequence of `key value\n` blocks separated by
  // blank lines. Each worktree has a `worktree <path>` line and a
  // `branch refs/heads/<name>` line. The first block is the main
  // worktree; subsequent blocks are linked worktrees. For the digest,
  // we treat the *first* worktree as "main" and skip its branch; all
  // other worktrees with a `branch` line are checked for commits ahead
  // of `main`.
  const blocks = porcelain.split(/\n\n+/);
  const branches: string[] = [];
  for (const block of blocks) {
    const m = block.match(/^branch\s+refs\/heads\/(.+)$/m);
    if (m) branches.push(m[1]?.trim() ?? "");
  }
  if (branches.length === 0) return [];

  const mainBranch = "main";
  const out: UnmergedBranch[] = [];
  // Skip the first branch — that's the main worktree's branch (usually
  // `main`); we only care about sibling worktrees that are ahead.
  for (const branch of branches) {
    if (branch === mainBranch) continue;
    const count = runGit(cwd, ["rev-list", "--count", `${mainBranch}..${branch}`], 5000);
    if (count === null) continue;
    const ahead = Number.parseInt(count.trim(), 10);
    if (Number.isFinite(ahead) && ahead > 0) {
      out.push({ branch, commitsAhead: ahead, baseBranch: mainBranch });
    }
  }
  out.sort((a, b) => a.branch.localeCompare(b.branch));
  return out;
}

function runGit(cwd: string, args: string[], timeoutMs: number): string | null {
  // Use child_process.spawnSync with a hard timeout. The digest runs at
  // session_start (sync), so we cannot use Bun.spawn or a Promise here.
  // spawnSync on a local git invocation returns within milliseconds; the
  // 5-second cap is a safety net for pathological cases (networked FS,
  // hung git daemon) where we'd rather surface an empty section than
  // block the session.
  try {
    const result = cpSpawnSync("git", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    if (result.error) return null;
    if (result.status !== 0) return null;
    return result.stdout ?? "";
  } catch {
    return null;
  }
}

function listFiles(dir: string, pattern: RegExp): string[] {
  try {
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir);
    return entries.filter((e) => pattern.test(e) && statSync(join(dir, e)).isFile());
  } catch {
    return [];
  }
}

// ─── Extension wiring helper ────────────────────────────────────────────

/**
 * Test seam for the session_start wiring: invokes buildSessionDigest
 * against `cwd` and pipes the formatted text into
 * `pi.appendEntry("system", ...)`. The real extension.ts handler
 * performs the same call inline; this helper exists so the test can
 * exercise the round-trip without importing the full extension
 * module graph.
 */
export function attachSessionDigest(pi: { appendEntry: (kind: string, text: string) => void }, cwd: string): void {
  const digest = buildSessionDigest(cwd);
  if (digest !== null) {
    pi.appendEntry("system", formatSessionDigest(digest));
  }
}
/**
 * task-paths.ts — Where session and project task files live.
 *
 * `session` scope keeps them in the workspace, as it always has. `session-global`
 * keeps them under pi's agent directory instead, beside pi's own per-workspace
 * session logs, for people who would rather their repositories stayed clean.
 * `project` scope lives under `ORCHESTRATOR_WORKDIR`, a single per-workspace
 * directory owned by the Sages orchestrator that survives across sessions.
 *
 * The choice only ever decides where a *new* file is created. A session already
 * holding a file in the workspace keeps using it under either setting, so opting
 * in moves nothing and opting back out strands nothing.
 */

import { existsSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TasksConfig } from "./tasks-config.js";

/**
 * Root directory holding per-workspace orchestrator state. The env var
 * overrides the default; the default itself lives under TMPDIR so a fresh
 * install never writes inside any project.
 *
 * Any sages workspace gets its own subdirectory under ORCHESTRATOR_WORKDIR
 * (keyed by `repositoryKey(cwd)`): design drafts at `…/<key>/designs/`, the
 * shared task file at `…/<key>/tasks/tasks.json`, and anything else the
 * orchestrator needs to keep across sessions.
 */
const DEFAULT_ORCHESTRATOR_WORKDIR = join(tmpdir(), "sages-orchestrator");

/** Resolve `ORCHESTRATOR_WORKDIR` at call time (matches pi-tasks's own per-call
 *  resolution of `getAgentDir()` — env vars may be set between calls). */
export function orchestratorWorkdir(): string {
  return process.env.ORCHESTRATOR_WORKDIR ?? DEFAULT_ORCHESTRATOR_WORKDIR;
}

type TaskScope = NonNullable<TasksConfig["taskScope"]>;

/**
 * Directory name standing for one workspace.
 *
 * Mirrors the encoding pi uses for its own session logs
 * (`<agent-dir>/sessions/--Users-me-work-repo--/<timestamp>_<id>.jsonl`), so a
 * workspace's task files are named the same way as its transcripts and can be
 * found by eye.
 */
export function projectKey(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Where `session-global` collects one workspace's session files.
 *  Resolved per call, never captured: `getAgentDir()` reads the environment. */
export function globalSessionTasksDir(cwd: string): string {
  return join(getAgentDir(), "tasks", "sessions", projectKey(cwd));
}

/** The in-workspace location, unchanged since session scope was introduced. */
export function workspaceSessionTaskFile(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

/**
 * File backing one persisted session.
 *
 * Under `session-global` the workspace is still consulted first: a session that
 * already has a file there is still that file's session, and reading it is the
 * whole reason no migration is needed.
 */
export function sessionTaskFile(cwd: string, sessionId: string, scope: TaskScope): string {
  const inWorkspace = workspaceSessionTaskFile(cwd, sessionId);
  if (scope !== "session-global") return inWorkspace;
  return existsSync(inWorkspace) ? inWorkspace : join(globalSessionTasksDir(cwd), `tasks-${sessionId}.json`);
}

/**
 * The per-workspace project task file under `taskScope: "project"`.
 *
 * Lives under ORCHESTRATOR_WORKDIR (one root directory holding every sages
 * workspace's shared orchestrator state) keyed by `projectKey(cwd)` (the
 * same path-encoded identifier pi-tasks's session-global scope uses — in
 * user-facing terms this is the workspace's "repository name" within
 * the orchestrator's directory tree). The orchestrator's `orchestrate(plan)`
 * tool and the board's own `taskScope: "project"` mode both write here
 * so the LLM's `TaskList` shows what `orchestrate` just created and
 * vice versa.
 */
export function orchestratorProjectTaskFile(cwd: string): string {
  return join(orchestratorWorkdir(), projectKey(cwd), "tasks", "tasks.json");
}

/**
 * Per-workspace directory where brainstorming-approved design drafts land.
 *
 * Sits next to `orchestratorProjectTaskFile` under the same
 * `<ORCHESTRATOR_WORKDIR>/<projectKey(cwd)>/` tree, so a workspace's
 * task store and design drafts are co-located in the orchestrator's
 * per-workspace directory. Approved designs are an in-memory handoff
 * to the orchestrator's `TaskCreate` chain (see brainstorming SKILL.md
 * "Trigger Modes"), so persisting them out of the repo is consistent
 * with how the task store itself lives.
 */
export function orchestratorDesignsDir(cwd: string): string {
  return join(orchestratorWorkdir(), projectKey(cwd), "designs");
}

/**
 * Remove a workspace's global session directory once it holds nothing.
 *
 * Only the global tree is ever reclaimed. `<workspace>/.pi/tasks/` is left alone
 * even when it empties, because that is what every release so far has done and
 * `.pi/` holds project config that is not ours.
 */
export function reclaimGlobalSessionTasksDir(cwd: string): void {
  try { rmdirSync(globalSessionTasksDir(cwd)); } catch { /* other sessions still stored */ }
}

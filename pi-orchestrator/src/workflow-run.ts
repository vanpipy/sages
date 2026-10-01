/**
 * workflow-run.ts — 5-phase pipeline runner (GC-2026-workflow-run).
 *
 * Replaces the DAG / orchestrator_audit / task_dispatch pipeline
 * (gone in GC-2026-orchestrator-simplify) with a one-shot state
 * machine that the LLM invokes once and waits for. The pipeline:
 *
 *   Plan → Implement → Review ⇆ Fix (loop until CLEAN or max iterations) → Merge
 *
 * Each phase dispatches a single subagent via `SubagentRegistry.spawn()`
 * (the GC-2026-073 AgentManager singleton) and waits synchronously for
 * completion before proceeding. Reviewer verdict (CLEAN / NEEDS_WORK)
 * drives the Fix loop; if the loop exhausts `max_fix_iterations`, the
 * pipeline returns `blocked`.
 *
 * Phase-to-agent mapping:
 *   - Implement  → Developer  (managed worktree, TDD)
 *   - Review     → Reviewer   (GC-2026-rename-auditor; read-only on worktree)
 *   - Fix        → Developer  (same worktree, reuse)
 *   - Merge      → Merger     (main checkout, no worktree)
 *
 * State persistence: `.pi/orchestrator/workflow-{goal_id}.yaml` records
 * the worktree path, branch, and each phase's spawn id + status. On a
 * re-invocation with `resume=true` (default), completed phases are
 * skipped; partial work is preserved.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "@sages/pi-subagents/types";
import type { ManagedWorktreeRequest } from "@sages/pi-subagents/worktree-contract";

import { loadGoalContract } from "./goal-contract.js";
import type { GoalContract } from "./types.js";

/**
 * Public input for the workflow_run LLM tool.
 */
export interface WorkflowRunInput {
	goal_path: string;
	options?: {
		max_fix_iterations?: number;
		agent_overrides?: {
			implement?: string;
			review?: string;
			fix?: string;
			merge?: string;
		};
		resume?: boolean;
	};
	verbose?: boolean;
}

/**
 * Per-phase summary returned to the LLM.
 */
export interface TaskSummary {
	id: string;
	status: "completed" | "failed";
	agent_id?: string;
	duration_ms?: number;
	commits?: number;
	error?: string;
}

/**
 * Review phase summary — verdict + iteration count.
 */
export interface ReviewSummary extends TaskSummary {
	verdict: "CLEAN" | "NEEDS_WORK";
	findings_count: number;
	iterations: number;
	agent_id: string;
}

/**
 * Public output from workflow_run.
 */
export interface WorkflowRunOutput {
	status: "success" | "blocked";
	goal_id: string;
	iterations_used: number;
	blocked_at?: "implement" | "review" | "merge";
	tasks: {
		implement: TaskSummary;
		review: ReviewSummary;
		fix?: TaskSummary;
		merge?: TaskSummary;
	};
	/**
	 * GC-2026-pi-tasks-integration: pi-tasks task IDs created for each
	 * pipeline phase. The LLM can read these via TaskList to see live
	 * progress. Empty strings mean pi-tasks integration was unavailable
	 * (pi-tasks extension not loaded or executeTool refused).
	 */
	pi_tasks: {
		implement: string;
		review: string;
		fix: string;
		merge: string;
	};
	unresolved_findings?: Finding[];
	merge_error?: string;
	paths: {
		worktree: string;
		branch: string;
		goal_yaml: string;
		merge_commit?: string;
	};
	summary: string;
}

/**
 * Single finding extracted from a Reviewer verdict.
 */
export interface Finding {
	severity: "minor" | "major" | "critical";
	issue: string;
	location?: string;
	recommendation?: string;
}

/**
 * Persistent pipeline state. Mirrored to disk at every phase transition
 * so a re-invocation can resume from the last completed phase.
 */
export interface WorkflowState {
	schema_version: "v1";
	goal_id: string;
	started_at: string;
	current_phase: "plan" | "implement" | "review" | "fix_loop" | "merge" | "completed" | "blocked";
	iterations_used: number;
	worktree_path?: string;
	branch?: string;
	phases: {
		implement?: TaskSummary & { agent_id: string };
		review?: ReviewSummary;
		fix?: (TaskSummary & { agent_id: string; iteration: number })[];
		merge?: TaskSummary & { agent_id: string; merge_commit?: string };
	};
}

/**
 * Initialize a fresh WorkflowState for a goal. The started_at field is
 * populated by the caller with the actual start time.
 */
function initialWorkflowState(goalId: string): WorkflowState {
	return {
		schema_version: "v1",
		goal_id: goalId,
		started_at: new Date(0).toISOString(),
		current_phase: "implement",
		iterations_used: 0,
		phases: {},
	};
}

// ───────────────────────────────────────────────────────────────────────
// Subagent dispatch (via GC-2026-073 AgentManager singleton)
// ───────────────────────────────────────────────────────────────────────

/**
 * Subset of AgentManager that workflow_run needs.
 *
 * The registry is published by @sages/pi-subagents at extension activation
 * via `globalThis[Symbol.for("pi-subagents:manager")]`.
 */
interface SubagentRegistry {
	spawn(
		piRef: unknown,
		ctx: unknown,
		type: string,
		prompt: string,
		options: Record<string, unknown>,
	): string;
	getRecord(id: string): AgentRecord | undefined;
	waitForAll(): Promise<void>;
}

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function getRegistry(): SubagentRegistry {
	const entry = (globalThis as unknown as Record<symbol, SubagentRegistry | undefined>)[MANAGER_KEY];
	if (!entry) {
		throw new Error(
			"AgentManager registry is not initialized — is pi-subagents loaded? " +
				"This tool must be called from a session where @sages/pi-subagents has activated.",
		);
	}
	return entry;
}

// ───────────────────────────────────────────────────────────────────────
// TypeBox parameter schema (LLM-facing)
// ───────────────────────────────────────────────────────────────────────

import { Type, type Static } from "typebox";

export const WorkflowRunParams = Type.Object({
	goal_path: Type.String({
		description: "Path to the goal contract YAML, e.g. '.pi/orchestrator/goal-GC-2026-xxx.yaml'",
	}),
	options: Type.Optional(
		Type.Object({
			max_fix_iterations: Type.Optional(
				Type.Number({ minimum: 0, maximum: 10, description: "Maximum Fix → re-Review cycles. Default 3." }),
			),
			agent_overrides: Type.Optional(
				Type.Object({
					implement: Type.Optional(Type.String({ description: "Override the Implement agent. Default 'Developer'." })),
					review: Type.Optional(Type.String({ description: "Override the Review agent. Default 'Reviewer'." })),
					fix: Type.Optional(Type.String({ description: "Override the Fix agent. Default 'Developer'." })),
					merge: Type.Optional(Type.String({ description: "Override the Merge agent. Default 'Merger'." })),
				}),
			),
			resume: Type.Optional(
				Type.Boolean({ description: "Reuse completed phases from the workflow-{goal_id}.yaml state file. Default true." }),
			),
		}),
	),
	verbose: Type.Optional(Type.Boolean({ description: "Include full task reports in the response. Default false." })),
});

export type WorkflowRunInputType = Static<typeof WorkflowRunParams>;

// ───────────────────────────────────────────────────────────────────────
// Verdict parsing (Reviewer → Finding[])
// ───────────────────────────────────────────────────────────────────────

interface ReviewerVerdict {
	verdict: "CLEAN" | "NEEDS_WORK";
	findings?: Finding[];
	scope_check?: string;
	anti_goal_check?: string;
}

const VERDICT_FENCE = "```yaml\n";

export function parseReviewerVerdict(message: string | undefined): ReviewerVerdict {
	if (!message) {
		return { verdict: "NEEDS_WORK", findings: [] };
	}

	// The Reviewer is required to emit a fenced YAML block at the end of
	// its final message. workflow_run scans for the LAST ```yaml block.
	const lower = message.toLowerCase();
	const lastOpen = message.lastIndexOf(VERDICT_FENCE);
	const closeAfterOpen = lastOpen >= 0 ? message.indexOf("```", lastOpen + VERDICT_FENCE.length) : -1;
	if (lastOpen < 0 || closeAfterOpen < 0) {
		return { verdict: "NEEDS_WORK", findings: [] };
	}

	const yamlText = message.slice(lastOpen + VERDICT_FENCE.length, closeAfterOpen).trim();
	try {
		// Minimal YAML parse: the verdict block has a flat structure we can
		// extract line by line. Avoid pulling in a YAML library here.
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
					if (key === "severity") currentFinding.severity = val as Finding["severity"];
					else if (key === "issue") currentFinding.issue = val;
					else if (key === "location") currentFinding.location = val;
					else if (key === "recommendation") currentFinding.recommendation = val;
				}
				continue;
			}
			if (inFindings && currentFinding && line.includes(":")) {
				// Continuation of current finding (e.g. "    issue: ...").
				// Only accept keys that are finding properties.
				const colonIdx = line.indexOf(":");
				if (colonIdx > 0) {
					const key = line.slice(0, colonIdx).trim();
					const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
					if (key === "severity") currentFinding.severity = val as Finding["severity"];
					else if (key === "issue") currentFinding.issue = val;
					else if (key === "location") currentFinding.location = val;
					else if (key === "recommendation") currentFinding.recommendation = val;
					else {
						// Key is not a finding property; treat as end of findings block.
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

// ───────────────────────────────────────────────────────────────────────
// State persistence
// ───────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WORKFLOW_PREFIX = "workflow-";

function workflowPath(cwd: string, goalId: string): string {
	return resolve(cwd, ".pi", "orchestrator", `${WORKFLOW_PREFIX}${goalId}.yaml`);
}

function loadWorkflowState(cwd: string, goalId: string): WorkflowState | null {
	const path = workflowPath(cwd, goalId);
	if (!existsSync(path)) return null;
	try {
		const text = readFileSync(path, "utf-8");
		// GC-2026-end-to-end-test: phases are persisted as JSON in a fenced
		// block at the end of the file. The flat top-level scalars are
		// still line-based for readability + grep-ability.
		const lines = text.split(/\r?\n/);
		const state: WorkflowState = {
			schema_version: "v1",
			goal_id: goalId,
			started_at: "",
			current_phase: "plan",
			iterations_used: 0,
			phases: {},
		};
		let inPhases = false;
		let phasesJson = "";
		let braceDepth = 0;
		for (const raw of lines) {
			const line = raw.trimEnd();
			if (!line || line.startsWith("#")) continue;
			if (line.startsWith("phases:")) {
				inPhases = true;
				braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
				const jsonStart = line.indexOf("{");
				if (jsonStart >= 0) phasesJson += line.slice(jsonStart);
				continue;
			}
			if (!inPhases) {
				const colonIdx = line.indexOf(":");
				if (colonIdx < 0) continue;
				const key = line.slice(0, colonIdx).trim();
				const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
				switch (key) {
					case "schema_version":
						state.schema_version = val as "v1";
						break;
					case "started_at":
						state.started_at = val;
						break;
					case "current_phase":
						state.current_phase = val as WorkflowState["current_phase"];
						break;
					case "iterations_used":
						state.iterations_used = Number(val);
						break;
					case "worktree_path":
						state.worktree_path = val;
						break;
					case "branch":
						state.branch = val;
						break;
				}
			} else {
				phasesJson += line;
				braceDepth += (line.match(/\{/g) ?? []).length;
				braceDepth -= (line.match(/\}/g) ?? []).length;
				if (braceDepth === 0) {
					try {
						state.phases = JSON.parse(phasesJson) as WorkflowState["phases"];
					} catch {
						// Corrupt phases block; keep what we have.
					}
					inPhases = false;
					phasesJson = "";
				}
			}
		}
		return state;
	} catch {
		return null;
	}
}

function saveWorkflowState(cwd: string, state: WorkflowState): void {
	const path = workflowPath(cwd, state.goal_id);
	const phasesJson = JSON.stringify(state.phases, null, 2);
	const lines = [
		`# Workflow state for goal ${state.goal_id}`,
		`schema_version: ${state.schema_version}`,
		`goal_id: ${state.goal_id}`,
		`started_at: ${state.started_at}`,
		`current_phase: ${state.current_phase}`,
		`iterations_used: ${state.iterations_used}`,
		state.worktree_path ? `worktree_path: ${state.worktree_path}` : "",
		state.branch ? `branch: ${state.branch}` : "",
		`phases: ${phasesJson}`,
	];
	writeFileSync(path, lines.filter(Boolean).join("\n") + "\n", { mode: 0o644 });
}

// ───────────────────────────────────────────────────────────────────────
// GC-2026-pi-tasks-integration: drive pi-tasks TaskCreate / TaskUpdate
// from inside the state machine so the LLM can see live phase progress
// via TaskList. Failure modes (extension not loaded, executeTool
// refused, validation errors) are silent — pi-tasks integration is a
// UX enhancement, not a correctness gate.
// ───────────────────────────────────────────────────────────────────────

type TaskToolFn = (name: string, args: unknown) => Promise<unknown>;

const PI_TASK_TOOLS = new Set([
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",
	"TaskExecute",
]);

async function callTaskTool(fn: TaskToolFn | undefined, name: string, args: unknown): Promise<unknown> {
	if (!fn) return undefined;
	try {
		return await fn(name, args);
	} catch {
		return undefined;
	}
}

async function piTasksCreate(
	fn: TaskToolFn | undefined,
	subject: string,
	description: string,
	metadata: Record<string, unknown>,
	blocks: string[] = [],
): Promise<string> {
	const outcome = (await callTaskTool(fn, "TaskCreate", {
		subject,
		description,
		activeForm: subject,
		metadata,
	})) as { id?: string; task?: { id?: string } } | undefined;
	const id = outcome?.id ?? outcome?.task?.id ?? "";
	return id;
}

async function piTasksUpdate(
	fn: TaskToolFn | undefined,
	id: string,
	fields: Record<string, unknown>,
): Promise<void> {
	if (!id) return;
	await callTaskTool(fn, "TaskUpdate", { id, ...fields });
}

async function piTasksSetup(
	fn: TaskToolFn | undefined,
	goal: GoalContract,
	goalId: string,
): Promise<{ implement: string; review: string; fix: string; merge: string }> {
	const metadata = { workflow_run_goal_id: goalId };
	const implement = await piTasksCreate(
		fn,
		`Implement: ${goal.title}`,
		`${goal.done_definition}\n\n(worktree: .pi/worktree/${goalId}/implement)`,
		{ ...metadata, phase: "implement" },
	);
	const review = await piTasksCreate(
		fn,
		`Review: ${goal.title}`,
		`5-dimension review (correctness/completeness/scope/anti-goal/docs) of implement output.`,
		{ ...metadata, phase: "review" },
		[implement].filter(Boolean),
	);
	const fix = await piTasksCreate(
		fn,
		`Fix loop: ${goal.title}`,
		`Address review findings; iterate review until CLEAN or max_fix_iterations.`,
		{ ...metadata, phase: "fix" },
		[review].filter(Boolean),
	);
	const merge = await piTasksCreate(
		fn,
		`Merge: ${goal.title}`,
		`Merge the worktree branch into main with --no-ff.`,
		{ ...metadata, phase: "merge" },
	);
	return { implement, review, fix, merge };
}

// ───────────────────────────────────────────────────────────────────────
// Phase prompts
// ───────────────────────────────────────────────────────────────────────

function implementPrompt(goal: GoalContract, worktreePath: string): string {
	return [
		`# Goal: ${goal.title}`,
		``,
		`## Intent`,
		goal.rationale ? goal.rationale : "(no rationale)",
		``,
		`## Scope (include)`,
		...goal.scope.include.map((s: string) => `- ${s}`),
		``,
		`## Scope (exclude)`,
		...goal.scope.exclude.map((s: string) => `- ${s}`),
		``,
		`## Anti-goals`,
		...goal.anti_goals.map((a: string) => `- ${a}`),
		``,
		`## Done definition`,
		goal.done_definition,
		``,
		`## Workspace`,
		`- Worktree: ${worktreePath}`,
		`- Branch: ${goal.id.toLowerCase()}-implement`,
		``,
		`## Process`,
		`1. cd ${worktreePath}`,
		`2. Apply TDD: RED → GREEN → REFACTOR.`,
		`3. Commit on the branch. \`typecheck\` + \`test\` must be green.`,
		`4. Final message MUST contain a single fenced \`\`\`yaml block with status / deliverables / commits.`,
	].join("\n");
}

function reviewPrompt(
	goal: GoalContract,
	worktreePath: string,
	branch: string,
	phase: "implement" | "fix",
	iteration: number,
): string {
	return [
		`# Review phase (${phase} iteration ${iteration})`,
		``,
		`## Goal`,
		`- Title: ${goal.title}`,
		goal.rationale ? `- Rationale: ${goal.rationale}` : "",
		``,
		`## Scope`,
		`Include: ${goal.scope.include.join(", ")}`,
		`Exclude: ${goal.scope.exclude.join(", ")}`,
		``,
		`## Anti-goals`,
		goal.anti_goals.map((a: string) => `- ${a}`).join("\n"),
		``,
		`## Done definition`,
		goal.done_definition,
		``,
		`## Workspace`,
		`- Worktree: ${worktreePath}`,
		`- Branch: ${branch}`,
		``,
		`## What to evaluate`,
		`Run the 5-dimension review (correctness, completeness, scope adherence, anti-goal compliance, documentation). Read .pi/orchestrator/review-${goal.id}-${iteration}.md for the durable evidence trail pattern.`,
		``,
		`## Output`,
		`Final message MUST contain a fenced \`\`\`yaml block with:`,
		`verdict: CLEAN | NEEDS_WORK`,
		`findings: [...]`,
		`scope_check: pass | fail`,
		`anti_goal_check: pass | fail`,
		``,
		`Default to NEEDS_WORK. Only CLEAN if every dimension has explicit evidence.`,
	].join("\n");
}

function fixPrompt(
	goal: GoalContract,
	worktreePath: string,
	branch: string,
	iteration: number,
	findings: Finding[],
): string {
	return [
		`# Fix iteration ${iteration} for goal ${goal.title}`,
		``,
		`## Reviewer findings (NEEDS_WORK)`,
		...findings.map(
			(f, i) => `${i + 1}. [${f.severity}] ${f.issue}${f.location ? ` (at ${f.location})` : ""}${f.recommendation ? ` — ${f.recommendation}` : ""}`,
		),
		``,
		`## Workspace`,
		`- Worktree: ${worktreePath}`,
		`- Branch: ${branch}`,
		``,
		`## Process`,
		`1. cd ${worktreePath}`,
		`2. Address each finding. If empty or trivial, mark the worktree as completed with no changes.`,
		`3. Commit on the branch. typecheck + test must be green.`,
		`4. Final message MUST contain a single fenced \`\`\`yaml block with status / deliverables / commits.`,
	].join("\n");
}

function mergePrompt(goal: GoalContract, branch: string, worktreePath: string): string {
	return [
		`# Merge phase for goal ${goal.title}`,
		``,
		`## Workspace`,
		`- Source branch: ${branch}`,
		`- Worktree: ${worktreePath}`,
		``,
		`## Process`,
		`1. From the main checkout, run \`git merge --no-ff ${branch} -m "merge(${goal.id}): ${goal.title}"\`.`,
		`2. If push is required, run \`git push origin main\`.`,
		`3. Clean up the worktree at ${worktreePath} (\`git worktree remove --force ${worktreePath}\`).`,
		`4. Final message MUST contain a fenced \`\`\`yaml block with merge_commit: <sha>.`,
	].join("\n");
}

// ───────────────────────────────────────────────────────────────────────
// Tool implementation
// ───────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FIX_ITERATIONS = 3;

/**
 * Resolve a managed-worktree request for a goal_id + task_id. The first
 * task (`implement`) creates the slot; subsequent tasks reuse it.
 */
function worktreeRequest(
	goalId: string,
	taskId: string,
	previousBranch?: string,
): ManagedWorktreeRequest {
	if (previousBranch) {
		return {
			dag_id: goalId,
			task_id: taskId,
			mode: "create",
			base_ref: previousBranch,
		};
	}
	return {
		dag_id: goalId,
		task_id: taskId,
		mode: "create",
	};
}

interface RunContext {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	repoCwd: string;
	/**
	 * Optional: invoke an LLM-facing tool by name with the given args.
	 * workflow_run uses this to drive pi-tasks' TaskCreate / TaskUpdate
	 * so the LLM can see live progress via TaskList. Returns the tool's
	 * `details` payload (or content if no details), or undefined on error.
	 */
	executeTool?: (name: string, args: unknown) => Promise<unknown>;
}

/**
 * Spawn a subagent and wait synchronously for completion.
 * Returns the agent record (with status, result, error).
 */
async function spawnAndWait(
	registry: SubagentRegistry,
	{ pi, ctx, repoCwd }: RunContext,
	type: string,
	prompt: string,
	options: {
		managedWorktree?: ManagedWorktreeRequest;
		cwd?: string;
	},
): Promise<AgentRecord> {
	const id = registry.spawn(pi, ctx, type, prompt, {
		...options,
		isBackground: false,
		maxTurns: 200,
	});
	await registry.waitForAll();
	const record = registry.getRecord(id);
	if (!record) {
		throw new Error(`Agent record for ${id} not found after waitForAll`);
	}
	return record;
}

/**
 * Extract a "merge_commit" from a Merger's final YAML block.
 */
export function parseMergeCommit(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const lower = message.toLowerCase();
	const lastOpen = message.lastIndexOf("```yaml\n");
	const fenceLen = "```yaml\n".length;
	const closeAfterOpen = lastOpen >= 0 ? message.indexOf("```", lastOpen + fenceLen) : -1;
	if (lastOpen < 0 || closeAfterOpen < 0) return undefined;
	const yamlText = message.slice(lastOpen + fenceLen, closeAfterOpen).trim();
	for (const raw of yamlText.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.toLowerCase().startsWith("merge_commit")) {
			return line.split(":").slice(1).join(":").trim().replace(/^['"]|['"]$/g, "");
		}
	}
	void lower;
	return undefined;
}

/**
 * Run the 5-phase pipeline. This is the entry point invoked by the
 * `workflow_run` LLM tool.
 */
export async function executeWorkflowRun(
	input: WorkflowRunInput,
	runCtx: RunContext,
): Promise<WorkflowRunOutput> {
	const registry = getRegistry();
	const { pi, ctx, repoCwd } = runCtx;
	const opts = input.options ?? {};
	const overrides = opts.agent_overrides ?? {};
	const maxFixIterations = opts.max_fix_iterations ?? DEFAULT_MAX_FIX_ITERATIONS;
	const resume = opts.resume ?? true;

	// ─── Phase 0: Plan ─────────────────────────────────────────────────
	// Load the goal contract.
	const absGoalPath = resolve(repoCwd, input.goal_path);
	if (!existsSync(absGoalPath)) {
		throw new Error(`Goal file not found: ${input.goal_path}`);
	}

	// Derive goal_id from the file name. Supports both
	// "goal-GC-2026-xxx.yaml" and an explicit "id:" line, but the file-name
	// form is the convention.
	const fileName = absGoalPath.split("/").pop() ?? "";
	const m = fileName.match(/^goal-(GC-[0-9a-zA-Z-]+)\.yaml$/);
	if (!m) {
		throw new Error(`Goal file name must match goal-<id>.yaml; got: ${fileName}`);
	}
	const goalId = m[1];

	const goal = loadGoalContract(repoCwd, goalId);
	if (!goal) {
		throw new Error(`Goal contract failed to load: ${goalId}`);
	}

	// ─── Phase: State init / resume ─────────────────────────────────────
	let state: WorkflowState = resume ? (loadWorkflowState(repoCwd, goalId) ?? initialWorkflowState(goalId)) : initialWorkflowState(goalId);
	if (state.iterations_used === 0 && state.started_at === initialWorkflowState(goalId).started_at) {
		state.started_at = new Date().toISOString();
	}
	if (resume && loadWorkflowState(repoCwd, goalId) === null) {
		saveWorkflowState(repoCwd, state);
	}

	const goalYamlPath = `.pi/orchestrator/goal-${goalId}.yaml`;
	const result: WorkflowRunOutput = {
		status: "success",
		goal_id: goalId,
		iterations_used: state.iterations_used,
		tasks: {
			implement: state.phases.implement ?? { id: "", status: "failed", agent_id: "" },
			review: state.phases.review ?? {
				id: "",
				status: "failed",
				agent_id: "",
				verdict: "NEEDS_WORK",
				findings_count: 0,
				iterations: 0,
			},
		},
		pi_tasks: { implement: "", review: "", fix: "", merge: "" },
		paths: {
			worktree: state.worktree_path ?? "",
			branch: state.branch ?? "",
			goal_yaml: goalYamlPath,
		},
		summary: "",
	};

	// GC-2026-pi-tasks-integration: pre-create the 4 phase tasks so the LLM
	// sees live progress via TaskList. Best-effort — if pi-tasks isn't
	// loaded or executeTool refused, the IDs stay empty and the pipeline
	// continues with its own bookkeeping.
	const piTaskIds = await piTasksSetup(runCtx.executeTool, goal, goalId);
	result.pi_tasks = piTaskIds;

	// ─── Phase: Implement ──────────────────────────────────────────────
	if (!state.phases.implement || state.phases.implement.status !== "completed") {
		state.current_phase = "implement";
		await piTasksUpdate(runCtx.executeTool, piTaskIds.implement, { status: "in_progress" });
		const branch = `sages/${goalId.toLowerCase()}-implement`;
		const wtRequest = worktreeRequest(goalId, "implement");
		const prompt = implementPrompt(goal, `<repo>/.pi/worktree/${goalId}/implement`);
		try {
			const record = await spawnAndWait(registry, runCtx, overrides.implement ?? "Developer", prompt, {
				managedWorktree: wtRequest,
			});
			const summary: TaskSummary & { agent_id: string } = {
				id: record.id,
				agent_id: record.id,
				status: record.status === "completed" ? "completed" : "failed",
				duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
				error: record.error,
			};
			state.phases.implement = summary;
			state.worktree_path = `<repo>/.pi/worktree/${goalId}/implement`;
			state.branch = branch;
			await piTasksUpdate(runCtx.executeTool, piTaskIds.implement, {
				status: summary.status,
			});
			saveWorkflowState(repoCwd, state);
		} catch (err) {
			state.current_phase = "blocked";
			saveWorkflowState(repoCwd, state);
			result.status = "blocked";
			result.blocked_at = "implement";
			result.summary = `Implement phase failed: ${String(err)}`;
			return result;
		}
	}

	result.tasks.implement = state.phases.implement;

	// ─── Phase: Review (round 1) ──────────────────────────────────────
	async function runReview(iteration: number, phase: "implement" | "fix", _findings: Finding[]): Promise<ReviewSummary> {
		const reviewId = `review-${goalId}-${iteration}`;
		const prompt = reviewPrompt(goal!, state.worktree_path ?? "", state.branch ?? "", phase, iteration);
		// Reviewer runs in current-workspace (read-only) inside the worktree
		// path. We don't provision a separate worktree — Reviewer should
		// never edit the worktree, so the managed-worktree allocation is
		// unnecessary overhead.
		const record = await spawnAndWait(registry, runCtx, overrides.review ?? "Reviewer", prompt, {
			cwd: state.worktree_path,
		});
		const verdict = parseReviewerVerdict(record.result);
		const summary: ReviewSummary = {
			id: record.id,
			agent_id: record.id,
			status: record.status === "completed" ? "completed" : "failed",
			duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
			error: record.error,
			verdict: verdict.verdict,
			findings_count: verdict.findings?.length ?? 0,
			iterations: iteration,
		};
		return summary;
	}

	if (!state.phases.review || state.phases.review.status !== "completed") {
		state.current_phase = "review";
		await piTasksUpdate(runCtx.executeTool, piTaskIds.review, { status: "in_progress" });
		try {
			const summary = await runReview(1, "implement", []);
			state.phases.review = summary;
			await piTasksUpdate(runCtx.executeTool, piTaskIds.review, {
				status: summary.status,
			});
			saveWorkflowState(repoCwd, state);
		} catch (err) {
			state.current_phase = "blocked";
			await piTasksUpdate(runCtx.executeTool, piTaskIds.review, { status: "completed" });
			saveWorkflowState(repoCwd, state);
			result.status = "blocked";
			result.blocked_at = "review";
			result.summary = `Review phase failed: ${String(err)}`;
			return result;
		}
	}

	result.tasks.review = state.phases.review;

	// ─── Phase: Fix loop ───────────────────────────────────────────────
	state.current_phase = "fix_loop";
	const fixPhases: (TaskSummary & { agent_id: string; iteration: number })[] = state.phases.fix ?? [];
	while (
		state.phases.review?.verdict === "NEEDS_WORK" &&
		state.iterations_used < maxFixIterations
	) {
		state.iterations_used += 1;
		await piTasksUpdate(runCtx.executeTool, piTaskIds.fix, { status: "in_progress" });
		const iter = state.iterations_used + 1; // iteration 2 = first fix
		const findings: Finding[] = parseReviewerVerdict(
			registry.getRecord(state.phases.review.agent_id)?.result,
		).findings ?? [];

		// Fix Developer
		try {
			const fixPromptText = fixPrompt(goal, state.worktree_path ?? "", state.branch ?? "", state.iterations_used, findings);
			const record = await spawnAndWait(registry, runCtx, overrides.fix ?? "Developer", fixPromptText, {
				managedWorktree: worktreeRequest(goalId, "implement", state.branch),
				cwd: state.worktree_path,
			});
			const fixSummary: TaskSummary & { agent_id: string; iteration: number } = {
				id: record.id,
				agent_id: record.id,
				status: record.status === "completed" ? "completed" : "failed",
				duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
				error: record.error,
				iteration: state.iterations_used,
			};
			fixPhases.push(fixSummary);
			state.phases.fix = fixPhases;
			await piTasksUpdate(runCtx.executeTool, piTaskIds.fix, {
				status: fixSummary.status === "completed" ? "in_progress" : "completed",
				activeForm: `Fix iteration ${state.iterations_used}`,
			});
			saveWorkflowState(repoCwd, state);
		} catch (err) {
			state.current_phase = "blocked";
			await piTasksUpdate(runCtx.executeTool, piTaskIds.fix, { status: "completed" });
			saveWorkflowState(repoCwd, state);
			result.status = "blocked";
			result.blocked_at = "review";
			result.unresolved_findings = findings;
			result.summary = `Fix iteration ${state.iterations_used} failed: ${String(err)}`;
			return result;
		}

		// Re-review
		try {
			const reReview = await runReview(iter, "fix", findings);
			state.phases.review = reReview;
			await piTasksUpdate(runCtx.executeTool, piTaskIds.review, {
				status: reReview.status,
			});
			saveWorkflowState(repoCwd, state);
		} catch (err) {
			state.current_phase = "blocked";
			saveWorkflowState(repoCwd, state);
			result.status = "blocked";
			result.blocked_at = "review";
			result.unresolved_findings = findings;
			result.summary = `Re-review (iteration ${iter}) failed: ${String(err)}`;
			return result;
		}
	}

	result.tasks.review = state.phases.review;
	if (fixPhases.length > 0) {
		result.tasks.fix = fixPhases[fixPhases.length - 1];
	}

	// ─── Phase: Merge ──────────────────────────────────────────────────
	if (state.phases.review?.verdict === "CLEAN") {
		state.current_phase = "merge";
		await piTasksUpdate(runCtx.executeTool, piTaskIds.merge, { status: "in_progress" });
		try {
			const prompt = mergePrompt(goal, state.branch ?? "", state.worktree_path ?? "");
			const record = await spawnAndWait(registry, runCtx, overrides.merge ?? "Merger", prompt, {
				cwd: repoCwd, // Merge runs in the main checkout
			});
			const summary: TaskSummary & { agent_id: string; merge_commit?: string } = {
				id: record.id,
				agent_id: record.id,
				status: record.status === "completed" ? "completed" : "failed",
				duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
				error: record.error,
				merge_commit: parseMergeCommit(record.result),
			};
			state.phases.merge = summary;
			await piTasksUpdate(runCtx.executeTool, piTaskIds.merge, {
				status: summary.status,
			});
			saveWorkflowState(repoCwd, state);
			result.tasks.merge = summary;
			if (summary.merge_commit) {
				result.paths.merge_commit = summary.merge_commit;
			}
			if (summary.status === "failed") {
				state.current_phase = "blocked";
				saveWorkflowState(repoCwd, state);
				result.status = "blocked";
				result.blocked_at = "merge";
				result.merge_error = summary.error ?? "merge agent failed without error message";
				result.iterations_used = state.iterations_used;
				result.summary = `Merge phase failed: ${result.merge_error}`;
				return result;
			}
		} catch (err) {
			state.current_phase = "blocked";
			await piTasksUpdate(runCtx.executeTool, piTaskIds.merge, { status: "completed" });
			saveWorkflowState(repoCwd, state);
			result.status = "blocked";
			result.blocked_at = "merge";
			result.merge_error = String(err);
			result.iterations_used = state.iterations_used;
			result.summary = `Merge phase failed: ${String(err)}`;
			return result;
		}
	} else {
		// Max iterations exhausted with NEEDS_WORK
		state.current_phase = "blocked";
		saveWorkflowState(repoCwd, state);
		result.status = "blocked";
		result.blocked_at = "review";
		result.unresolved_findings = parseReviewerVerdict(
			registry.getRecord(state.phases.review.agent_id)?.result,
		).findings;
		result.iterations_used = state.iterations_used;
		result.summary = `Max fix iterations (${maxFixIterations}) exhausted with NEEDS_WORK.`;
		return result;
	}

	// ─── Final state ──────────────────────────────────────────────────
	state.current_phase = "completed";
	saveWorkflowState(repoCwd, state);
	result.iterations_used = state.iterations_used;
	result.status = "success";
	result.summary = `Goal ${goalId} completed: ${state.iterations_used} fix iteration(s); merged ${state.branch ?? ""} → main (${result.paths.merge_commit ?? "no commit reported"}).`;
	return result;
}

// Silence unused-var lint for imports that exist for future expansion.
void dirname;

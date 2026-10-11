/**
 * orchestrator-tool.ts — the orchestrator's first LLM-facing tool:
 * `orchestrate(plan)` materializes a multi-phase workflow as a task DAG
 * by writing directly into pi-tasks's task store.
 *
 * Post chore/remove-goal-contract + drop-data + remove-workflow-run-prod
 * + decompose-task-removed + remove-orchestrator-advisory the orchestrator
 * owns zero tools. This commit re-introduces a single orchestrator-owned
 * tool — the only one needed for "the orchestrator does the orchestration
 * and creates tasks":
 *
 *   - LLM calls `orchestrate(intent, phases)` with a list of phase specs.
 *   - For each phase, the tool creates a task in pi-tasks's shared
 *     task store (`<cwd>/.pi/tasks/tasks.json`) with the phase's
 *     `agentType` recorded in task metadata.
 *   - Phase-level `blockedBy` references (by subject) are resolved to
 *     task IDs and wired into both the predecessor's `blocks` and the
 *     dependent's `blockedBy`. After this call, pi-tasks's normal
 *     cascade (via TaskExecute) drives the phases in dependency order.
 *
 * The tool uses pi-tasks's exported `TaskStore` class directly — no
 * event bus, no shared globalThis state. The orchestrator owns the
 * "create the DAG" step; pi-tasks owns the "run the DAG" step. The
 * split mirrors the package boundary (orchestrator = planning, pi-tasks
 * = execution).
 *
 * Designed against the upstream-synced pi-tasks (the Sages fork of
 * @tintinweb/pi-tasks v0.9.0) — no modifications to pi-tasks needed.
 */

import { join } from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
// Import path-mapped by tsconfig `paths`. The orchestrator does not
// reach into pi-tasks's internals beyond the TaskStore class.
import { TaskStore } from "@sages/pi-tasks/task-store";

/**
 * The two canonical agent types that pi-subagents ships with
 * (chore/only-developer-and-reviewer). Kept narrow on purpose — the
 * orchestrator does not invent new agent roles; the LLM picks one of
 * these per phase. Custom agents via `~/.pi/agent/agents/*.md` extend
 * the set, but the tool's static `AgentType` union stays at the
 * shipped set so the typebox schema is tight.
 */
export const AGENT_TYPES = [
	"Developer",
	"Reviewer",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const OrchestrateParams = Type.Object({
	intent: Type.String({
		description:
			"What this plan accomplishes. Free text — surfaced in the orchestrator's audit and in each phase's task description if the phase doesn't supply its own.",
		minLength: 1,
	}),
	phases: Type.Array(
		Type.Object({
			subject: Type.String({
				description:
					"One-line summary of what this phase produces. Used as the task subject in pi-tasks and as the lookup key for `blockedBy` references.",
				minLength: 1,
			}),
			agentType: Type.Union([
				Type.Literal("Developer"),
				Type.Literal("Reviewer"),
			]),
			detail: Type.Optional(
				Type.String({
					description:
						"What this phase does. Defaults to `intent` when omitted.",
				}),
			),
			blockedBy: Type.Optional(
				Type.Array(Type.String({
					description:
						"`subject` of earlier phases this phase depends on. Resolved to task IDs after the first create-pass.",
				})),
			),
		}),
		{ minItems: 1 },
	),
});
export type OrchestrateInput = Static<typeof OrchestrateParams>;

export interface OrchestrateOutput {
	intent: string;
	tasks: Array<{
		id: string;
		subject: string;
		status: string;
		agentType: string;
		blockedBy: string[];
		blocks: string[];
	}>;
}

/**
 * Path to pi-tasks's per-project task store. Mirrors
 * `pi-tasks/src/index.ts:resolveStoreTarget()` (the non-session branch)
 * so tasks created here are visible to pi-tasks's own TaskCreate / TaskList
 * / TaskExecute. The orchestrator's tool is co-resident in cwd.
 */
export function tasksStorePath(cwd: string): string {
	return join(cwd, ".pi", "tasks", "tasks.json");
}

/**
 * Pure planner: turn an `OrchestrateInput` into a sequence of
 * `TaskStore.create` / `TaskStore.update` calls. Extracted so a unit
 * test can run it against an in-memory `TaskStore` without touching the
 * host's tool machinery.
 */
export function plan(input: OrchestrateInput, store: TasksStoreLike): OrchestrateOutput {
	// First pass — create every task, map subject → id.
	const subjectToId = new Map<string, string>();
	const createdIds: string[] = [];
	for (const phase of input.phases) {
		const task = store.create({
			subject: phase.subject,
			description: phase.detail ?? input.intent,
			activeForm: undefined,
			metadata: { agentType: phase.agentType },
		});
		subjectToId.set(phase.subject, task.id);
		createdIds.push(task.id);
	}

	// Second pass — wire dependencies. Edits both ends of every edge so
	// pi-tasks's existing cascade logic (which reads `blockedBy`) and the
	// agent prompt (which reads `blocks`) stay coherent.
	for (const phase of input.phases) {
		const blockedBySubjects = phase.blockedBy ?? [];
		if (blockedBySubjects.length === 0) continue;
		const myId = subjectToId.get(phase.subject);
		if (myId === undefined) continue;
		const predIds: string[] = [];
		for (const subject of blockedBySubjects) {
			const id = subjectToId.get(subject);
			if (id !== undefined) predIds.push(id);
		}
		if (predIds.length === 0) continue;
		for (const predId of predIds) {
			store.update(predId, { addBlocks: [myId] });
		}
		store.update(myId, { addBlockedBy: predIds });
	}

	// Read back the final state for the tool's return payload.
	const tasks = createdIds
		.map((id) => store.get(id))
		.filter((t): t is NonNullable<typeof t> => t !== undefined)
		.map((t) => ({
			id: t.id,
			subject: t.subject,
			status: t.status,
			agentType: (t.metadata?.agentType as string | undefined) ?? "Developer",
			blockedBy: t.blockedBy,
			blocks: t.blocks,
		}));
	return { intent: input.intent, tasks };
}

/** Minimal TaskStore interface the planner needs. Keeps `plan` testable
 *  without standing up a full file-backed store. */
export interface TasksStoreLike {
	create(input: {
		subject: string;
		description: string;
		activeForm?: string;
		metadata?: Record<string, unknown>;
	}): { id: string; subject: string; status: string; blockedBy: string[]; blocks: string[]; metadata?: Record<string, unknown> };
	update(id: string, fields: { addBlocks?: string[]; addBlockedBy?: string[] }): unknown;
	get(id: string):
		| { id: string; subject: string; status: string; blockedBy: string[]; blocks: string[]; metadata?: Record<string, unknown> }
		| undefined;
}

/**
 * Tool wrapper — reads the host-provided cwd from the pi ExecuteContext,
 * instantiates a `TaskStore` pointing at the project task file, and
 * delegates to `plan()`. Returns the DAG as a structured AgentToolResult.
 */
async function orchestrate(
	toolCallId: string,
	params: OrchestrateInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<OrchestrateOutput> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<OrchestrateOutput>> {
	const store = new TaskStore(tasksStorePath(ctx.cwd));
	const data = plan(params, store as unknown as TasksStoreLike);
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

/**
 * Register the `orchestrate` tool on the given pi extension. Idempotent.
 */
export function registerOrchestrateTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "orchestrate",
		label: "Orchestrate",
		description:
				"Materialize a multi-phase plan as a task DAG. " +
				"For each phase, a task is created with the chosen agentType " +
				"recorded in metadata. `blockedBy` references (by phase subject) " +
				"are resolved to task IDs and wired into both sides of the " +
				"dependency. After this call, the standard cascade (via " +
				"`TaskExecute` on the first ready task) drives the phases in " +
				"dependency order. The two shipped agent types are " +
				"Developer and Reviewer.",
		parameters: OrchestrateParams,
		execute: orchestrate,
	});
}
/**
 * Sages pi extension — the runtime entrypoint loaded by pi when it
 * resolves the @sages/pi package.
 *
 * Registers the orchestrator workflow tools (Stage 1-4 of multi-task
 * workflows):
 *   - goal_contract_create
 *   - dag_synthesize
 *   - task_dispatch
 *   - orchestrator_audit
 *
 * Soft mode (GC-2026-031) replaces the historical two-layer hard gate
 * (Layer 1: positive capability allowlist; Layer 2: bash write-intent
 * gate) with a session-scoped recommendation system:
 *
 *   - The main agent has full tool access (`edit`, `write`, `aft_edit`,
 *     `apply_patch`, unrestricted `bash`). Nothing is stripped from
 *     the active toolset on session_start, and no bash command is
 *     blocked at the `tool_call` layer.
 *
 *   - Subagent dispatch via the 4-stage DAG workflow (goal → DAG →
 *     dispatch → audit) is RECOMMENDED for workflows whose todowrite
 *     item count exceeds the active profile's `dag_threshold`. The
 *     agent decides whether to dispatch; no command is blocked.
 *
 *   - Drift from the recommended pattern is auto-steered via a
 *     `pi.appendEntry("system", softModeReminder(profile))` once per
 *     session (fired on the first write-intent bash command). The
 *     reminder is goal-orientation — it does NOT mention "you wrote
 *     production code" (per the user's directive). Drift is never
 *     blocked.
 *
 *   - The `before_agent_start` listener appends
 *     `softModeSystemPromptSuffix(profile)` to the system prompt so
 *     the LLM knows the soft-mode policy from the first turn.
 *
 * As of GC-2026-049, the reminder + suffix are sourced from the active
 * profile (loaded once at module load via `loadProfile()`). The
 * profile is also the source of truth for `subagents` (whitelist),
 * `isolation_default`, `dag_threshold`, and `gate_suite`.
 *
 * Subagent dispatch and lifecycle are owned by `@tintinweb/pi-subagents`
 * (installed separately). The canonical built-in agents are
 * `developer`, `auditor`, `Explore`, `Plan`. The `git-expert` agent
 * is the default cross-workspace git inspection helper.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { registerOrchestratorTools } from "./tools/orchestrator/index.js";
import { classifyBashCommand } from "./tools/bash-guard.js";
import { loadProfile } from "./profile.js";
import { softModeReminder, softModeSystemPromptSuffix } from "./soft-mode.js";
import {
	orchestratorAdvisoryFor,
	type OrchestratorToolCall,
	type OrchestratorAdvisoryContext,
} from "./tools/orchestrator/l1-advisory.js";
import { loadGoalContract, loadPlan } from "./tools/orchestrator/dag-synthesizer.js";
import { ORCHESTRATOR_DIR } from "./tools/orchestrator/types.js";
import {
	RunEvent,
	StepEvent,
	SeamEvent,
	emitRunEvent,
	emitStepEvent,
	emitSeamEvent,
	onSeam,
} from "./observability/index.js";
import { installSagesRoutines } from "./tools/routines/sages-routines-install.js";
import {
	buildTurnTodoBlock,
	advanceStale,
	staleReminderFor,
	resetStale,
	type StaleTracker,
} from "./tools/todo/todo-reminder.js";
import {
	TodoStateManager,
	loadTodoState,
	resolveRepoRoot,
	saveTodoState,
	todoStateDir,
	type TodoDiff,
	type TodoItem,
} from "./tools/todo/todo-state.js";
import { deriveDagTodos, registerSagesTodoTool } from "./tools/todo/sages-todo-tool.js";
import { maybeCompileDagFromTodos } from "./tools/todo/dag-compile.js";
import { buildSessionDigest, formatSessionDigest } from "./observability/digest.js";

// Load the active profile once at module load. Resolution order is
// documented in `profile.ts`; falls back to the `standard` built-in
// when no user override is present.
const PROFILE = loadProfile();

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerOrchestratorTools(pi);
	// GC-2026-060: the root-agent todo tool (sync/get/auto-plan).
	// Registered on the root extension only — subagent toolsets never
	// include it, and the store rejects any non-root owner.
	registerSagesTodoTool(pi);

	// ── Seam event registration (GC-2026-050) ────────────────────────────
	// Register a no-op seam callback for the Preflight hook so downstream
	// tools that call `emitSeamEvent(SeamEvent.Preflight, ...)` always
	// find at least one registered listener at runtime. The actual seam
	// (preflight) wiring is performed by `tool-fence.ts` once the
	// orchestrator tools register themselves; this default no-op keeps
	// the seam dispatcher failure-mode visible (empty registry → silent
	// success) rather than latent.
	//
	// The registry is process-scoped and reset by tests via
	// `clearSeamCallbacks()`. It is intentionally NOT persisted across
	// sessions — extension re-registers on every `registerSagesExtension`
	// call.
	onSeam(SeamEvent.Preflight, async () => {
		// Default seam listener: a no-op so the dispatcher always has at
		// least one callback. Real preflight logic lives in the
		// orchestrator's tool-fence module.
	});

	// ── Session-scoped state ──────────────────────────────────────────
	// Mutable closure: each event handler reads / mutates the same state.
	// pi's extension API is single-threaded (events fire serially), so no
	// lock is needed. The state is reset on every session_start.
	//
	// Under soft mode the only session-scoped flag is the auto-steer
	// throttle: the soft-mode reminder is appended at most once per
	// session to avoid spamming the LLM with duplicate reminders.
	let remindedThisSession = false;

	// ── L1 orchestrator advisory state (GC-2026-053) ─────────────────────
	// Mirror of L2's `AdvisoryContext` but lifted to the root agent so
	// the orchestrator's own tool-call stream is audited. Reset on
	// every session_start. The dedup set + dispatch counter suppress
	// repeat advisories for the same rule across the same session,
	// matching the L2 dedup/cap contract exactly.
	let l1History: OrchestratorToolCall[] = [];
	const l1Ctx: OrchestratorAdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesSent: 0,
	};

	// ── GC-2026-060 auto-todowrite session state ────────────────────────
	// The pi built-in `todowrite` tool keeps its list only in LLM
	// context; the extension mirrors each call into a durable
	// TodoStateManager (persisted to <repo>/.pi/orchestrator/
	// todo-state.json) so before_agent_start can inject the current
	// list + change highlight every turn and turn_end can remind about
	// stale in_progress todos. Root-agent-only: subagent sessions never
	// reach this extension's listeners, and the store itself rejects
	// any non-root owner (defense-in-depth).
	let todoState = new TodoStateManager();
	let staleTracker: StaleTracker = { increments: {} };
	let lastTodoChange: TodoDiff | null = null;
	// Rate limit: one reminder per stale todo identity per session.
	const remindedTodoKeys = new Set<string>();
	// GC-2026-061: session defaults for compiled dag identity — the most
	// recent orchestrator tool call's dag/goal, used when structured
	// todos carry no explicit dag_id / goal_id.
	let sessionDagId: string | null = null;
	let sessionGoalId: string | null = null;

	// ── Session start: reset auto-steer throttle + L1 advisory state ────
	// Soft mode does not touch the active toolset (Layer 1 is gone).
	// The session_start handler only resets the reminder flag so the
	// first write-intent bash command in a new session emits the
	// reminder once. Previous-session state is otherwise irrelevant.
	//
	// GC-2026-050: run/* event scaffold. The `RunEvent.GoalCreated`
	// event is NOT emitted here because there is no DAG id at
	// session_start time. The actual emission happens at goal-creation
	// time inside `goal_contract_create.ts` (a future orchestrator
	// follow-up). We deliberately do NOT call `emitRunEvent()` from
	// session_start — that would (a) require a placeholder dag_id and
	// (b) race with the orchestrator's real emission.
	pi.on("session_start", (event: any, ctx: any) => {
		remindedThisSession = false;
		l1History = [];
		l1Ctx.alreadyAdvisedRules = new Set<string>();
		l1Ctx.advisoriesSent = 0;

		// GC-2026-060: reset + restore the root todo state. A persisted
		// <repo>/.pi/orchestrator/todo-state.json survives compaction and
		// process restarts, so the todo list resumes across sessions.
		const cwd: string = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		todoState = loadTodoState(todoStateDir(resolveRepoRoot(cwd))) ?? new TodoStateManager();
		staleTracker = { increments: {} };
		lastTodoChange = null;
		remindedTodoKeys.clear();
		sessionDagId = null;
		sessionGoalId = null;
		// GC-2026-055: auto-install the 3 Sages routine templates
		// (sages-session-wrap / sages-resume / sages-watchdog) into
		// the pi-routines store at session_start. Idempotent on
		// subsequent loads (existing routines skipped by name).
		// Synchronous: small templates, no fs read on the hot path.
		try {
			installSagesRoutines();
		} catch (err) {
			// Don't fail session_start; just log and continue.
			console.error(
				`[sages] installSagesRoutines failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// GC-2026-067 T2: surface a one-shot `[sages session digest]`
		// reminder listing in-flight goals, pending audit verdicts,
		// unmerged branches, and todo state. The digest scans the
		// orchestrator state directory + runs `git worktree list` /
		// `git rev-list --count` for branch-ahead detection. Failure
		// modes (no orchestrator dir, no git, corrupt yaml) all
		// degrade to empty sections — never throw out of session_start.
		try {
			const digest = buildSessionDigest(cwd);
			if (digest !== null) {
				pi.appendEntry("system", formatSessionDigest(digest));
			}
		} catch (err) {
			console.error(
				`[sages] buildSessionDigest failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	// ── Bash tool_call handler — soft mode ────────────────────────────
	// Soft mode: NEVER block. The handler still classifies each command
	// so it can fire the once-per-session auto-steer reminder on the
	// first write-intent bash call. The reminder is goal-orientation,
	// not "you wrote production code" feedback.
	//
	// GC-2026-050: the existing `pi.appendEntry("system", ...)` is
	// preserved for backward compatibility (the
	// `test/tools/main-agent-toolset.test.ts` suite asserts on it).
	// A `step/preflight` event is also emitted so the canonical Sages
	// observability trace captures the reminder boundary. Both fire in
	// the same turn; the appendEntry is marked deprecated in favor of
	// `emitStepEvent(StepEvent.Preflight, ...)`.
	pi.on("tool_call", (event: any, ctx: any) => {
		if (event.toolName !== "bash") return;
		const command: string = event?.input?.command;
		if (typeof command !== "string" || command.length === 0) return;

		const classification = classifyBashCommand(command);
		if (classification === "write-intent" && !remindedThisSession) {
			remindedThisSession = true;
			// Canonical observability trace — the step/* event the Sages
			// audit pipeline subscribes to.
			emitStepEvent(StepEvent.Preflight, { profile: PROFILE.id });
			// @deprecated — kept for backward compatibility with
			// `test/tools/main-agent-toolset.test.ts`. Will be removed
			// once that test migrates to assert on `emitStepEvent` /
			// a stub `StepEvent.Preflight` listener instead.
			pi.appendEntry("system", softModeReminder(PROFILE));
		}
		return undefined;
	});

	// ── L1 orchestrator tool_call handler (GC-2026-053) ─────────────────
	// Separate handler so L1 logic stays isolated from the soft-mode
	// bash classifier. Runs on every orchestrator tool call, not just
	// bash; appends the call to history then asks `orchestratorAdvisoryFor`
	// for any advisories that should fire. Caps + dedup mirror L2.
	pi.on("tool_call", (event: any, ctx: any) => {
		const toolName: string = event?.toolName;
		if (typeof toolName !== "string" || toolName.length === 0) return;
		const input =
			event?.input && typeof event.input === "object" ? event.input : {};
		l1History.push({ toolName, input, timestamp: Date.now() });

		const cwd: string = ctx?.cwd ?? process.cwd();
		const advisories = orchestratorAdvisoryFor(l1History, l1Ctx, {
			loadGoalScope: (goalId) => {
				const goal = loadGoalContract(cwd, goalId);
				if (!goal) return null;
				return {
					goal_id: goal.id,
					scope_include: goal.scope?.include ?? [],
					scope_exclude: goal.scope?.exclude ?? [],
				};
			},
			loadDagPlan: (dagId) => {
				const plan = loadPlan(cwd, dagId);
				if (!plan) return null;
				return {
					tasks: plan.tasks.map((t) => ({
						id: t.id,
						status: t.status,
						depends_on: t.depends_on ?? [],
					})),
				};
			},
		});
		for (const advisory of advisories) {
			pi.appendEntry("system", advisory);
			// Update dedup + cap counters exactly like L2 does.
			const ruleMatch = advisory.match(
				/^\[orchestrator audit advisory — \d+\/\d+\] ([a-z_]+):/,
			);
			if (ruleMatch && ruleMatch[1]) {
				l1Ctx.alreadyAdvisedRules.add(ruleMatch[1]);
			}
			l1Ctx.advisoriesSent += 1;
		}
		return undefined;
	});

	// ── GC-2026-060 todo mirror tool_call handler ────────────────────────
	// Third tool_call handler (registration order matters: the bash
	// classifier + L1 advisory stay first and keep their exact
	// behavior). Mirrors the built-in `todowrite` calls into the root
	// todo store and triggers an auto-plan sync when the orchestrator
	// synthesizes a DAG or runs an audit. sages_todo is NOT mirrored —
	// it writes the store directly.
	pi.on("tool_call", (event: any, ctx: any) => {
		const toolName: string = event?.toolName;
		if (typeof toolName !== "string" || toolName.length === 0) return undefined;
		const input: Record<string, unknown> =
			event?.input && typeof event.input === "object" ? event.input : {};

		// Root-only defensive guard: an explicit non-root owner marker is
		// rejected before any state mutation (subagent session guard).
		if (input.owner !== undefined && input.owner !== "root") return undefined;

		const cwd: string = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		const repoRoot = resolveRepoRoot(cwd);
		const stateDir = todoStateDir(repoRoot);

		try {
			if (toolName === "todowrite" || (toolName === "sages_todo" && input.action === "sync")) {
				const items = todoItemsFromRaw(input.todos);
				if (items.length === 0) return undefined; // empty / all entries malformed
				lastTodoChange = todoState.apply(items);
				saveTodoState(stateDir, todoState);
				// GC-2026-061: structured todos (kind 'task' / depends_on /
				// batch) compile into a DAG. dag_synthesize's plan is
				// authoritative and is never overwritten — see the policy in
				// maybeCompileDagFromTodos.
				maybeCompileDagFromTodos(items, repoRoot, { sessionDagId, sessionGoalId });
				return undefined;
			}

			if (toolName === "dag_synthesize" || toolName === "orchestrator_audit") {
				const dagId =
					typeof input.dag_id === "string" && input.dag_id.length > 0
						? input.dag_id
						: toolName === "dag_synthesize" &&
							  typeof input.goal_id === "string" &&
							  input.goal_id.length > 0
							? input.goal_id
							: newestDagId(repoRoot);
				if (dagId === null) return undefined;
				// GC-2026-061: remember the most recent orchestrator dag/goal
				// so structured todos without an explicit dag_id compile under
				// the same plan identity.
				sessionDagId = dagId;
				if (typeof input.goal_id === "string" && input.goal_id.length > 0) {
					sessionGoalId = input.goal_id;
				}
				const derived = deriveDagTodos(dagId, repoRoot);
				if (derived.length === 0) return undefined; // no DAG → never wipe the list
				lastTodoChange = todoState.apply(derived);
				saveTodoState(stateDir, todoState);
				return undefined;
			}
		} catch {
			// Best-effort observability: a malformed mirror must never
			// break the agent's tool execution.
		}
		return undefined;
	});

	// ── before_agent_start: surface soft-mode policy + todo state ────────
	// Every turn, append the profile's system-prompt suffix, then the
	// compact per-turn todo block when the root todo list is non-empty
	// OR a change diff is pending (an empty list with no pending diff
	// injects nothing — avoid noise). The diff is one-shot: it is
	// cleared after this turn's injection so the highlight appears
	// exactly once.
	pi.on("before_agent_start", (event: any) => {
		const base: string = event?.systemPrompt ?? "";
		let prompt = `${base}${base ? "\n\n" : ""}${softModeSystemPromptSuffix(PROFILE)}`;
		const todos = todoState.getTodos();
		const diffPending = lastTodoChange !== null && todoDiffHasChanges(lastTodoChange);
		if (todos.length > 0 || diffPending) {
			prompt = `${prompt}\n\n${buildTurnTodoBlock(todos, lastTodoChange ?? undefined)}`;
		}
		lastTodoChange = null;
		return { systemPrompt: prompt };
	});

	// ── GC-2026-060 input reset ─────────────────────────────────────────
	// A user interjection resets the staleness clock (mirroring the
	// deepseek-harness repeat-tool-reminder reset contract) and drops
	// any pending change diff (the user's message supersedes it).
	pi.on("input", () => {
		staleTracker = resetStale(staleTracker);
		lastTodoChange = null;
	});

	// ── GC-2026-060 turn_end stale advance ──────────────────────────────
	// After each turn, advance the stale tracker for todos that are
	// still in_progress and append a system reminder when an item has
	// been active for `gentle` (3) / `detailed` (5) consecutive turns
	// without progress. Rate-limited: each todo identity gets at most
	// one reminder per session.
	pi.on("turn_end", () => {
		const todos = todoState.getTodos();
		const activeIds = todoState.getInProgress().map((t) => t.id ?? t.content);
		staleTracker = advanceStale(staleTracker, todos, activeIds);
		const reminder = staleReminderFor(staleTracker, { gentle: 3, detailed: 5 });
		if (reminder === null) return;
		const staleKeys = Object.keys(staleTracker.increments).filter(
			(key) => staleTracker.increments[key] >= 3,
		);
		const newKeys = staleKeys.filter((key) => !remindedTodoKeys.has(key));
		if (newKeys.length === 0) return;
		for (const key of staleKeys) remindedTodoKeys.add(key);
		pi.appendEntry("system", `[sages todo reminder] ${reminder}`);
	});
}

// ── GC-2026-060 helpers ────────────────────────────────────────────────────

/**
 * Normalize raw todowrite / sages_todo sync entries into TodoItems.
 * Validates content + status, preserves id / priority and the
 * GC-2026-061 structured fields (kind / depends_on / batch / dag_id /
 * goal_id / prompt / files) so the compile trigger can see them.
 * Malformed entries are dropped; returns [] when nothing is usable.
 */
function todoItemsFromRaw(rawTodos: unknown): TodoItem[] {
	if (!Array.isArray(rawTodos) || rawTodos.length === 0) return [];
	return rawTodos
		.filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
		.filter(
			(t) =>
				typeof t.content === "string" &&
				t.content.length > 0 &&
				(t.status === "pending" ||
					t.status === "in_progress" ||
					t.status === "completed"),
		)
		.map((t) => {
			const item: TodoItem = {
				content: t.content as string,
				status: t.status as TodoItem["status"],
			};
			if (typeof t.id === "string" && t.id.length > 0) item.id = t.id;
			if (t.priority === "high" || t.priority === "medium" || t.priority === "low") {
				item.priority = t.priority;
			}
			if (t.kind === "plan" || t.kind === "task") item.kind = t.kind;
			if (Array.isArray(t.depends_on) && t.depends_on.every((d) => typeof d === "string")) {
				item.depends_on = t.depends_on as string[];
			}
			if (typeof t.batch === "number" && Number.isInteger(t.batch) && t.batch >= 1) {
				item.batch = t.batch;
			}
			if (typeof t.dag_id === "string" && t.dag_id.length > 0) item.dag_id = t.dag_id;
			if (typeof t.goal_id === "string" && t.goal_id.length > 0) item.goal_id = t.goal_id;
			if (typeof t.prompt === "string" && t.prompt.length > 0) item.prompt = t.prompt;
			if (Array.isArray(t.files) && t.files.every((f) => typeof f === "string")) {
				item.files = t.files as string[];
			}
			return item;
		});
}

/** True when a whole-list diff contains at least one visible change. */
function todoDiffHasChanges(diff: TodoDiff): boolean {
	return (
		diff.added.length > 0 ||
		diff.removed.length > 0 ||
		diff.completed.length > 0 ||
		diff.reopened.length > 0
	);
}

/**
 * Newest `.pi/orchestrator/dag-*.yaml` id by mtime, or null when no DAG
 * file exists. Used as the auto-plan fallback when a tool call does not
 * carry an explicit dag_id / goal_id.
 */
function newestDagId(repoRoot: string): string | null {
	try {
		const dir = join(repoRoot, ORCHESTRATOR_DIR);
		if (!existsSync(dir)) return null;
		const newest = readdirSync(dir)
			.filter((f) => f.startsWith("dag-") && f.endsWith(".yaml"))
			.map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0];
		if (!newest) return null;
		return newest.f.slice("dag-".length, -".yaml".length);
	} catch {
		return null;
	}
}

// Exported for tests that want to assert which profile the extension
// booted under. Production code should treat PROFILE as immutable.
export { PROFILE };
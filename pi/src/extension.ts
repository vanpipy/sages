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

// Load the active profile once at module load. Resolution order is
// documented in `profile.ts`; falls back to the `standard` built-in
// when no user override is present.
const PROFILE = loadProfile();

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerOrchestratorTools(pi);

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
	pi.on("session_start", () => {
		remindedThisSession = false;
		l1History = [];
		l1Ctx.alreadyAdvisedRules = new Set<string>();
		l1Ctx.advisoriesSent = 0;
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

	// ── before_agent_start: surface soft-mode policy in the system prompt ─
	// Every turn, prepend the profile's system-prompt suffix to the
	// system prompt so the LLM knows the soft-mode policy from the
	// first turn. The suffix describes the recommendation thresholds,
	// the available subagents, and the auto-steer behavior.
	pi.on("before_agent_start", (event: any) => {
		const base: string = event?.systemPrompt ?? "";
		return {
			systemPrompt: `${base}${base ? "\n\n" : ""}${softModeSystemPromptSuffix(PROFILE)}`,
		};
	});
}

// Exported for tests that want to assert which profile the extension
// booted under. Production code should treat PROFILE as immutable.
export { PROFILE };
/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { resolveType } from "./agent-types.js";
import { enforceDeveloperManagedIsolationPolicy } from "./invocation-config.js";
import { inc as profileInc } from "./profile.js";
import type {
	AgentInvocation,
	AgentRecord,
	IsolationMode,
	ManagedWorktreeHandoff,
	SubagentType,
	ThinkingLevel,
} from "./types.js";
import { addUsage } from "./usage.js";
import {
	acquireManagedWorktreeLease,
	branchName,
	cleanupWorktree,
	createManagedWorktree,
	createWorktree,
	deleteManagedWorktree,
	deleteManagedWorktreeByPath,
	inspectManagedWorktree,
	pruneWorktrees,
	releaseManagedWorktreeLease,
	worktreePath,
} from "./worktree.js";
import type { ManagedWorktreeRequest } from "./worktree-contract.js";
import {
	parseManagedWorktreeRequest,
	validateManagedWorktreeRequest,
} from "./worktree-contract.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (
	record: AgentRecord,
	info: CompactionInfo,
) => void;
export type CompactionInfo = {
	reason: "manual" | "threshold" | "overflow";
	tokensBefore: number;
};

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(
	cwd: unknown,
): asserts cwd is string | undefined | null {
	if (cwd == null) return;
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		throw new Error(
			`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`,
		);
	}
	let isDirectory = false;
	try {
		isDirectory = statSync(cwd).isDirectory();
	} catch {
		throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
	}
	if (!isDirectory) {
		throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
	}
}

interface SpawnArgs {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	type: SubagentType;
	prompt: string;
	options: SpawnOptions;
}

interface SpawnOptions {
	description: string;
	model?: Model<any>;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	thinkingLevel?: ThinkingLevel;
	isBackground?: boolean;
	/**
	 * Skip the maxConcurrent queue check for this spawn — start immediately even
	 * if the configured concurrency limit would otherwise queue it. Used by the
	 * scheduler so a fired job can't be deferred past its trigger window.
	 */
	bypassQueue?: boolean;
	/** Isolation mode — "worktree" creates a temp git worktree for the agent.
	 *
	 * Kept as a string-only literal for back-compat with upstream tests; the
	 * Sages callers go through `managedWorktree` instead. The Agent tool's
	 * `params.isolation` accepts an object form too, but it is rewritten into
	 * the `managedWorktree` channel before reaching this struct — see
	 * `resolveAgentInvocationConfig` in `invocation-config.ts`. */
	isolation?: IsolationMode;
	/**
	 * Working directory for the agent (absolute path). Default: parent session
	 * cwd. The agent's tools operate here, but .pi config (extensions, skills,
	 * settings, memory) still loads from the parent session's project — the
	 * target directory's `.pi` extensions never execute. With isolation:
	 * "worktree", the worktree is created FROM this directory and the result
	 * branch lands in that repo.
	 */
	cwd?: string;
	/** Resolved invocation snapshot captured for UI display. */
	invocation?: AgentInvocation;
	/** Parent abort signal — when aborted, the subagent is also stopped. */
	signal?: AbortSignal;
	/** Called on tool start/end with activity info (for streaming progress to UI). */
	onToolActivity?: (activity: ToolActivity) => void;
	/** Called on streaming text deltas from the assistant response. */
	onTextDelta?: (delta: string, fullText: string) => void;
	/** Called when the agent session is created (for accessing session stats). */
	onSessionCreated?: (session: AgentSession) => void;
	/** Called at the end of each agentic turn with the cumulative count. */
	onTurnEnd?: (turnCount: number) => void;
	/** Called once per assistant message_end with that message's usage delta. */
	onAssistantUsage?: (usage: {
		input: number;
		output: number;
		cacheWrite: number;
	}) => void;
	/** Called when the session successfully compacts. */
	onCompaction?: (info: CompactionInfo) => void;
	/**
	 * Explicit managed-worktree request for the Sages callers (orchestrator
	 * DAGs). When set, the manager provisions (or reuses) the managed
	 * worktree at `<repoRoot>/.pi/worktree/<dag_id>/<worktree_id?task_id>`,
	 * acquires a lease so concurrent spawns collide, sets the child's cwd to
	 * the worktree path, and surfaces the handoff on `AgentRecord.managedWorktree`.
	 * Mutually exclusive with the legacy `isolation: "worktree"` (which falls
	 * back to a tmpdir copy).
	 */
	managedWorktree?: ManagedWorktreeRequest;
}

export class AgentManager {
	private agents = new Map<string, AgentRecord>();
	private cleanupInterval: ReturnType<typeof setInterval>;
	private onComplete?: OnAgentComplete;
	private onStart?: OnAgentStart;
	private onCompact?: OnAgentCompact;
	private maxConcurrent: number;
	/** Base repos worktrees were created from — so dispose() can prune them all,
	 *  not just the parent repo (caller-supplied cwd can target other repos). */
	private worktreeRepos = new Set<string>();

	/** Queue of background agents waiting to start. */
	private queue: { id: string; args: SpawnArgs }[] = [];
	/** Number of currently running background agents. */
	private runningBackground = 0;

	constructor(
		onComplete?: OnAgentComplete,
		maxConcurrent = DEFAULT_MAX_CONCURRENT,
		onStart?: OnAgentStart,
		onCompact?: OnAgentCompact,
	) {
		this.onComplete = onComplete;
		this.onStart = onStart;
		this.onCompact = onCompact;
		this.maxConcurrent = maxConcurrent;
		// Cleanup completed agents after 10 minutes (but keep sessions for resume)
		this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
		this.cleanupInterval.unref();
		// GC-2026-020 instrumentation: each AgentManager factory instantiation
		// is a multiplicative CPU event in the user's "many pi instances"
		// pattern — pinned so a B/C refactor can reason about fan-out.
		profileInc("agent_manager_factory_instantiated");
	}

	/**
	 * Mark an agent record as finished exactly once across every code path
	 * (.then / .catch / stop / abortAll / late-failure-catch). The guard
	 * checks `completedAt` BEFORE assignment so concurrent transitions all
	 * collapse on the first writer.
	 */
	private noteFinishOnce(record: AgentRecord): void {
		if (record.completedAt) return;
		// Decrement the live-agents gauge (separate from `finished_total`,
		// the lifetime completion counter).
		profileInc("agent_manager_live", -1);
		profileInc("finished_total", 1);
	}

	/** Update the max concurrent background agents limit. */
	setMaxConcurrent(n: number) {
		this.maxConcurrent = Math.max(1, n);
		// Start queued agents if the new limit allows
		this.drainQueue();
	}

	getMaxConcurrent(): number {
		return this.maxConcurrent;
	}

	/**
	 * Spawn an agent and return its ID immediately (for background use).
	 * If the concurrency limit is reached, the agent is queued.
	 */
	spawn(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		type: SubagentType,
		prompt: string,
		options: SpawnOptions,
	): string {
		// Resolve the registry name before validating options or creating any
		// queue/record state. Direct callers (RPC, scheduler, tests) bypass the
		// Agent tool dispatcher, so the manager boundary must fail synchronously
		// for unknown or disabled names rather than starting a doomed agent.
		const canonicalType = resolveType(type);
		if (!canonicalType) {
			throw new Error(`Unknown agent type "${type}"`);
		}

		// Validate before the queue branch — a queued spawn should fail at the
		// call, not minutes later at drain. Throw (not warn): programmatic callers
		// can fix and retry; the RPC layer converts throws into error envelopes.
		assertValidSpawnCwd(options.cwd);

		// Phase A P2 (DAG-2026-011) (updated GC-2026-014): enforce managed-
		// isolation policy at the spawn boundary. The Agent tool dispatcher also
		// checks this, but spawn() is the safety net for direct callers such as
		// cross-extension RPC and the scheduler.
		if (canonicalType === "developer") {
			const policyError = enforceDeveloperManagedIsolationPolicy(
				canonicalType,
				options.managedWorktree ?? options.isolation,
			);
			if (policyError) {
				throw new Error(policyError);
			}
		}

		const id = randomUUID().slice(0, 17);
		const abortController = new AbortController();
		const record: AgentRecord = {
			id,
			type: canonicalType,
			description: options.description,
			status: options.isBackground ? "queued" : "running",
			toolUses: 0,
			startedAt: Date.now(),
			abortController,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			compactionCount: 0,
			// Raw tri-state (not coerced to a boolean): true = background, false =
			// foreground (has an inline tool-result surface), undefined = caller never
			// declared it (e.g. a cross-extension RPC spawn). The widget's background-
			// only filter excludes only explicit `false`, so undefined agents — which
			// have no inline surface — stay visible instead of vanishing.
			isBackground: options.isBackground,
			invocation: options.invocation,
		};
		this.agents.set(id, record);
		// GC-2026-020 instrumentation: every spawn path counts once, even when
		// it ends up in the concurrency queue (the queue still represents a
		// live agent). Live-agent gauge tracks spawned-not-yet-finished count.
		profileInc("spawned_total", 1);
		profileInc("agent_manager_live", 1);

		const args: SpawnArgs = { pi, ctx, type, prompt, options };

		if (
			options.isBackground &&
			!options.bypassQueue &&
			this.runningBackground >= this.maxConcurrent
		) {
			// Queue it — will be started when a running agent completes
			this.queue.push({ id, args });
			return id;
		}

		// startAgent can throw (e.g. strict worktree-isolation failure) — clean
		// up the record so callers don't see an orphan in `listAgents()`.
		try {
			this.startAgent(id, record, args);
		} catch (err) {
			this.agents.delete(id);
			throw err;
		}
		return id;
	}

	/** Actually start an agent (called immediately or from queue drain). */
	private startAgent(
		id: string,
		record: AgentRecord,
		{ pi, ctx, type, prompt, options }: SpawnArgs,
	) {
		// Re-validate a caller-supplied cwd: queued spawns can start minutes after
		// spawn()'s check, and the directory may be gone by then (TOCTOU). Same
		// curated errors; drainQueue parks a throw on the record as an error.
		assertValidSpawnCwd(options.cwd);
		// Single resolution point for the caller-supplied cwd — the worktree base
		// repo and both cleanup calls below MUST agree on this value forever.
		const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
		const baseCwd = customCwd ?? ctx.cwd;

		// ---- Managed-worktree provisioning (GC-2026-008 P2) --------------------
		//
		// When `options.managedWorktree` is set, the manager:
		//   1. Parses + validates the request (delegates to worktree-contract.ts).
		//   2. Acquires the in-process lease (concurrent spawns collide).
		//   3. Creates or reuses the managed worktree at
		//      `<baseCwd>/.pi/worktree/<dag>/<worktree>`.
		//   4. Records the handoff on `record.managedWorktree` + lease token.
		//   5. Overrides the child's cwd to the managed worktree path.
		//
		// On any throw from step 1–3 the lease is released before propagating so
		// callers can retry without first having to clear the lock.
		//
		// The legacy `isolation: "worktree"` path is intentionally kept distinct:
		// it lives in /tmp and is for non-Sages callers that want a throwaway copy.
		// Sages callers must pass the new explicit request object.
		let managedWorktreeHandoff: ManagedWorktreeHandoff | undefined;
		let managedWorktreeLeaseToken: string | undefined;
		let worktreeCwd: string | undefined;
		if (options.managedWorktree) {
			const req = parseManagedWorktreeRequest(options.managedWorktree);
			validateManagedWorktreeRequest(req);
			const worktreeId = req.worktree_id ?? req.task_id;
			// Acquire lease FIRST so two simultaneous spawns collide loudly. The
			// lease is in-process; the orchestrator's parent session serializes
			// spawns on its own anyway, but tooling like the test runner that
			// exercises contract paths in parallel still relies on this guard.
			const lease = acquireManagedWorktreeLease(req.dag_id, worktreeId);
			managedWorktreeLeaseToken = lease.token;
			try {
				const wt = createManagedWorktree({
					repoRoot: baseCwd,
					dag: req.dag_id,
					worktree: worktreeId,
					reuse: req.mode === "reuse",
					// Forward the caller's explicit base_ref (or undefined to
					// auto-detect from the cwd's current branch). The helper
					// resolves the actual ref; we just plumb the request through.
					base_ref: req.base_ref,
				});
				// Inspect at provision time so we can capture `dirty` + `head` for
				// handoff; the inspector never mutates, so this is safe even if the
				// agent is about to write into the worktree.
				let head = "";
				let dirty = false;
				try {
					const inspection = inspectManagedWorktree(wt);
					head = inspection.currentSha;
					dirty = inspection.hasUncommittedChanges;
				} catch {
					// Inspect failures don't block provisioning — the agent still
					// gets a clean handoff; downstream tools can re-inspect.
				}
				managedWorktreeHandoff = {
					path: wt.path,
					branch: wt.branch,
					baseSha: wt.baseSha,
					// baseRef is now dynamic (resolved at provision time) —
					// surface the actual ref so downstream consumers can
					// audit which baseline the worktree branched from.
					baseRef: wt.baseRef,
					head,
					dirty,
					reused: wt.reused,
					leaseToken: lease.token,
					dag_id: req.dag_id,
					task_id: req.task_id,
					worktree_id: worktreeId,
					repoRoot: wt.repoRoot,
				};
				// Managed worktree wins for the working dir — the agent must run
				// INSIDE the on-disk worktree, never in the host repo.
				worktreeCwd = wt.path;
				this.worktreeRepos.add(baseCwd);
			} catch (err) {
				// Roll back the lease before the throw bubbles — otherwise a
				// second attempt would silently fail with a stale lease message.
				try {
					releaseManagedWorktreeLease(lease);
				} catch {
					/* ignore */
				}
				managedWorktreeLeaseToken = undefined;
				throw err;
			}
		}

		// Worktree isolation: try to create a temporary git worktree. Strict —
		// fail loud if not possible (no silent fallback to main tree). Done
		// BEFORE state mutation so a throw doesn't leave the record half-running.
		if (options.isolation === "worktree") {
			const wt = createWorktree(baseCwd, id);
			if (!wt) {
				// Roll back the managed-worktree lease if we acquired one above.
				if (managedWorktreeLeaseToken) {
					try {
						releaseManagedWorktreeLease({
							token: managedWorktreeLeaseToken,
							dag: managedWorktreeHandoff!.dag_id,
							worktree: managedWorktreeHandoff!.worktree_id,
						});
					} catch {
						/* ignore */
					}
				}
				throw new Error(
					'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
						"Initialize git and commit at least once, or omit `isolation`.",
				);
			}
			record.worktree = wt;
			// workPath preserves subdirectory scoping for caller-supplied cwds: a
			// cwd deep in a monorepo maps to the same subdir inside the copy, not
			// the copied repo's root. Plain worktree spawns keep the historical
			// behavior (agent at the copy's root) — moving them to workPath would
			// also move .pi config discovery when the parent session sits in a repo
			// subdirectory, silently dropping extensions/skills.
			worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
			this.worktreeRepos.add(baseCwd);
		}

		// Attach the handoff to the record BEFORE flipping status to "running".
		// This guarantees `getRecord(id).managedWorktree` is populated from the
		// moment downstream code (UI, get_subagent_result, steer) can observe
		// the agent.
		if (managedWorktreeHandoff) {
			record.managedWorktree = managedWorktreeHandoff;
			record.managedWorktreeLease = managedWorktreeLeaseToken;
		}

		record.status = "running";
		record.startedAt = Date.now();
		if (options.isBackground) this.runningBackground++;
		this.onStart?.(record);

		// Wire parent abort signal to stop the subagent when the parent is interrupted
		let detachParentSignal: (() => void) | undefined;
		if (options.signal) {
			const onParentAbort = () => this.abort(id);
			options.signal.addEventListener("abort", onParentAbort, { once: true });
			detachParentSignal = () =>
				options.signal!.removeEventListener("abort", onParentAbort);
		}
		const detach = () => {
			detachParentSignal?.();
			detachParentSignal = undefined;
		};

		const promise = runAgent(ctx, type, prompt, {
			pi,
			agentId: id,
			model: options.model,
			maxTurns: options.maxTurns,
			isolated: options.isolated,
			inheritContext: options.inheritContext,
			thinkingLevel: options.thinkingLevel,
			// Worktree wins for the working dir (the agent must run in the copy —
			// which, with a custom cwd, was created from that target). Config stays
			// with the parent project when a caller-supplied cwd is in play; it must
			// stay undefined otherwise so plain worktree runs keep resolving config
			// (incl. relative extension paths and memory) inside the worktree copy.
			cwd: worktreeCwd ?? customCwd,
			configCwd: customCwd !== undefined ? ctx.cwd : undefined,
			signal: record.abortController!.signal,
			onToolActivity: (activity) => {
				if (activity.type === "end") record.toolUses++;
				options.onToolActivity?.(activity);
			},
			onTurnEnd: options.onTurnEnd,
			onTextDelta: options.onTextDelta,
			onAssistantUsage: (usage) => {
				addUsage(record.lifetimeUsage, usage);
				options.onAssistantUsage?.(usage);
			},
			onCompaction: (info) => {
				record.compactionCount++;
				this.onCompact?.(record, info);
				options.onCompaction?.(info);
			},
			onSessionCreated: (session) => {
				record.session = session;
				// Flush any steers that arrived before the session was ready
				if (record.pendingSteers?.length) {
					for (const msg of record.pendingSteers) {
						session.steer(msg).catch(() => {});
					}
					record.pendingSteers = undefined;
				}
				options.onSessionCreated?.(session);
			},
		})
			.then(({ responseText, session, aborted, steered, failure }) => {
				// Don't overwrite status if externally stopped via abort()
				if (record.status !== "stopped") {
					// Precedence: a hard abort keeps "aborted"; then a failed final turn
					// (provider error that pi resolved instead of rejecting, #144) is an
					// honest "error" — not a completion with an empty or stale result.
					if (aborted) {
						record.status = "aborted";
					} else if (failure) {
						record.status = "error";
						record.error = failure;
					} else {
						record.status = steered ? "steered" : "completed";
					}
				}
				record.result = responseText;
				record.session = session;
				record.completedAt ??= Date.now();

				detach();

				// Final flush of streaming output file
				if (record.outputCleanup) {
					try {
						record.outputCleanup();
					} catch {
						/* ignore */
					}
					record.outputCleanup = undefined;
				}

				// Clean up worktree if used
				if (record.worktree) {
					const wtResult = cleanupWorktree(
						baseCwd,
						record.worktree,
						options.description,
					);
					record.worktreeResult = wtResult;
					if (wtResult.hasChanges && wtResult.branch) {
						// With a caller-supplied cwd the branch lives in THAT repo, not the
						// parent session's — say so, or the orchestrator merges in the wrong repo.
						const repoNote =
							customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
						record.result =
							(record.result ?? "") +
							`\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
					}
				}

				// Managed-worktree agents do not auto-release the worktree — the host
				// owns the lifecycle and decides when to drop the slot (e.g. once the
				// orchestrator's audit + merge step has captured the changes). The
				// lease, however, MUST be released when the spawn's promise settles
				// so a retry can re-acquire it. Without this, a doomed spawn would
				// hold the lock until process exit.
				if (managedWorktreeLeaseToken && managedWorktreeHandoff) {
					try {
						releaseManagedWorktreeLease({
							token: managedWorktreeLeaseToken,
							dag: managedWorktreeHandoff.dag_id,
							worktree: managedWorktreeHandoff.worktree_id,
						});
					} catch {
						/* ignore — best effort */
					}
					managedWorktreeLeaseToken = undefined;
					// Keep `record.managedWorktree` populated so downstream tools see
					// the handoff even after the lease is gone. The host can call
					// `releaseManagedWorktree` separately to drop the worktree on disk.
				}

				// Fire onComplete for foreground agents too — lifecycle symmetry.
				// Mark resultConsumed so the callback skips notifications (result returned inline).
				if (!options.isBackground) {
					record.resultConsumed = true;
					try {
						this.onComplete?.(record);
					} catch {
						/* ignore completion side-effect errors */
					}
				} else {
					this.runningBackground--;
					try {
						this.onComplete?.(record);
					} catch {
						/* ignore completion side-effect errors */
					}
					this.drainQueue();
				}
				return responseText;
			})
			.catch((err) => {
				// Don't overwrite status if externally stopped via abort()
				if (record.status !== "stopped") {
					record.status = "error";
				}
				record.error = err instanceof Error ? err.message : String(err);
				record.completedAt ??= Date.now();

				detach();

				// Final flush of streaming output file on error
				if (record.outputCleanup) {
					try {
						record.outputCleanup();
					} catch {
						/* ignore */
					}
					record.outputCleanup = undefined;
				}

				// Best-effort worktree cleanup on error
				if (record.worktree) {
					try {
						const wtResult = cleanupWorktree(
							baseCwd,
							record.worktree,
							options.description,
						);
						record.worktreeResult = wtResult;
					} catch {
						/* ignore cleanup errors */
					}
				}

				// Release the managed-worktree lease on error so the slot is
				// acquirable by a retry. Worktree on disk is left alone — the host
				// decides whether to drop it through `releaseManagedWorktree`.
				if (managedWorktreeLeaseToken && managedWorktreeHandoff) {
					try {
						releaseManagedWorktreeLease({
							token: managedWorktreeLeaseToken,
							dag: managedWorktreeHandoff.dag_id,
							worktree: managedWorktreeHandoff.worktree_id,
						});
					} catch {
						/* ignore — best effort */
					}
					managedWorktreeLeaseToken = undefined;
				}

				// Fire onComplete for foreground agents too — lifecycle symmetry.
				// Mark resultConsumed so the callback skips notifications (result returned inline).
				if (!options.isBackground) {
					record.resultConsumed = true;
					this.onComplete?.(record);
				} else {
					this.runningBackground--;
					this.onComplete?.(record);
					this.drainQueue();
				}
				return "";
			});

		record.promise = promise;

		// Notify caller that spawn is complete (record is in the map, promise is set).
		// Called synchronously — onSessionCreated fires asynchronously inside runAgent.
		// Used by spawnAndWait to let the caller set up output files before streaming starts.
		this.onSpawned?.(id);
	}

	/** Start queued agents up to the concurrency limit. */
	private drainQueue() {
		while (
			this.queue.length > 0 &&
			this.runningBackground < this.maxConcurrent
		) {
			const next = this.queue.shift()!;
			const record = this.agents.get(next.id);
			if (!record || record.status !== "queued") continue;
			try {
				this.startAgent(next.id, record, next.args);
			} catch (err) {
				// Late failure (e.g. strict worktree-isolation) — surface on the record
				// so the user/agent can see it via /agents, then keep draining.
				record.status = "error";
				record.error = err instanceof Error ? err.message : String(err);
				record.completedAt = Date.now();
				this.onComplete?.(record);
			}
		}
	}

	/**
	 * Called synchronously right after spawn, before onSessionCreated fires.
	 * Lets the caller set up the output file path on the record.
	 * The record is guaranteed to be in this.agents at this point.
	 */
	private onSpawned?: (id: string) => void;

	/**
	 * Spawn an agent and wait for completion (foreground use).
	 * Foreground agents bypass the concurrency queue.
	 * Returns { id, record } so callers can access the agent ID.
	 *
	 * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
	 *   Use this to set record.outputFile so streamToOutputFile can pick it up.
	 */
	async spawnAndWait(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		type: SubagentType,
		prompt: string,
		options: Omit<SpawnOptions, "isBackground">,
		onSpawned?: (id: string) => void,
	): Promise<{ id: string; record: AgentRecord }> {
		// Temporarily register the onSpawned hook so startAgent can call it.
		const prevOnSpawned = this.onSpawned;
		this.onSpawned = onSpawned;
		try {
			const id = this.spawn(pi, ctx, type, prompt, {
				...options,
				isBackground: false,
			});
			const record = this.agents.get(id)!;
			await record.promise;
			return { id, record };
		} finally {
			this.onSpawned = prevOnSpawned;
		}
	}

	/**
	 * Resume an existing agent session with a new prompt.
	 */
	async resume(
		id: string,
		prompt: string,
		signal?: AbortSignal,
	): Promise<AgentRecord | undefined> {
		const record = this.agents.get(id);
		if (!record?.session) return undefined;

		record.status = "running";
		record.startedAt = Date.now();
		record.completedAt = undefined;
		record.result = undefined;
		record.error = undefined;

		try {
			const { text, failure } = await resumeAgent(record.session, prompt, {
				onToolActivity: (activity) => {
					if (activity.type === "end") record.toolUses++;
				},
				onAssistantUsage: (usage) => {
					addUsage(record.lifetimeUsage, usage);
				},
				onCompaction: (info) => {
					record.compactionCount++;
					this.onCompact?.(record, info);
				},
				signal,
			});
			// Same contract as the spawn path (#144): a failed final turn is an
			// error, not a completion — but the resumed text stays available.
			record.status = failure ? "error" : "completed";
			if (failure) record.error = failure;
			record.result = text;
			record.completedAt = Date.now();
		} catch (err) {
			record.status = "error";
			record.error = err instanceof Error ? err.message : String(err);
			record.completedAt = Date.now();
		}

		return record;
	}

	/**
	 * Send a steering message to an agent from the UI (mirrors the steer_subagent
	 * tool). A live session delivers it now — it interrupts the agent after its
	 * current tool execution and appears as a user message. If the session isn't
	 * ready yet, the message is queued on `pendingSteers` and flushed when the
	 * session is created. Returns false if the agent can't accept steering
	 * (unknown id, or no longer running/queued).
	 */
	steer(id: string, message: string): boolean {
		const record = this.agents.get(id);
		if (!record) return false;
		if (record.status !== "running" && record.status !== "queued") return false;
		if (record.session) {
			record.session.steer(message).catch(() => {});
		} else {
			if (!record.pendingSteers) record.pendingSteers = [];
			record.pendingSteers.push(message);
		}
		return true;
	}

	getRecord(id: string): AgentRecord | undefined {
		return this.agents.get(id);
	}

	listAgents(): AgentRecord[] {
		return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	abort(id: string): boolean {
		const record = this.agents.get(id);
		if (!record) return false;

		// Remove from queue if queued
		if (record.status === "queued") {
			this.queue = this.queue.filter((q) => q.id !== id);
			record.status = "stopped";
			this.noteFinishOnce(record);
			record.completedAt = Date.now();
			return true;
		}

		if (record.status !== "running") return false;
		record.abortController?.abort();
		record.status = "stopped";
		this.noteFinishOnce(record);
		record.completedAt = Date.now();
		return true;
	}

	/**
	 * Host-owned managed-worktree release path.
	 *
	 * Removes the on-disk worktree, deletes the `.pi-worktree.json` marker,
	 * and — when `deleteBranch: true` is explicitly requested — also deletes
	 * the `sages/<dag>/<worktree>` branch. Path containment is enforced: the
	 * supplied path (or the path computed from the identity) MUST live under
	 * `<repoRoot>/.pi/worktree/`; anything else is refused.
	 *
	 * Two call shapes are accepted:
	 *
	 *   - By identity:
	 *       manager.releaseManagedWorktree({ repoRoot, dag_id, task_id,
	 *         worktree_id?, deleteBranch? })
	 *
	 *   - By explicit path (when the caller has it):
	 *       manager.releaseManagedWorktree({ repoRoot, path, deleteBranch? })
	 *
	 * Concurrent releases are tolerated: the helper is idempotent on a
	 * missing slot (returns `removed: false, reason: "missing"`).
	 */
	releaseManagedWorktree(
		args:
			| {
					repoRoot: string;
					dag_id: string;
					task_id: string;
					worktree_id?: string;
					deleteBranch?: boolean;
			  }
			| {
					repoRoot: string;
					path: string;
					deleteBranch?: boolean;
			  },
	): {
		path: string;
		branch: string;
		removed: boolean;
		branchDeleted: boolean;
		reason: string;
	} {
		if ("path" in args) {
			const res = deleteManagedWorktreeByPath({
				repoRoot: args.repoRoot,
				path: args.path,
				deleteBranch: args.deleteBranch,
			});
			return {
				path: res.path,
				branch: res.branch,
				removed: res.removed,
				branchDeleted: res.branchDeleted,
				reason: res.reason,
			};
		}
		const worktree_id = args.worktree_id ?? args.task_id;
		// Use the contract parser to normalize id fields BEFORE going through
		// the worktree-domain helpers — single identity-validation surface.
		parseManagedWorktreeRequest({
			dag_id: args.dag_id,
			task_id: args.task_id,
			worktree_id: args.worktree_id,
			mode: "create",
		});
		const res = deleteManagedWorktree({
			repoRoot: args.repoRoot,
			dag: args.dag_id,
			worktree: worktree_id,
			deleteBranch: args.deleteBranch,
		});
		return {
			path: res.path,
			branch: res.branch,
			removed: res.removed,
			branchDeleted: res.branchDeleted,
			reason: res.reason,
		};
	}

	/** Dispose a record's session and remove it from the map. */
	private removeRecord(id: string, record: AgentRecord): void {
		record.session?.dispose?.();
		record.session = undefined;
		this.agents.delete(id);
	}

	private cleanup() {
		// GC-2026-020 instrumentation: cleanup runs once a minute per
		// AgentManager; in a multi-pi-instance scenario this is fan-out
		// CPU if the cleanup body itself becomes expensive.
		profileInc("agent_manager_cleanup_tick");
		const cutoff = Date.now() - 10 * 60_000;
		for (const [id, record] of this.agents) {
			if (record.status === "running" || record.status === "queued") continue;
			if ((record.completedAt ?? 0) >= cutoff) continue;
			this.removeRecord(id, record);
		}
	}

	/**
	 * Remove all completed/stopped/errored records immediately.
	 * Called on session start/switch so tasks from a prior session don't persist.
	 * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
	 * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
	 */
	clearCompleted(skipUnconsumed = false): void {
		for (const [id, record] of this.agents) {
			if (record.status === "running" || record.status === "queued") continue;
			if (skipUnconsumed && !record.resultConsumed) continue;
			this.removeRecord(id, record);
		}
	}

	/** Whether any agents are still running or queued. */
	hasRunning(): boolean {
		return [...this.agents.values()].some(
			(r) => r.status === "running" || r.status === "queued",
		);
	}

	/** Abort all running and queued agents immediately. */
	abortAll(): number {
		let count = 0;
		// Clear queued agents first
		for (const queued of this.queue) {
			const record = this.agents.get(queued.id);
			if (record) {
				record.status = "stopped";
				this.noteFinishOnce(record);
				record.completedAt = Date.now();
				count++;
			}
		}
		this.queue = [];
		// Abort running agents
		for (const record of this.agents.values()) {
			if (record.status === "running") {
				record.abortController?.abort();
				record.status = "stopped";
				this.noteFinishOnce(record);
				record.completedAt = Date.now();
				count++;
			}
		}
		return count;
	}

	/** Wait for all running and queued agents to complete (including queued ones). */
	async waitForAll(): Promise<void> {
		// Loop because drainQueue respects the concurrency limit — as running
		// agents finish they start queued ones, which need awaiting too.
		while (true) {
			this.drainQueue();
			const pending = [...this.agents.values()]
				.filter((r) => r.status === "running" || r.status === "queued")
				.map((r) => r.promise)
				.filter(Boolean);
			if (pending.length === 0) break;
			await Promise.allSettled(pending);
		}
	}

	dispose() {
		clearInterval(this.cleanupInterval);
		// Clear queue
		this.queue = [];
		for (const record of this.agents.values()) {
			record.session?.dispose();
		}
		this.agents.clear();
		// Prune any orphaned git worktrees (crash recovery)
		try {
			pruneWorktrees(process.cwd());
		} catch {
			/* ignore */
		}
		// Also prune repos that caller-supplied cwds created worktrees in — a clean
		// exit with in-flight agents would otherwise leave stale registrations there.
		for (const repo of this.worktreeRepos) {
			try {
				pruneWorktrees(repo);
			} catch {
				/* ignore */
			}
		}
	}
}

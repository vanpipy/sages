/**
 * phase-widget.ts — pi-orchestrator's phase plan widget (GC-2026-phase-widget).
 *
 * The widget surfaces the workflow plan as a phase tree (Implement /
 * Review × N / Merge + dynamic Fix phases). It is the "planning state"
 * surface for pi-orchestrator — the third state layer alongside
 * pi-tasks's TaskWidget (task state) and pi-subagents's AgentWidget
 * (sub-agent execution state).
 *
 * Architecture (per design audit 2026-10-05):
 *   - Option B (primary data path): query pi-tasks's TaskStore via the
 *     `tasks:rpc:list-by-metadata` RPC, filtered by
 *     `metadata.workflow_run_goal_id`. Single source of truth: TaskStore.
 *   - Option C (refresh triggers): subscribe to workflow:start /
 *     workflow:phase-complete / subagents:completed / subagents:failed
 *     events; on each event, re-query via RPC and re-render.
 *
 * The widget is read-only: it does NOT call TaskCreate, does NOT mutate
 * TaskStore, does NOT own any data. It is a pure consumer of
 * (plan shape derived from workflow:start payload, task list queried
 * from pi-tasks via RPC, refresh triggered by workflow events).
 *
 * Pair-programming advisors (MergerAdvisor / future DeveloperAdvisor /
 * ReviewerAdvisor / FixAdvisor) will show up here as additional task
 * rows under their parent phase — no widget change needed; the existing
 * `metadata.advisorAgentType` (planned for GC-Y) will be enough to
 * group primary + advisor rows together.
 */

export interface PhaseWidgetBus {
  on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
  emit(channel: string, data: unknown): void;
}

/**
 * Minimal task surface — the fields the widget reads. Matches the shape
 * pi-tasks's TaskStore serializes (id / subject / status / blockedBy /
 * metadata), narrowed to what render() needs. We import only the type,
 * not the TaskStore, to keep the widget independent of pi-tasks's
 * internals.
 */
export interface TaskSummary {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: string[];
  owner?: string;
  metadata: Record<string, unknown>;
}

export interface PhaseWidgetDeps {
  bus: PhaseWidgetBus;
}

/**
 * One entry in the computed phase plan. Built from workflow:start payload
 * (`max_fix_iterations` + `max_redesigns`); iteration 0 means "not
 * iteration-counted" (Implement / Merge); Fix phases are NOT in the
 * static plan — they appear only after a Review emits NEEDS_WORK and the
 * workflow handler dispatches a Fix task dynamically.
 */
export interface PhasePlanEntry {
  key: "implement" | "review" | "fix" | "merge";
  label: string;
  iteration: number;
}

/**
 * Pure phase plan computation. Throws on invalid input — the workflow_run
 * contract requires max_fix_iterations >= 1 (see workflow-graph.ts:282).
 */
export function computePhasePlan(input: {
  max_fix_iterations: number;
  max_redesigns: number;
}): PhasePlanEntry[] {
  if (!Number.isInteger(input.max_fix_iterations) || input.max_fix_iterations < 1) {
    throw new Error(
      `computePhasePlan: max_fix_iterations must be a positive integer, got ${input.max_fix_iterations}`,
    );
  }
  const plan: PhasePlanEntry[] = [
    { key: "implement", label: "Implement", iteration: 0 },
  ];
  for (let i = 1; i <= input.max_fix_iterations; i++) {
    plan.push({ key: "review", label: `Review ${i}`, iteration: i });
  }
  plan.push({ key: "merge", label: "Merge", iteration: 0 });
  return plan;
}

export interface PhaseGroup {
  key: PhasePlanEntry["key"] | string;
  label: string;
  iteration: number;
  /** Tasks under this phase group, in store order (preserves creation order). */
  tasks: TaskSummary[];
}

/**
 * Group tasks by phase. The grouping is data-driven (no static plan
 * lookup) so dynamic Fix phases appear naturally. Order: insertion
 * order from the TaskStore list result (which is what TaskList shows).
 */
export function groupTasksByPhase(tasks: TaskSummary[]): PhaseGroup[] {
  const order: PhaseGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const t of tasks) {
    const phase = String(t.metadata?.phase ?? "unknown");
    const iteration = Number(t.metadata?.iteration ?? 0);
    const key = `${phase}#${iteration}`;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = order.length;
      indexByKey.set(key, idx);
      const label =
        phase === "review"
          ? `Review ${iteration}`
          : phase === "fix"
            ? `Fix ${iteration}`
            : phase.charAt(0).toUpperCase() + phase.slice(1);
      order.push({ key: phase, label, iteration, tasks: [] });
    }
    order[idx].tasks.push(t);
  }
  return order;
}

// GC-2026-099 R1: import the canonical WorkflowStartPayload from
// pi-tasks rather than redeclaring it. The prior local copy could
// drift from pi-tasks/src/workflow-handler.ts:50 silently — neither
// typecheck nor tests would catch a contract change. Importing the
// source-of-truth type means the widget rebuild fails loudly when
// pi-tasks adds / removes / renames a field.
import type { WorkflowStartPayload } from "@sages/pi-tasks/workflow-handler";

interface PhaseWidgetState {
  goalId: string | undefined;
  workflowId: string | undefined;
  goalTitle: string | undefined;
  maxFixIterations: number | undefined;
  phasePlan: PhasePlanEntry[];
  tasksByPhase: Map<string, TaskSummary[]>;
  lastRefreshAt: number | undefined;
}

const EMPTY_STATE: PhaseWidgetState = {
  goalId: undefined,
  workflowId: undefined,
  goalTitle: undefined,
  maxFixIterations: undefined,
  phasePlan: [],
  tasksByPhase: new Map(),
  lastRefreshAt: undefined,
};

/** Glyphs reused from TaskWidget's vocabulary — same visual semantics. */
const GLYPHS = {
  header: "Workflow Plan",
  pending: "☐",
  inProgress: "▷",
  completed: "✓",
};

export class PhaseWidget {
  private state: PhaseWidgetState = {
    goalId: undefined,
    workflowId: undefined,
    goalTitle: undefined,
    maxFixIterations: undefined,
    phasePlan: [],
    tasksByPhase: new Map(),
    lastRefreshAt: undefined,
  };
  private attached = false;

  constructor(private readonly deps: PhaseWidgetDeps) {}

  /** Subscribe to workflow + subagent events. Idempotent — second call no-ops. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    this.deps.bus.on("workflow:start", (data) => {
      const payload = data as WorkflowStartPayload;
      this.state = {
        ...EMPTY_STATE,
        goalId: payload.goal_id,
        workflowId: payload.workflow_id,
        goalTitle: payload.goal?.title,
        maxFixIterations: payload.max_fix_iterations,
        phasePlan: computePhasePlan({
          max_fix_iterations: payload.max_fix_iterations,
          max_redesigns: payload.max_redesigns ?? 1,
        }),
        tasksByPhase: new Map(),
      };
      // Refresh immediately so the widget shows the (initially empty)
      // task list right after workflow:start fires.
      void this.refreshTasks();
    });

    this.deps.bus.on("workflow:phase-complete", () => {
      void this.refreshTasks();
    });
    this.deps.bus.on("subagents:completed", () => {
      void this.refreshTasks();
    });
    this.deps.bus.on("subagents:failed", () => {
      void this.refreshTasks();
    });
  }

  /** Read-only state accessor — tests + UI consumers both use this. */
  getState(): Readonly<PhaseWidgetState> {
    return this.state;
  }

  /**
   * Query pi-tasks via RPC for tasks under the current workflow goal.
   * Updates state.tasksByPhase and returns the flat task list.
   */
  private async refreshTasks(): Promise<void> {
    const goalId = this.state.goalId;
    if (!goalId) return;

    const tasks = await this.rpcListByMetadata("workflow_run_goal_id", goalId);
    const groups = groupTasksByPhase(tasks);
    const map = new Map<string, TaskSummary[]>();
    for (const g of groups) {
      map.set(g.key, g.tasks);
    }
    this.state = {
      ...this.state,
      tasksByPhase: map,
      lastRefreshAt: Date.now(),
    };
  }

  /**
   * Promise wrapper around the requestId-envelope RPC pattern used by
   * pi-subagents. The bus emits the request and listens for the reply
   * on `tasks:rpc:list-by-metadata:reply:<requestId>`.
   */
  private rpcListByMetadata(key: string, value: unknown): Promise<TaskSummary[]> {
    return new Promise((resolve, reject) => {
      const requestId = `phase-widget-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const replyChannel = `tasks:rpc:list-by-metadata:reply:${requestId}`;
      const unsub = this.deps.bus.on(replyChannel, (raw: unknown) => {
        unsub();
        const reply = raw as { success: boolean; data?: unknown; error?: string };
        if (reply.success) resolve((reply.data ?? []) as TaskSummary[]);
        else reject(new Error(reply.error ?? "rpc failed"));
      });
      this.deps.bus.emit("tasks:rpc:list-by-metadata", { requestId, key, value });
    });
  }

  /**
   * Render the widget as an array of lines. The host's widget framework
   * joins these into the TUI panel above the editor.
   *
   * Layout:
   *   Workflow Plan: <goal_id> — <title>
   *   Plan: Implement → Review 1 → Review 2 → ... → Merge (max_fix=N)
   *   [phase section, indented]
   *     ☐/▷/✓ <task subject>  (agent <id-prefix>)
   *   Progress: N/M phases complete
   *
   * When no workflow is active, returns a single empty-state line.
   */
  render(): string[] {
    if (!this.state.goalId) {
      return ["Workflow Plan: (no active workflow)"];
    }

    const lines: string[] = [];
    const titleSuffix = this.state.goalTitle ? ` — ${this.state.goalTitle}` : "";
    lines.push(`Workflow Plan: ${this.state.goalId}${titleSuffix}`);
    if (this.state.maxFixIterations !== undefined) {
      const planLabels = this.state.phasePlan.map((p) => p.label).join(" → ");
      lines.push(`Plan: ${planLabels} (max_fix_iterations=${this.state.maxFixIterations})`);
    }

    // Render each phase group. Two-pass: first the static plan entries,
    // then any dynamic phases (Fix that appeared).
    const planKeySet = new Set(
      this.state.phasePlan.map((p) => `${p.key}#${p.iteration}`),
    );
    const staticGroups: PhaseGroup[] = this.state.phasePlan.map((p) => {
      const tasks = this.state.tasksByPhase.get(p.key) ?? [];
      const filtered = tasks.filter((t) => Number(t.metadata?.iteration ?? 0) === p.iteration);
      return { key: p.key, label: p.label, iteration: p.iteration, tasks: filtered };
    });
    const dynamicGroups = groupTasksByPhase(
      Array.from(this.state.tasksByPhase.values()).flat().filter((t) => {
        const phase = String(t.metadata?.phase ?? "");
        const iter = Number(t.metadata?.iteration ?? 0);
        return !planKeySet.has(`${phase}#${iter}`);
      }),
    );

    for (const g of [...staticGroups, ...dynamicGroups]) {
      lines.push(this.renderGroupHeader(g));
      // GC-2026-advisor-pairs: when a phase group contains both a primary
      // task and an advisor task, render the advisor as a paired sub-row
      // (indented one more level + "advisor:" prefix) so the user can see
      // the pair structure at a glance.
      const sorted = this.sortPrimaryAdvisor(g.tasks);
      for (const t of sorted) {
        lines.push(this.renderTaskRow(t));
      }
    }

    const completedPhases = staticGroups.filter((g) =>
      g.tasks.every((t) => t.status === "completed"),
    ).length;
    lines.push(
      `Progress: ${completedPhases}/${staticGroups.length} planned phases complete`,
    );
    if (this.state.lastRefreshAt !== undefined) {
      lines.push(`(refreshed at ${new Date(this.state.lastRefreshAt).toISOString()})`);
    }
    return lines;
  }

  private renderGroupHeader(g: PhaseGroup): string {
    return `  [${g.label}]`;
  }

  private renderTaskRow(t: TaskSummary): string {
    const glyph =
      t.status === "completed"
        ? GLYPHS.completed
        : t.status === "in_progress"
          ? GLYPHS.inProgress
          : GLYPHS.pending;
    const owner = t.owner ? ` (agent ${t.owner.slice(0, 8)})` : "";
    // GC-2026-advisor-pairs: advisor tasks get an indent + "advisor" prefix
    // so the user can see they're the second half of a pair.
    const isAdvisor = typeof t.metadata?.advisorOf === "string";
    const prefix = isAdvisor ? "      " : "    ";
    const subject = isAdvisor ? t.subject.replace(/^Advisor:\s*/, "advisor: ") : t.subject;
    return `${prefix}${glyph} ${subject}${owner}`;
  }

  /**
   * GC-2026-advisor-pairs: order tasks within a phase group so the
   * primary task appears before its advisor. The pair is rendered
   * contiguously (primary immediately above advisor) so the user
   * sees the pair visually grouped.
   */
  private sortPrimaryAdvisor(tasks: TaskSummary[]): TaskSummary[] {
    return [...tasks].sort((a, b) => {
      const aIsAdvisor = typeof a.metadata?.advisorOf === "string";
      const bIsAdvisor = typeof b.metadata?.advisorOf === "string";
      if (aIsAdvisor === bIsAdvisor) return 0;
      // Non-advisor (primary) comes first.
      return aIsAdvisor ? 1 : -1;
    });
  }
}

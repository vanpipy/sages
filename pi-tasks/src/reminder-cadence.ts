/**
 * Pure cadence logic for the system-reminder injection.
 *
 * Decisions are made here as plain functions so they're easy to unit-test
 * without spinning up the whole extension. The default export of the
 * extension wires these into the `tool_result` and `context` hooks.
 */

/** Internal cadence state. Plain object so it round-trips through tests. */
export interface CadenceState {
  currentTurn: number;
  lastTaskToolUseTurn: number;
  reminderInjectedThisCycle: boolean;
  reminderDue: boolean;
  /**
   * Turn on which a wake-up was last scheduled. Lets the wake-up decision
   * debounce across consecutive turn_ends — firing every turn would race the
   * LLM, which would just see a fresh "you have unfinished work" message on
   * top of the one it just acted on.
   *
   * `-1` means "never fired", so the first eligible turn_end always wakes up.
   * Lives on `CadenceState` so it survives the same reset points (session
   * switch) that reset the reminder cadence.
   */
  lastWakeUpTurn: number;
}

export interface CadenceConfig {
  /** Turns without a task-tool call before a reminder is considered due. */
  reminderInterval: number;
  /** Set of tool names that count as "task tool usage" and reset cadence. */
  taskToolNames: ReadonlySet<string>;
}

export function createCadenceState(): CadenceState {
  return {
    currentTurn: 0,
    lastTaskToolUseTurn: 0,
    reminderInjectedThisCycle: false,
    reminderDue: false,
    lastWakeUpTurn: -1,
  };
}

export function resetCadenceState(state: CadenceState): void {
  state.currentTurn = 0;
  state.lastTaskToolUseTurn = 0;
  state.reminderInjectedThisCycle = false;
  state.reminderDue = false;
  state.lastWakeUpTurn = -1;
}

/** Increment the turn counter at `turn_start`. */
export function onTurnStart(state: CadenceState): void {
  state.currentTurn++;
}

export interface ToolResultDecision {
  /** True when caller should mark `reminderDue` for the next `context` event. */
  markDue: boolean;
}

/**
 * Decide what cadence change a tool_result implies. Mutates `state` in place
 * (resets the timer when a task tool was used) and returns whether the
 * reminder should be queued for the next LLM call.
 */
export function evaluateToolResult(
  state: CadenceState,
  toolName: string,
  hasTasks: boolean,
  config: CadenceConfig,
): ToolResultDecision {
  // Task tool usage resets cadence and clears any pending reminder.
  if (config.taskToolNames.has(toolName)) {
    state.lastTaskToolUseTurn = state.currentTurn;
    state.reminderInjectedThisCycle = false;
    state.reminderDue = false;
    return { markDue: false };
  }

  // Cheap guards first.
  if (state.currentTurn - state.lastTaskToolUseTurn < config.reminderInterval) {
    return { markDue: false };
  }
  if (state.reminderInjectedThisCycle) return { markDue: false };
  if (!hasTasks) return { markDue: false };

  state.reminderDue = true;
  return { markDue: true };
}

/**
 * Drain the pending reminder when `context` fires. Returns true if the
 * caller should inject the reminder into the upcoming LLM call's messages.
 */
export function drainReminderForContext(state: CadenceState): boolean {
  if (!state.reminderDue) return false;
  state.reminderDue = false;
  state.reminderInjectedThisCycle = true;
  state.lastTaskToolUseTurn = state.currentTurn;
  return true;
}

export interface IdleWakeUpDecision {
  /** True when caller should schedule a wake-up message after a debounce. */
  shouldWakeUp: boolean;
}

/**
 * Decide whether to schedule an idle wake-up. The reminder cadence already
 * injects a system-reminder into the NEXT LLM call — but if the LLM went
 * idle (`end_turn`, no tool calls), there is no next call, so the reminder
 * sits in `reminderDue = true` forever. The wake-up path re-engages the LLM
 * itself by sending a follow-up user message via the host.
 *
 * The wake-up MUST be debounced: a wake-up that fires every turn would race
 * the LLM's response, double the cost, and never let the LLM settle. The
 * debounce key is `state.lastWakeUpTurn` — separated by at least
 * `wakeUpDebounceTurns` turns from the last wake-up.
 *
 * The decision is pure: callers feed in the observed task list shape. The
 * in_progress-vs-pending split matters because in_progress work is what a
 * subagent is *running*, and the subagent's completion will fire its own
 * wake-up; pending work is what the orchestrator still owes a manual dispatch
 * for.
 */
export function shouldFireIdleWakeUp(
  state: CadenceState,
  hasInProgress: boolean,
  hasReadyPending: boolean,
  config: { wakeUpDebounceTurns: number },
): IdleWakeUpDecision {
  // Nothing to re-engage for.
  if (!hasInProgress && !hasReadyPending) return { shouldWakeUp: false };

  // Never fired before — always eligible.
  if (state.lastWakeUpTurn < 0) return { shouldWakeUp: true };

  // Already woke up recently — let the LLM act on the prior wake-up first.
  if (state.currentTurn - state.lastWakeUpTurn < config.wakeUpDebounceTurns) {
    return { shouldWakeUp: false };
  }

  return { shouldWakeUp: true };
}

/** Record that a wake-up was scheduled for the current turn. Mutates `state`. */
export function markWakeUpScheduled(state: CadenceState): void {
  state.lastWakeUpTurn = state.currentTurn;
}

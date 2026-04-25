/**
 * Workflow State Utilities
 * Handles loading, saving, and transitioning workflow state
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { WorkflowState, Phase } from "../types.js";

const DEFAULT_STATE: WorkflowState = {
  planName: "",
  status: "idle",
  hasDraft: false,
  hasPlan: false,
  hasExecution: false,
  completedTasks: 0,
  totalTasks: 0,
};

/**
 * Load workflow state from a JSON file
 * Returns default state if file doesn't exist
 * Throws error if file contains corrupted JSON
 */
export function loadWorkflowState(stateFile: string): WorkflowState {
  try {
    const content = readFileSync(stateFile, "utf-8");
    return JSON.parse(content) as WorkflowState;
  } catch (error) {
    // Only return default for file-not-found; re-throw on corruption
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ...DEFAULT_STATE };
    }
    throw error;
  }
}

/**
 * Save workflow state to a JSON file
 * Creates directory if it doesn't exist
 */
export function saveWorkflowState(state: WorkflowState, stateFile: string): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Transition to a new phase
 * Returns a new state object (immutable)
 */
export function transitionPhase(state: WorkflowState, newPhase: Phase): WorkflowState {
  return {
    ...state,
    currentPhase: newPhase.name,
  };
}
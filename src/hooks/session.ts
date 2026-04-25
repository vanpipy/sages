/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Sages Plugin - Session Hook 🜄                                        ║
 * ║                                                                           ║
 * ║   Session lifecycle management for Fuxi compaction prevention            ║
 * ║   Handles session creation, recovery, and state persistence              ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import type {
  SessionState,
  SessionPersistence,
  PluginContext,
  ToolResult,
} from "../types.js";
import {
  loadSessions,
  saveSessions,
  getActiveSession,
  updateSession,
  clearSession,
  logSages,
  logError,
  success,
  error,
} from "../utils.js";

// =============================================================================
// Session Lifecycle
// =============================================================================

/**
 * Create a new session or return existing one
 */
export function createSession(
  projectPath: string,
  agentName: string = "fuxi",
  taskDescription?: string,
): ToolResult<SessionState> {
  try {
    const now = new Date().toISOString();
    const sessionId = `sages-${Date.now()}`;

    const session: SessionState = {
      id: sessionId,
      projectPath,
      agentName,
      initializedAt: now,
      lastActivityAt: now,
      currentPlanName: undefined,
      draftPath: undefined,
      planPath: undefined,
      executionPath: undefined,
      status: "initialized",
    };

    updateSession(projectPath, session);
    logSages("session_created", { sessionId, agentName, taskDescription });

    return success(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("session_create_failed", { error: msg });
    return error(msg, "SESSION_CREATE_FAILED");
  }
}

/**
 * Get the active session for the project
 */
export function getSession(projectPath: string): ToolResult<SessionState | null> {
  try {
    const session = getActiveSession(projectPath);
    return success(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("session_get_failed", { error: msg });
    return error(msg, "SESSION_GET_FAILED");
  }
}

/**
 * Update session state (draft created, plan approved, etc.)
 */
export function updateSessionStatus(
  projectPath: string,
  updates: Partial<SessionState>,
): ToolResult<SessionState> {
  try {
    const existing = getActiveSession(projectPath);
    if (!existing) {
      return error("No active session", "NO_ACTIVE_SESSION");
    }

    const updated: SessionState = {
      ...existing,
      ...updates,
      lastActivityAt: new Date().toISOString(),
    };

    // Auto-update status based on fields
    if (updates.draftPath && !updates.status) {
      updated.status = "draft_created";
    }
    if (updates.planPath && !updates.status) {
      updated.status = "plan_approved";
    }
    if (updates.executionPath && !updates.status) {
      updated.status = "execution_in_progress";
    }

    updateSession(projectPath, updated);
    logSages("session_status_updated", { sessionId: updated.id, status: updated.status });

    return success(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("session_update_failed", { error: msg });
    return error(msg, "SESSION_UPDATE_FAILED");
  }
}

/**
 * End the current session
 */
export function endSession(projectPath: string): ToolResult<{ ended: boolean }> {
  try {
    const session = getActiveSession(projectPath);
    if (!session) {
      return success({ ended: false });
    }

    clearSession(projectPath, session.id);
    logSages("session_ended", { sessionId: session.id });

    return success({ ended: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("session_end_failed", { error: msg });
    return error(msg, "SESSION_END_FAILED");
  }
}

/**
 * Check for stale sessions and clean up
 */
export function cleanupStaleSessions(projectPath: string, maxAgeMs: number = 24 * 60 * 60 * 1000): ToolResult<{ cleaned: number }> {
  try {
    const persistence = loadSessions(projectPath);
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of Object.entries(persistence.sessions)) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > maxAgeMs) {
        delete persistence.sessions[id];
        cleaned++;
        logSages("stale_session_cleaned", { sessionId: id });
      }
    }

    if (cleaned > 0) {
      saveSessions(projectPath, persistence);
    }

    return success({ cleaned });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("session_cleanup_failed", { error: msg });
    return error(msg, "SESSION_CLEANUP_FAILED");
  }
}

// =============================================================================
// Session Recovery (For Fuxi Context Restoration)
// =============================================================================

/**
 * Get session history for context restoration
 */
export function getSessionHistory(
  projectPath: string,
  limit: number = 10,
): ToolResult<SessionState[]> {
  try {
    const persistence = loadSessions(projectPath);
    const sessions = Object.values(persistence.sessions)
      .sort((a, b) => new Date(b.initializedAt).getTime() - new Date(a.initializedAt).getTime())
      .slice(0, limit);

    return success(sessions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return error(msg, "SESSION_HISTORY_FAILED");
  }
}

/**
 * Restore a specific session as active
 */
export function restoreSession(
  projectPath: string,
  sessionId: string,
): ToolResult<SessionState> {
  try {
    const persistence = loadSessions(projectPath);
    const session = persistence.sessions[sessionId];

    if (!session) {
      return error(`Session not found: ${sessionId}`, "SESSION_NOT_FOUND");
    }

    // Set as active
    persistence.activeSessionId = sessionId;
    session.lastActivityAt = new Date().toISOString();
    saveSessions(projectPath, persistence);

    logSages("session_restored", { sessionId });
    return success(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return error(msg, "SESSION_RESTORE_FAILED");
  }
}

// =============================================================================
// Session State Machine
// =============================================================================

/**
 * Valid state transitions for session lifecycle
 */
const VALID_TRANSITIONS: Record<SessionState["status"], SessionState["status"][]> = {
  initialized: ["draft_created"],
  draft_created: ["plan_approved", "failed"],
  plan_approved: ["execution_in_progress", "failed"],
  execution_in_progress: ["review_pending", "completed", "failed"],
  review_pending: ["completed", "failed"],
  completed: [],
  failed: [],
};

/**
 * Validate and transition session state
 */
export function transitionSession(
  projectPath: string,
  newStatus: SessionState["status"],
): ToolResult<SessionState> {
  try {
    const session = getActiveSession(projectPath);
    if (!session) {
      return error("No active session", "NO_ACTIVE_SESSION");
    }

    const validNextStates = VALID_TRANSITIONS[session.status] || [];
    if (!validNextStates.includes(newStatus)) {
      return error(
        `Invalid transition: ${session.status} -> ${newStatus}`,
        "INVALID_TRANSITION",
        { current: session.status, attempted: newStatus, valid: validNextStates },
      );
    }

    return updateSessionStatus(projectPath, { status: newStatus });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return error(msg, "TRANSITION_FAILED");
  }
}
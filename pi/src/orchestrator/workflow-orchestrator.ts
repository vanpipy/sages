/**
 * Workflow Orchestrator - Handles automated workflow progression
 * Auto-proceeds through valid phases (except plan approval)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StateManager } from "../state/state-manager.js";

export type Phase = "idle" | "design" | "review" | "plan" | "execute" | "audit" | "complete";

export interface OrchestratorConfig {
  autoProceed: boolean;
  autoProceedAfterReview: boolean; // Auto after qiaochui_review if valid
  requirePlanApproval: boolean; // Always require approval before execute
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  autoProceed: true,
  autoProceedAfterReview: true,
  requirePlanApproval: true,
};

export class WorkflowOrchestrator {
  private pi: ExtensionAPI;
  private stateManager: StateManager;
  private config: OrchestratorConfig;
  private planApproved: boolean = false;

  constructor(pi: ExtensionAPI, stateManager: StateManager, config?: Partial<OrchestratorConfig>) {
    this.pi = pi;
    this.stateManager = stateManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate steer message for Design phase
   */
  generateDesignPhaseMessage(request: string, planName: string): string {
    return `**Phase 1 - Design (Fuxi) **

Create the architectural design for: "${request}"

1. Call \`fuxi-request\` to create draft.md

2. Present the draft for review

3. When ready, proceed to qiaochui-review`;
  }

  /**
   * Generate steer message for workflow recovery
   */
  generateRecoveryMessage(state: { phase: string; planName: string; request: string; tasks?: unknown[] }): string {
    const phaseEmoji: Record<string, string> = {
      design: "",
      review: "",
      plan: "📋",
      execute: "",
      audit: "",
      complete: "✅",
    };

    const phaseCommands: Record<string, string[]> = {
      design: ["fuxi-request - create draft", "fuxi-get-status - check state"],
      review: ["qiaochui-review - review draft", "qiaochui-decompose - decompose"],
      plan: ["fuxi-plan <score> - proceed", "fuxi-get-status - check state"],
      execute: ["luban-execute-all - run tasks", "luban-get-status - view progress"],
      audit: ["gaoyao-review - audit quality", "gaoyao-check-security - scan security"],
      complete: ["fuxi-end - archive workflow"],
    };

    const emoji = phaseEmoji[state.phase] || "⏸️";
    const taskCount = state.tasks?.length || 0;
    const validCommands = phaseCommands[state.phase] || [];

    let message = `**Workflow Recovered** ♻️\n\n`;
    message += `**Plan:** ${state.planName}\n`;
    message += `**Request:** ${state.request}\n`;
    message += `**Resuming at:** ${emoji} ${state.phase}`;
    
    if (taskCount > 0) {
      message += `\n**Tasks:** ${taskCount} task(s) in plan`;
    }

    if (validCommands.length > 0) {
      message += `\n\n**Available:** ${validCommands.join(" | ")}`;
    }

    return message;
  }

  /**
   * Generate steer message for Review phase (auto-proceed if valid)
   */
  generateReviewPhaseMessage(draftPath: string): string {
    if (this.config.autoProceedAfterReview) {
      return `**Phase 2 - Review (QiaoChui) **

1. Call \`qiaochui-review\` to review the draft at \`${draftPath}\`

2. If verdict is "APPROVED":
   - Call \`qiaochui-decompose\` to create the execution plan

3. If verdict is "REVISE":
   - Report what needs to be fixed
   - Wait for draft update
   - Re-review after update`;
    }

    return `**Phase 2 - Review (QiaoChui) **

1. Call \`qiaochui-review\` to review the draft

2. Present the review results

3. If approved, call \`qiaochui-decompose\``;
  }

  /**
   * Generate steer message for Plan phase (always requires approval)
   */
  generatePlanPhaseMessage(planPath: string): string {
    this.planApproved = false;

    return `**Phase 2.5 - Plan Review (Your Decision)**

📋 Execution plan created at: \`${planPath}\`

Review the plan and:
- **APPROVE**: Use \`fuxi-plan <score>\` to proceed (score > 80)
- **MODIFY**: Update the plan
- **REJECT**: Use \`fuxi-end\` to stop

The plan lists all tasks with dependencies.`;
  }

  /**
   * Generate steer message for Execute phase
   */
  generateExecutePhaseMessage(planPath: string): string {
    return `**Phase 3 - Execute (LuBan) **

Execute tasks from the plan: \`${planPath}\`

1. Call \`luban-execute-task\` for single task
2. Call \`luban-execute-all\` for all tasks
3. Use TDD: RED → GREEN → REFACTOR

Tasks will run in parallel when dependencies allow.

Run \`luban-execute-all\` to execute all tasks`;
  }

  /**
   * Generate steer message for Audit phase
   */
  generateAuditPhaseMessage(): string {
    return `**Phase 4 - Audit (GaoYao) **

1. Call \`gaoyao-review\` for quality audit (mode: "full")

2. Call \`gaoyao-check-security\` to scan for vulnerabilities

3. Present the final verdict:
   - **PASS**: All checks passed 🎉
   - **NEEDS_CHANGES**: Issues found, fix required
   - **REJECTED**: Fundamental problems

Use \`fuxi-end\` to archive when complete`;
  }

  /**
   * Generate completion message
   */
  generateCompletionMessage(): string {
    return `## 🎉 Four Sages Workflow Complete!

**Summary:**
- Design: ✅ Created
- Review: ✅ Approved  
- Plan: ✅ Approved
- Execution: ✅ Complete
- Audit: ✅ Passed

All phases completed successfully. The implementation is ready!

Use \`fuxi-start\` to start a new workflow, or \`fuxi-get-status\` to review this one.`;
  }

  /**
   * Handle automatic progression after valid review
   */
  shouldAutoProceedFromReview(reviewResult: { verdict: string }): boolean {
    return this.config.autoProceed && 
           this.config.autoProceedAfterReview && 
           reviewResult.verdict === "APPROVED";
  }

  /**
   * Check if plan approval is required
   */
  isPlanApprovalRequired(): boolean {
    return this.config.requirePlanApproval;
  }

  /**
   * Mark plan as approved
   */
  approvePlan(): void {
    this.planApproved = true;
  }

  /**
   * Check if plan is approved
   */
  isPlanApproved(): boolean {
    return this.planApproved;
  }

  /**
   * Update status display
   */
  updateStatus(phase: Phase, progress?: { completed: number; total: number }): void {
    const phaseLabels: Record<Phase, string> = {
      idle: "⏸️ Idle",
      design: " Design",
      review: " Review",
      plan: "📋 Plan",
      execute: " Execute",
      audit: " Audit",
      complete: "✅ Complete",
    };

    let status = phaseLabels[phase];
    if (progress) {
      status += ` (${progress.completed}/${progress.total})`;
    }

    // Note: UI updates handled by extension
  }

  /**
   * Show progress notification
   */
  showProgress(completed: number, total: number): void {
    const percentage = Math.round((completed / total) * 100);
    // Note: Notifications handled by extension
  }
}

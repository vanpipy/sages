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
    return `**Phase 1 - Design (Fuxi) ☰**

Create the architectural design for: "${request}"

1. Call \`fuxi_create_draft\` with:
   - name: "${planName}"
   - request: "${request}"

2. Present the draft to me for review

3. Say "DESIGN_COMPLETE" when ready for my approval`;
  }

  /**
   * Generate steer message for Review phase (auto-proceed if valid)
   */
  generateReviewPhaseMessage(draftPath: string): string {
    if (this.config.autoProceedAfterReview) {
      return `**Phase 2 - Review (QiaoChui) ☳**

1. Call \`qiaochui_review\` to review the draft at \`${draftPath}\`

2. If verdict is "APPROVED":
   - Call \`qiaochui_decompose\` to create the execution plan
   - Say "PLAN_READY" and present the plan

3. If verdict is "REVISE":
   - Tell me what needs to be fixed
   - Wait for me to update the draft
   - Re-review after update`;
    }

    return `**Phase 2 - Review (QiaoChui) ☳**

1. Call \`qiaochui_review\` to review the draft at \`${draftPath}\`

2. Present the review results to me

3. If I approve, call \`qiaochui_decompose\` and say "PLAN_READY"`;
  }

  /**
   * Generate steer message for Plan phase (always requires approval)
   */
  generatePlanPhaseMessage(planPath: string): string {
    this.planApproved = false;

    return `**Phase 2.5 - Plan Review (Your Decision)**

📋 Execution plan created at: \`${planPath}\`

Review the plan and:
- **APPROVE**: Say "/fuxi-approve" to proceed with execution
- **MODIFY**: Tell me what to change, then I'll update the plan
- **REJECT**: Say "/fuxi-reject" to stop

The plan lists all tasks with dependencies. I'll execute them in order.`;
  }

  /**
   * Generate steer message for Execute phase
   */
  generateExecutePhaseMessage(planPath: string): string {
    return `**Phase 3 - Execute (LuBan) ☴**

Execute tasks from the plan: \`${planPath}\`

For each task:
1. Call \`luban_execute_task\` with task details
2. Implement using TDD (RED → GREEN → REFACTOR)
3. Report progress

Tasks will run in parallel when dependencies allow.

Say "EXECUTION_COMPLETE" when all tasks are done`;
  }

  /**
   * Generate steer message for Audit phase
   */
  generateAuditPhaseMessage(): string {
    return `**Phase 4 - Audit (GaoYao) ☲**

1. Call \`gaoyao_review\` for quality audit (review_mode: "full")

2. Call \`gaoyao_check_security\` to scan for vulnerabilities

3. Present the final verdict:
   - **PASS**: All checks passed 🎉
   - **NEEDS_CHANGES**: Issues found, fix required
   - **REJECTED**: Fundamental problems

Say "AUDIT_COMPLETE" with the final verdict`;
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

Use \`/fuxi\` to start a new workflow, or \`/fuxi-status\` to review this one.`;
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
      design: "☰ Design",
      review: "☳ Review",
      plan: "📋 Plan",
      execute: "☴ Execute",
      audit: "☲ Audit",
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

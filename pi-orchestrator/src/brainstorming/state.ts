/**
 * Brainstorming State Machine
 * 
 * Manages the flow of a brainstorming session through phases:
 * exploring → clarifying → proposing → designing → approved/rejected
 */

import type {
  BrainstormPhase,
  BrainstormContext,
  BrainstormEvent,
  BrainstormResult,
  BrainstormMetrics,
  ProjectContext,
  IntentSpec,
  Approach,
  DesignSection,
  ClarifyingQuestion,
} from './types';

// ============================================================================
// Valid State Transitions
// ============================================================================

const VALID_TRANSITIONS: Record<BrainstormPhase, BrainstormPhase[]> = {
  exploring: ['clarifying', 'cancelled'],
  clarifying: ['proposing', 'exploring', 'cancelled'],
  proposing: ['designing', 'clarifying', 'cancelled'],
  designing: ['approved', 'clarifying', 'cancelled'],
  approved: ['cancelled'],  // Can cancel even after approval
  rejected: [],
  cancelled: [],
};

// ============================================================================
// State Machine Class
// ============================================================================

export class BrainstormStateMachine {
  private context: BrainstormContext;
  private startTime: Date;
  
  constructor(cwd: string, request?: string) {
    this.startTime = new Date();
    this.context = {
      cwd,
      request: request || '',
      phase: 'exploring',
      questionsAsked: 0,
      revisionCount: 0,
    };
  }
  
  /**
   * Get current context
   */
  getContext(): BrainstormContext {
    return { ...this.context };
  }
  
  /**
   * Get current phase
   */
  getPhase(): BrainstormPhase {
    return this.context.phase;
  }
  
  /**
   * Check if transition is valid
   */
  canTransition(targetPhase: BrainstormPhase): boolean {
    return VALID_TRANSITIONS[this.context.phase].includes(targetPhase);
  }
  
  /**
   * Process an event and return new state
   */
  process(event: BrainstormEvent): { success: boolean; error?: string } {
    switch (event.type) {
      case 'START':
        return this.handleStart(event);
      case 'CONTEXT_FOUND':
        return this.handleContextFound(event);
      case 'ASK_QUESTION':
        return this.handleAskQuestion(event);
      case 'ANSWER_QUESTION':
        return this.handleAnswerQuestion(event);
      case 'PROPOSE_APPROACHES':
        return this.handleProposeApproaches(event);
      case 'SELECT_APPROACH':
        return this.handleSelectApproach(event);
      case 'PRESENT_SECTION':
        return this.handlePresentSection(event);
      case 'APPROVE_SECTION':
        return this.handleApproveSection(event);
      case 'REVISE_SECTION':
        return this.handleReviseSection(event);
      case 'WRITE_DESIGN_DOC':
        return this.handleWriteDesignDoc();
      case 'USER_REVIEW_COMPLETE':
        return this.handleUserReviewComplete(event);
      case 'TRANSITION_TO_ORCHESTRATOR':
        return this.handleTransitionToOrchestrator();
      case 'DEFER_TRANSITION':
        return this.handleDeferTransition();
      case 'CANCEL':
        return this.handleCancel();
      default:
        return { success: false, error: 'Unknown event type' };
    }
  }
  
  /**
   * Build result from current state
   */
  buildResult(success: boolean, transitionedTo?: 'orchestrator' | 'deferred'): BrainstormResult {
    const endTime = new Date();
    const metrics: BrainstormMetrics = {
      questionsAsked: this.context.questionsAsked,
      approachesProposed: this.context.approaches?.length || 0,
      designSectionsCount: this.context.designSections?.length || 0,
      approvalIterations: this.context.revisionCount + 1,
      durationMs: endTime.getTime() - this.startTime.getTime(),
      startedAt: this.startTime.toISOString(),
      endedAt: endTime.toISOString(),
    };
    
    return {
      success,
      phase: this.context.phase,
      metrics,
      transitionedTo,
    };
  }
  
  // ========================================================================
  // Event Handlers
  // ========================================================================
  
  private handleStart(event: Extract<BrainstormEvent, { type: 'START' }>): { success: boolean; error?: string } {
    if (this.context.phase !== 'exploring') {
      return { success: false, error: 'Can only start from exploring phase' };
    }
    
    if (event.request) {
      this.context.request = event.request;
    }
    
    return { success: true };
  }
  
  private handleContextFound(event: Extract<BrainstormEvent, { type: 'CONTEXT_FOUND' }>): { success: boolean; error?: string } {
    this.context.projectContext = event.context;
    
    // Auto-transition to clarifying
    return this.transitionTo('clarifying');
  }
  
  private handleAskQuestion(event: Extract<BrainstormEvent, { type: 'ASK_QUESTION' }>): { success: boolean; error?: string } {
    if (this.context.phase !== 'clarifying') {
      return { success: false, error: 'Can only ask questions in clarifying phase' };
    }
    
    // Track question count
    if (!event.question.answered) {
      this.context.questionsAsked++;
    }
    
    return { success: true };
  }
  
  private handleAnswerQuestion(event: Extract<BrainstormEvent, { type: 'ANSWER_QUESTION' }>): { success: boolean; error?: string } {
    // Update intent spec with answer
    if (!this.context.intentSpec) {
      this.context.intentSpec = {
        purpose: this.context.request,
        constraints: [],
        successCriteria: [],
      };
    }
    
    // Add constraint or success criterion based on answer
    // This is simplified - real implementation would be more sophisticated
    return { success: true };
  }
  
  private handleProposeApproaches(event: Extract<BrainstormEvent, { type: 'PROPOSE_APPROACHES' }>): { success: boolean; error?: string } {
    if (this.context.phase !== 'clarifying' && this.context.phase !== 'proposing') {
      return { success: false, error: 'Invalid phase for proposing approaches' };
    }
    
    this.context.approaches = event.approaches;
    
    // Transition to proposing if not already there
    if (this.context.phase === 'clarifying') {
      return this.transitionTo('proposing');
    }
    
    return { success: true };
  }
  
  private handleSelectApproach(event: Extract<BrainstormEvent, { type: 'SELECT_APPROACH' }>): { success: boolean; error?: string } {
    if (this.context.phase !== 'proposing') {
      return { success: false, error: 'Invalid phase for selecting approach' };
    }
    
    // Find and mark selected approach
    const approach = this.context.approaches?.find(a => a.id === event.approachId);
    if (!approach) {
      return { success: false, error: 'Approach not found' };
    }
    
    // Mark all approaches
    this.context.approaches = (this.context.approaches ?? []).map(a => ({
      ...a,
      recommended: a.id === event.approachId,
    }));
    
    // Transition to designing
    return this.transitionTo('designing');
  }
  
  private handlePresentSection(event: Extract<BrainstormEvent, { type: 'PRESENT_SECTION' }>): { success: boolean; error?: string } {
    if (this.context.phase !== 'designing') {
      return { success: false, error: 'Invalid phase for presenting sections' };
    }
    
    // Add section if not already present
    if (!this.context.designSections) {
      this.context.designSections = [];
    }
    
    const existing = this.context.designSections.find(s => s.id === event.section.id);
    if (!existing) {
      this.context.designSections.push(event.section);
    }
    
    return { success: true };
  }
  
  private handleApproveSection(event: Extract<BrainstormEvent, { type: 'APPROVE_SECTION' }>): { success: boolean; error?: string } {
    const section = this.context.designSections?.find(s => s.id === event.sectionId);
    if (!section) {
      return { success: false, error: 'Section not found' };
    }
    
    section.approved = true;
    section.approvedAt = new Date().toISOString();
    
    // Check if all sections are approved
    const sections = this.context.designSections ?? [];
    const allApproved = sections.length > 0 && sections.every(s => s.approved);
    if (allApproved) {
      return this.transitionTo('approved');
    }
    
    return { success: true };
  }
  
  private handleReviseSection(event: Extract<BrainstormEvent, { type: 'REVISE_SECTION' }>): { success: boolean; error?: string } {
    const section = this.context.designSections?.find(s => s.id === event.sectionId);
    if (!section) {
      return { success: false, error: 'Section not found' };
    }
    
    section.content = event.revision;
    section.revisionNotes = `Revised at ${new Date().toISOString()}`;
    section.approved = false;
    section.approvedAt = undefined;
    
    this.context.revisionCount++;
    
    return { success: true };
  }
  
  private handleWriteDesignDoc(): { success: boolean; error?: string } {
    // This would trigger writing the design document
    // For now, just validate we have the necessary data
    if (!this.context.designSections?.length) {
      return { success: false, error: 'No design sections to write' };
    }
    
    return { success: true };
  }
  
  private handleUserReviewComplete(event: Extract<BrainstormEvent, { type: 'USER_REVIEW_COMPLETE' }>): { success: boolean; error?: string } {
    if (event.approved) {
      return this.transitionTo('approved');
    } else {
      return this.transitionTo('designing');
    }
  }
  
  private handleTransitionToOrchestrator(): { success: boolean; error?: string } {
    if (this.context.phase !== 'approved') {
      return { success: false, error: 'Can only transition to orchestrator from approved phase' };
    }

    return { success: true };
  }
  
  private handleDeferTransition(): { success: boolean; error?: string } {
    if (this.context.phase !== 'approved') {
      return { success: false, error: 'Can only defer from approved phase' };
    }
    
    return { success: true };
  }
  
  private handleCancel(): { success: boolean; error?: string } {
    this.context.phase = 'cancelled';
    return { success: true };
  }
  
  // ========================================================================
  // Helper Methods
  // ========================================================================
  
  private transitionTo(targetPhase: BrainstormPhase): { success: boolean; error?: string } {
    if (!this.canTransition(targetPhase)) {
      return {
        success: false,
        error: `Invalid transition from ${this.context.phase} to ${targetPhase}`,
      };
    }
    
    this.context.phase = targetPhase;
    return { success: true };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createBrainstormContext(cwd: string, request?: string): BrainstormContext {
  return {
    cwd,
    request: request || '',
    phase: 'exploring',
    questionsAsked: 0,
    revisionCount: 0,
  };
}

export function isTerminalPhase(phase: BrainstormPhase): boolean {
  return phase === 'approved' || phase === 'rejected' || phase === 'cancelled';
}

export function isActivePhase(phase: BrainstormPhase): boolean {
  return !isTerminalPhase(phase);
}

export default BrainstormStateMachine;

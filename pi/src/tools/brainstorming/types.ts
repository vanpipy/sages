/**
 * Brainstorming Skill - Type Definitions
 * 
 * Types for the brainstorming workflow: state management,
 * user intent, design proposals, and results.
 */

// ============================================================================
// Phase Types
// ============================================================================

export type BrainstormPhase = 
  | "exploring"      // Exploring project context
  | "clarifying"      // Asking clarifying questions
  | "proposing"       // Proposing approaches
  | "designing"       // Presenting design sections
  | "approved"        // Design approved, ready to transition
  | "rejected"        // User rejected the approach
  | "cancelled";      // User cancelled the session

// ============================================================================
// Parameter Types
// ============================================================================

export interface BrainstormParams {
  /** Optional initial request from user */
  request?: string;
  /** Optional project path (defaults to current workspace) */
  context?: string;
}

export interface BrainstormContext {
  /** Current workspace path */
  cwd: string;
  /** User's request */
  request: string;
  /** Project context discovered during exploration */
  projectContext?: ProjectContext;
  /** User's clarified intent */
  intentSpec?: IntentSpec;
  /** Proposed approaches */
  approaches?: Approach[];
  /** Current design sections */
  designSections?: DesignSection[];
  /** Current phase */
  phase: BrainstormPhase;
  /** Questions asked so far */
  questionsAsked: number;
  /** Design revision count */
  revisionCount: number;
}

export interface ProjectContext {
  /** Project name from directory */
  projectName: string;
  /** Primary language detected */
  language: string;
  /** Framework if detected */
  framework: string | null;
  /** Project type (web, cli, api, etc.) */
  projectType: string;
  /** Tech stack information */
  techStack: TechStack;
  /** Existing components found */
  existingComponents: string[];
  /** Key files detected */
  keyFiles: KeyFile[];
  /** Recent commit messages (if available) */
  recentCommits?: string[];
}

export interface TechStack {
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  testing: string[];
  linting: string[];
}

export interface KeyFile {
  path: string;
  purpose: string;
}

// ============================================================================
// Intent Specification
// ============================================================================

export interface IntentSpec {
  /** What the user wants to build */
  purpose: string;
  /** Constraints or limitations */
  constraints: string[];
  /** How success will be measured */
  successCriteria: string[];
  /** Target users or audience */
  targetUsers?: string[];
  /** Priority level */
  priority?: "low" | "medium" | "high" | "critical";
  /** Additional notes */
  notes?: string;
}

// ============================================================================
// Approach Types
// ============================================================================

export interface Approach {
  /** Unique identifier */
  id: string;
  /** Approach name */
  name: string;
  /** Brief description */
  description: string;
  /** Pros of this approach */
  pros: string[];
  /** Cons of this approach */
  cons: string[];
  /** Complexity level */
  complexity: "low" | "medium" | "high";
  /** Time estimate */
  timeEstimate?: string;
  /** Is this the recommended approach */
  recommended?: boolean;
  /** Implementation hints */
  implementationHints?: string;
}

export interface ApproachComparison {
  /** All proposed approaches */
  approaches: Approach[];
  /** Recommended approach index */
  recommendedIndex: number;
  /** Comparison criteria */
  criteria: string[];
  /** Comparison matrix */
  matrix: boolean[][];
}

// ============================================================================
// Design Section Types
// ============================================================================

export interface DesignSection {
  /** Unique identifier */
  id: string;
  /** Section title */
  title: string;
  /** Section content (markdown) */
  content: string;
  /** Section order */
  order: number;
  /** Is this section approved */
  approved: boolean;
  /** Approval timestamp */
  approvedAt?: string;
  /** Revision notes if revised */
  revisionNotes?: string;
}

export interface DesignDoc {
  /** Document title */
  title: string;
  /** Overview section */
  overview: string;
  /** Context section */
  context: string;
  /** Requirements section */
  requirements: string[];
  /** Chosen approach */
  chosenApproach: Approach;
  /** Alternative approaches considered */
  alternatives: Approach[];
  /** Design sections */
  sections: DesignSection[];
  /** Open questions */
  openQuestions: string[];
  /** Acceptance criteria */
  acceptanceCriteria: string[];
  /** Created timestamp */
  createdAt: string;
  /** Updated timestamp */
  updatedAt?: string;
}

// ============================================================================
// Result Types
// ============================================================================

export interface BrainstormResult {
  /** Whether brainstorming was successful */
  success: boolean;
  /** Final phase */
  phase: BrainstormPhase;
  /** Design document (if approved) */
  designDoc?: DesignDoc;
  /** Design document file path (if saved) */
  designPath?: string;
  /** Error message if failed */
  error?: string;
  /** Transition decision */
  transitionedTo?: "orchestrator" | "deferred" | "none";
  /** Session metrics */
  metrics: BrainstormMetrics;
}

export interface BrainstormMetrics {
  /** Questions asked */
  questionsAsked: number;
  /** Approaches proposed */
  approachesProposed: number;
  /** Design sections count */
  designSectionsCount: number;
  /** Total approval iterations */
  approvalIterations: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Start timestamp */
  startedAt: string;
  /** End timestamp */
  endedAt: string;
}

// ============================================================================
// Clarifying Question Types
// ============================================================================

export type QuestionType = 
  | "multiple_choice"  // Choose from options
  | "yes_no"           // Yes or No question
  | "text"             // Open-ended question
  | "scale";           // Rate on a scale

export interface ClarifyingQuestion {
  /** Unique identifier */
  id: string;
  /** Question text */
  question: string;
  /** Question type */
  type: QuestionType;
  /** Options for multiple choice */
  options?: QuestionOption[];
  /** Why this question matters */
  rationale: string;
  /** Has this been answered */
  answered: boolean;
  /** User's answer */
  answer?: string;
}

export interface QuestionOption {
  /** Option value */
  value: string;
  /** Option label */
  label: string;
  /** Is this the recommended option */
  recommended?: boolean;
}

// ============================================================================
// State Machine Events
// ============================================================================

export type BrainstormEvent =
  | { type: "START"; request?: string; context?: string }
  | { type: "CONTEXT_FOUND"; context: ProjectContext }
  | { type: "ASK_QUESTION"; question: ClarifyingQuestion }
  | { type: "ANSWER_QUESTION"; questionId: string; answer: string }
  | { type: "PROPOSE_APPROACHES"; approaches: Approach[] }
  | { type: "SELECT_APPROACH"; approachId: string }
  | { type: "PRESENT_SECTION"; section: DesignSection }
  | { type: "APPROVE_SECTION"; sectionId: string }
  | { type: "REVISE_SECTION"; sectionId: string; revision: string }
  | { type: "WRITE_DESIGN_DOC" }
  | { type: "USER_REVIEW_COMPLETE"; approved: boolean }
  | { type: "TRANSITION_TO_ORCHESTRATOR" }
  | { type: "DEFER_TRANSITION" }
  | { type: "CANCEL" };

// ============================================================================
// Tool Definition
// ============================================================================

export const BRAINSTORM_TOOL = {
  name: "brainstorm",
  description: "Explore user intent, propose approaches, and design before implementation",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "Optional initial request or topic to brainstorm",
      },
      context: {
        type: "string",
        description: "Optional project path (defaults to current workspace)",
      },
    },
  },
};

export default {
  BRAINSTORM_TOOL,
};

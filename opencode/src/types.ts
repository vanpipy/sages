/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Sages Plugin - Type Definitions 🜄                                    ║
 * ║                                                                           ║
 * ║   Shared TypeScript interfaces for the Four Sages Agents plugin          ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

// =============================================================================
// Plugin Types
// =============================================================================

export interface PluginConfig {
  directory: string;
  client: unknown;
}

export interface PluginContext {
  sessionID: string;
  messageID: string;
  agent: string;
}

// =============================================================================
// Session Types (Fuxi Compaction Prevention)
// =============================================================================

export interface SessionState {
  id: string;
  projectPath: string;
  agentName: string;
  initializedAt: string;
  lastActivityAt: string;
  currentPlanName?: string;
  draftPath?: string;
  planPath?: string;
  executionPath?: string;
  status: SessionStatus;
}

export type SessionStatus =
  | "initialized"
  | "draft_created"
  | "plan_approved"
  | "execution_in_progress"
  | "review_pending"
  | "completed"
  | "failed";

export interface SessionPersistence {
  sessions: Record<string, SessionState>;
  activeSessionId?: string;
}

// =============================================================================
// File Lock Types (Lu Ban Conflict Prevention)
// =============================================================================

export interface FileLock {
  taskId: string;
  filePath: string;
  lockedBy: string;
  lockedAt: string;
  expiresAt?: string;
}

export interface FileLockResult {
  success: boolean;
  conflict?: {
    taskId: string;
    lockedBy: string;
    lockedAt: string;
  };
}

export interface FileLockRegistry {
  locks: Record<string, FileLock>; // key: taskId:filePath
}

// =============================================================================
// Execution Plan Types (Fuxi Error Recovery)
// =============================================================================

export interface ExecutionPlan {
  name: string;
  timestamp: string;
  tasks: Task[];
  phases: Phase[];
  totalEstimatedTime: number;
  strategy: ExecutionStrategy;
}

export interface Task {
  id: string;
  description: string;
  priority: "high" | "medium" | "low";
  estimatedTime: number;
  dependsOn: string[];
  files: string[];
  status: TaskStatus;
  result?: TaskResult;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";

export interface TaskResult {
  status: "success" | "failed";
  message?: string;
  filesCreated?: string[];
  filesModified?: string[];
  testCommand?: string;
  error?: string;
}

export interface Phase {
  name: string;
  tasks: string[];
  type: "sequential" | "parallel";
}

export interface ExecutionStrategy {
  failFast: boolean;
  maxRetries: number;
  retryDelayMs: number;
  continueOnFailure: boolean;
}

// =============================================================================
// Design Draft Types (Fuxi Eight Trigrams)
// =============================================================================

export interface DesignDraft {
  name: string;
  timestamp: string;
  status: "draft" | "approved" | "rejected";
  qian: QianSection;
  kun: KunSection;
  zhen: ZhenSection;
  xun: XunSection;
  kan: KanSection;
  li: LiSection;
  gen: GenSection;
  dui: DuiSection;
  notes?: string;
}

export interface QianSection {
  coreIntent: string;
  why: string;
}

export interface KunSection {
  entities: string[];
  dataModels: string[];
}

export interface ZhenSection {
  triggers: string[];
  events: string[];
}

export interface XunSection {
  dataFlow: string[];
  transformations: string[];
}

export interface KanSection {
  errorHandling: string[];
  fallbackStrategies: string[];
}

export interface LiSection {
  observability: string[];
  metrics: string[];
}

export interface GenSection {
  boundaries: string[];
  mustNotDo: string[];
}

export interface DuiSection {
  successPath: string[];
  happyPath: string[];
}

// =============================================================================
// Review Types (QiaoChui & GaoYao)
// =============================================================================

export interface QiaoChuiReviewResult {
  verdict: QiaoChuiVerdict;
  taskCount?: number;
  estimatedTime?: number;
  issues?: string[];
  planPath?: string;
  executionPath?: string;
  recommendations?: string[];
}

export type QiaoChuiVerdict = "APPROVED" | "REVISE" | "REJECTED";

export interface GaoYaoReviewResult {
  verdict: GaoYaoVerdict;
  qualityScore?: number;
  issues?: ReviewIssue[];
  summary?: string;
  checks: GaoYaoChecks;
}

export type GaoYaoVerdict = "PASS" | "NEEDS_CHANGES" | "REJECTED";

export interface GaoYaoChecks {
  codeQuality: boolean;
  security: boolean;
  testCoverage: boolean;
  performance: boolean;
  documentation: boolean;
}

export interface ReviewIssue {
  severity: "critical" | "major" | "minor" | "info";
  category: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export type ReviewMode = "quick" | "full";

// =============================================================================
// Tool Result Types
// =============================================================================

export interface ToolSuccess<T = unknown> {
  success: true;
  data: T;
}

export interface ToolError {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolError;

// =============================================================================
// Workflow State Types
// =============================================================================

export interface WorkflowState {
  planName: string;
  status: WorkflowStatus;
  hasDraft: boolean;
  hasPlan: boolean;
  hasExecution: boolean;
  currentPhase?: string;
  completedTasks: number;
  totalTasks: number;
  nextTask?: string;
}

export type WorkflowStatus =
  | "idle"
  | "draft"
  | "review"
  | "plan"
  | "execution"
  | "audit"
  | "completed"
  | "failed";

// =============================================================================
// CLI Tool Arguments (raw from JSON)
// =============================================================================

export interface FuxiCreateDraftArgs {
  name: string;
  request: string;
}

export interface FuxiGetDraftArgs {
  name: string;
}

export interface QiaoChuiReviewArgs {
  draft_path: string;
}

export interface QiaoChuiDecomposeArgs {
  draft_path: string;
  max_tasks?: number;
}

export interface LuBanExecuteTaskArgs {
  task_id: string;
  task_description: string;
  files: string[];
  test_command?: string;
}

export interface LuBanGetStatusArgs {
  plan_name: string;
}

export interface GaoYaoReviewArgs {
  plan_name: string;
  commit_hash?: string;
}

export interface GaoYaoCheckSecurityArgs {
  files: string[];
}

export interface SagesInitArgs {
  project_path: string;
  agent_name?: string;
  task_description?: string;
}

export interface SagesGetWorkflowStateArgs {
  plan_name?: string;
}

export interface SagesConfirmApprovalArgs {
  plan_name: string;
  confirmed: boolean;
}
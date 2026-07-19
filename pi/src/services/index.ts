/**
 * Services Index - Unified service layer for Four Sages role-based agents
 * 
 * Provides:
 * - FileService: Centralized file operations with security validation
 * - WorkflowStateManager: Unified state and workspace management
 */

export { FileService, createFileService } from "./file-service.js";
export {
  WorkflowStateManager,
  createWorkflowStateManager,
  type WorkflowState,
  type Task,
  type AuditResult,
  type FuxiPhase,
  type ArchiveInfo,
} from "./workflow-state-manager.js";

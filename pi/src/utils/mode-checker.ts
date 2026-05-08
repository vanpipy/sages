/**
 * ModeChecker - Phase-based file restrictions for Four Sages workflow
 * 
 * Phase modes based on skills:
 * - design: read-only, only draft.md (Fuxi)
 * - plan: read-only, plan.md, execution.yaml (QiaoChui)
 * - implement: writeable, all files (LuBan)
 * - review: read-only, audit.md (GaoYao)
 */

export interface ModeInfo {
  mode: "read-only" | "writeable";
  allowedFiles: string[];
  description: string;
}

/**
 * Allowed files per phase (from skills)
 */
const PHASE_ALLOWED_FILES: Record<string, string[]> = {
  design: ["draft.md"],
  plan: ["plan.md", "execution.yaml"],
  implement: ["*"],  // all files allowed
  review: ["audit.md"],
};

/**
 * Check if a file can be written based on current phase
 */
export function checkWritePermission(phase: string, filePath: string): boolean {
  const allowedFiles = PHASE_ALLOWED_FILES[phase];
  
  if (!allowedFiles) {
    return false;
  }

  // Wildcard means all files allowed
  if (allowedFiles.includes("*")) {
    return true;
  }

  // Extract filename from path
  const fileName = filePath.split("/").pop() || "";

  // Check for exact match
  if (allowedFiles.includes(fileName)) {
    return true;
  }

  // Check for pattern match (e.g., audit-{timestamp}.md)
  for (const pattern of allowedFiles) {
    if (pattern.includes("{")) {
      const regex = new RegExp("^audit-.*\\.md$");
      if (regex.test(fileName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get mode information for a phase
 */
export function getModeInfo(phase: string): ModeInfo {
  const allowedFiles = PHASE_ALLOWED_FILES[phase] || [];
  const mode = allowedFiles.includes("*") ? "writeable" : "read-only";

  return {
    mode,
    allowedFiles,
    description: getModeDescription(phase),
  };
}

/**
 * Get human-readable mode description
 */
function getModeDescription(phase: string): string {
  const descriptions: Record<string, string> = {
    design: "Fuxi: Only modify draft.md. Read-only for all other files.",
    plan: "QiaoChui: Only modify plan.md, execution.yaml. Read-only for all other files.",
    implement: "LuBan: All files allowed. Follow TDD: RED → GREEN → REFACTOR.",
    review: "GaoYao: Only modify audit.md. Read-only for all other files.",
    idle: "No active workflow. No file modifications allowed.",
    complete: "Workflow complete. No further modifications.",
  };

  return descriptions[phase] || "Unknown phase.";
}

/**
 * Generate steer message with mode indicator for system prompt
 */
export function getModeIndicator(phase: string): string {
  const info = getModeInfo(phase);
  
  const phaseEmoji: Record<string, string> = {
    design: "",
    plan: "📋",
    implement: "",
    review: "",
    idle: "⏸️",
    complete: "✅",
  };

  const emoji = phaseEmoji[phase] || "❓";

  return `**Phase: ${phase.charAt(0).toUpperCase() + phase.slice(1)}** ${emoji} (${info.mode.toUpperCase()})
- ${info.description}`;
}

/**
 * Generate warning message for invalid file access
 */
export function getAccessDeniedMessage(phase: string, filePath: string): string {
  const info = getModeInfo(phase);
  const fileName = filePath.split("/").pop() || filePath;

  return `[READ-ONLY] Cannot modify ${fileName} during ${phase} phase.
Allowed: ${info.allowedFiles.join(", ")}`;
}
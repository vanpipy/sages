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
 * Phase mode configuration
 */
export interface PhaseConfig {
  mode: "read-only" | "writeable";
  allowedFiles: string[];
  emoji: string;
  description: string;
}

const PHASE_CONFIGS: Record<string, PhaseConfig> = {
  design: {
    mode: "read-only",
    allowedFiles: ["draft.md"],
    emoji: "",
    description: "Fuxi: Only modify draft.md. Read-only for all other files.",
  },
  plan: {
    mode: "read-only",
    allowedFiles: ["plan.md", "execution.yaml"],
    emoji: "📋",
    description: "QiaoChui: Only modify plan.md, execution.yaml. Read-only for all other files.",
  },
  implement: {
    mode: "writeable",
    allowedFiles: ["*"], // all files allowed
    emoji: "",
    description: "LuBan: All files allowed. Follow TDD: RED → GREEN → REFACTOR.",
  },
  review: {
    mode: "read-only",
    allowedFiles: ["audit*.md"], // audit.md, audit-2024-01-15.md, etc.
    emoji: "",
    description: "GaoYao: Only modify audit.md. Read-only for all other files.",
  },
  idle: {
    mode: "read-only",
    allowedFiles: [],
    emoji: "⏸️",
    description: "No active workflow. No file modifications allowed.",
  },
  complete: {
    mode: "read-only",
    allowedFiles: [],
    emoji: "✅",
    description: "Workflow complete. No further modifications.",
  },
};


/**
 * Legacy compatibility - extract allowed files for permission checking
 */
const PHASE_ALLOWED_FILES: Record<string, string[]> = Object.fromEntries(
  Object.entries(PHASE_CONFIGS).map(([phase, config]) => [phase, config.allowedFiles])
);

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

  // Check for pattern matches
  for (const pattern of allowedFiles) {
    // Handle wildcard patterns like audit-*.md
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(".", "\\.").replace("*", ".*") + "$");
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
  const config = PHASE_CONFIGS[phase];
  
  if (!config) {
    return {
      mode: "read-only",
      allowedFiles: [],
      description: "Unknown phase.",
    };
  }

  return {
    mode: config.mode,
    allowedFiles: config.allowedFiles,
    description: config.description,
  };
}

/**
 * Generate steer message with mode indicator for system prompt
 */
export function getModeIndicator(phase: string): string {
  const config = PHASE_CONFIGS[phase] ?? {
    mode: "read-only",
    allowedFiles: [],
    emoji: "❓",
    description: "Unknown phase.",
  };

  return `**Phase: ${phase.charAt(0).toUpperCase() + phase.slice(1)}** ${config.emoji} (${config.mode.toUpperCase()})
- ${config.description}`;
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
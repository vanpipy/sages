/**
 * Brainstorming Tool - Main Entry Point
 * 
 * Composes all brainstorming components and provides the /brainstorm command.
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { BrainstormStateMachine, isTerminalPhase, isActivePhase } from "./state";
import type {
  BrainstormParams,
  BrainstormResult,
  BrainstormPhase,
  BrainstormContext,
  ProjectContext,
  Approach,
  DesignSection,
  ClarifyingQuestion,
  IntentSpec,
} from "./types";

// ============================================================================
// Configuration
// ============================================================================

const DESIGNS_DIR = ".sages/designs";

// ============================================================================
// Main Brainstorming Function
// ============================================================================

export interface BrainstormContextResult {
  projectName: string;
  language: string;
  framework: string | null;
  projectType: string;
  techStack: {
    languages: string[];
    frameworks: string[];
    buildTools: string[];
    testing: string[];
    linting: string[];
  };
  existingComponents: string[];
  keyFiles: { path: string; purpose: string }[];
}

export async function discoverProjectContext(cwd: string): Promise<BrainstormContextResult> {
  const projectName = basename(cwd);
  
  // Detect language
  let language = "unknown";
  let framework: string | null = null;
  const techStack = {
    languages: [],
    frameworks: [],
    buildTools: [],
    testing: [],
    linting: [],
  };
  
  // Check for go.mod
  if (existsSync(join(cwd, "go.mod"))) {
    language = "go";
    const content = readFileSync(join(cwd, "go.mod"), "utf-8");
    const goVersion = content.match(/^go\s+(\d+\.\d+)/m);
    if (goVersion) techStack.languages.push(`Go ${goVersion[1]}`);
    
    if (content.includes("github.com/charmbracelet/bubbletea")) framework = "bubbletea";
    if (content.includes("github.com/spf13/cobra")) techStack.frameworks.push("cobra");
    if (content.includes("github.com/spf13/viper")) techStack.frameworks.push("viper");
  }
  
  // Check for package.json
  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      
      if (deps.typescript || deps["@types/node"]) {
        language = "typescript";
        techStack.languages.push("TypeScript");
      }
      
      if (deps.react) { framework = "react"; techStack.frameworks.push("react"); }
      if (deps.vue) { framework = "vue"; techStack.frameworks.push("vue"); }
      if (deps.next) techStack.frameworks.push("next");
      if (deps.vitest) techStack.testing.push("vitest");
      if (deps.jest) techStack.testing.push("jest");
      if (deps.eslint) techStack.linting.push("eslint");
      if (deps.vite) techStack.buildTools.push("vite");
    } catch { /* ignore */ }
  }
  
  // Detect project type
  let projectType = "unknown";
  if (framework && ["react", "vue", "svelte", "next"].includes(framework)) {
    projectType = "web";
  } else if (framework && ["bubbletea", "cobra"].includes(framework)) {
    projectType = "cli";
  } else if (language === "go" && existsSync(join(cwd, "cmd"))) {
    projectType = "cli";
  }
  
  // Detect existing components
  const existingComponents: string[] = [];
  const keyFiles: { path: string; purpose: string }[] = [];
  
  // Scan for common directories
  const dirsToCheck = ["src", "lib", "internal", "cmd", "components", "services", "models"];
  for (const dir of dirsToCheck) {
    const dirPath = join(cwd, dir);
    if (existsSync(dirPath)) {
      try {
        const stat = statSync(dirPath);
        if (stat.isDirectory()) {
          existingComponents.push(dir);
        }
      } catch { /* ignore */ }
    }
  }
  
  // Key files
  if (existsSync(join(cwd, "go.mod"))) {
    keyFiles.push({ path: "go.mod", purpose: "Go module dependencies" });
  }
  if (existsSync(join(cwd, "package.json"))) {
    keyFiles.push({ path: "package.json", purpose: "npm package configuration" });
  }
  if (existsSync(join(cwd, "README.md"))) {
    keyFiles.push({ path: "README.md", purpose: "Project documentation" });
  }
  
  return {
    projectName,
    language,
    framework,
    projectType,
    techStack,
    existingComponents,
    keyFiles,
  };
}

export function generateClarifyingQuestions(
  request: string,
  projectContext: BrainstormContextResult
): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];
  
  // Scope question
  questions.push({
    id: "scope",
    question: "What's the scope of this feature?",
    type: "multiple_choice",
    rationale: "Understanding scope helps determine complexity",
    answered: false,
    options: [
      { value: "small", label: "Small - single component or function", recommended: true },
      { value: "medium", label: "Medium - several components with interactions" },
      { value: "large", label: "Large - multiple subsystems or services" },
    ],
  });
  
  // Priority question
  questions.push({
    id: "priority",
    question: "What's the priority level?",
    type: "multiple_choice",
    rationale: "Helps balance quality vs speed",
    answered: false,
    options: [
      { value: "high", label: "High - need it soon", recommended: true },
      { value: "medium", label: "Medium - no urgent deadline" },
      { value: "low", label: "Low - nice to have" },
    ],
  });
  
  // User-facing question
  questions.push({
    id: "users",
    question: "Who will use this feature?",
    type: "multiple_choice",
    rationale: "Helps determine UX requirements",
    answered: false,
    options: [
      { value: "internal", label: "Internal users (developers/admins)" },
      { value: "external", label: "End users/customers", recommended: true },
      { value: "both", label: "Both internal and external" },
    ],
  });
  
  // Edge case handling
  questions.push({
    id: "edge_cases",
    question: "How should edge cases be handled?",
    type: "multiple_choice",
    rationale: "Error handling is part of the design",
    answered: false,
    options: [
      { value: "strict", label: "Fail fast with clear errors", recommended: true },
      { value: "graceful", label: "Graceful degradation with fallbacks" },
      { value: "permissive", label: "Skip invalid inputs, continue processing" },
    ],
  });
  
  return questions;
}

export function generateApproaches(
  request: string,
  intent: IntentSpec,
  projectContext: BrainstormContextResult
): Approach[] {
  const approaches: Approach[] = [];
  
  // Approach A: Quick & Simple
  approaches.push({
    id: "simple",
    name: "Quick Implementation",
    description: "Focus on minimal viable solution with existing patterns",
    pros: [
      "Faster to implement",
      "Less risk of breaking existing code",
      "Easier to test and maintain",
    ],
    cons: [
      "May need refactoring later",
      "Limited flexibility",
      "May not scale well",
    ],
    complexity: "low",
    timeEstimate: projectContext.language === "go" ? "1-2 days" : "2-4 hours",
    recommended: true,
    implementationHints: `Follow existing ${projectContext.language} patterns in the codebase`,
  });
  
  // Approach B: Robust & Extensible
  approaches.push({
    id: "robust",
    name: "Robust Design",
    description: "Design for extensibility with proper interfaces and abstractions",
    pros: [
      "Better for future changes",
      "Clear separation of concerns",
      "Easier to test in isolation",
    ],
    cons: [
      "More upfront design time",
      "May be over-engineering for simple features",
      "Requires understanding of existing patterns",
    ],
    complexity: "medium",
    timeEstimate: projectContext.language === "go" ? "3-5 days" : "4-8 hours",
    implementationHints: projectContext.framework 
      ? `Use ${projectContext.framework} conventions`
      : `Follow Go idiomatic patterns (interfaces, errors)`,
  });
  
  // Approach C: Hybrid
  approaches.push({
    id: "hybrid",
    name: "Iterative Enhancement",
    description: "Start simple but design for easy enhancement",
    pros: [
      "Balance of speed and quality",
      "Can iterate based on feedback",
      "Defensive programming from the start",
    ],
    cons: [
      "Requires more upfront thought",
      "May be harder to estimate time",
      "Need to balance immediate vs long-term needs",
    ],
    complexity: "medium",
    timeEstimate: projectContext.language === "go" ? "2-3 days" : "3-5 hours",
    implementationHints: "Use feature flags to enable/disable functionality",
  });
  
  return approaches;
}

export function generateDesignSections(
  request: string,
  approach: Approach,
  projectContext: BrainstormContextResult
): DesignSection[] {
  const sections: DesignSection[] = [];
  
  // Architecture Section
  sections.push({
    id: "architecture",
    title: "Architecture",
    content: `## Architecture

For this ${projectContext.projectType} project using ${projectContext.language}${projectContext.framework ? ` with ${projectContext.framework}` : ''}:

**Design Principles:**
- Use existing project patterns and conventions
- Keep components focused and single-purpose
- Error handling with clear error messages
- Testable architecture with dependency injection

**Component Structure:**
${projectContext.existingComponents.length > 0 
  ? `- Leverage existing: ${projectContext.existingComponents.join(', ')}`
  : `- Create new component directory as needed`}
`,
    order: 1,
    approved: false,
  });
  
  // Data Flow Section
  sections.push({
    id: "data-flow",
    title: "Data Flow",
    content: `## Data Flow

**Input Processing:**
1. Validate input data
2. Transform to internal representation
3. Process with business logic
4. Return or persist result

**Error Handling:**
- Return errors rather than throwing (Go idiom)
- Wrap errors with context using \`fmt.Errorf("context: %w", err)\`
- Log errors with structured context

**State Management:**
- Use value receivers for simple types
- Use pointer receivers for structs
- Consider zero-value usability`,
    order: 2,
    approved: false,
  });
  
  // Testing Section
  sections.push({
    id: "testing",
    title: "Testing Strategy",
    content: `## Testing Strategy

**Test Types:**
1. Unit tests for individual functions
2. Integration tests for component interactions
3. Edge case tests for error handling

**Test Organization:**
- Place tests alongside source files (*_test.go)
- Use table-driven tests for multiple scenarios
- Mock external dependencies

**Coverage Target:**
- Critical paths: 90%+
- Error handling: 100%
- Public API: 100%`,
    order: 3,
    approved: false,
  });
  
  return sections;
}

export function writeDesignDoc(
  cwd: string,
  request: string,
  sections: DesignSection[],
  approach: Approach
): string {
  // Create designs directory
  const designsPath = join(cwd, DESIGNS_DIR);
  if (!existsSync(designsPath)) {
    mkdirSync(designsPath, { recursive: true });
  }
  
  // Generate filename
  const date = new Date().toISOString().split("T")[0];
  const safeName = request.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const filename = `${date}-${safeName}.md`;
  const filepath = join(designsPath, filename);
  
  // Build document
  let content = `# Design: ${request}\n\n`;
  content += `**Date:** ${date}\n`;
  content += `**Approach:** ${approach.name}\n\n`;
  content += `---\n\n`;
  
  // Add sections
  for (const section of sections.sort((a, b) => a.order - b.order)) {
    content += section.content + "\n\n";
  }
  
  // Write file
  writeFileSync(filepath, content, "utf-8");
  
  return filepath;
}

// ============================================================================
// Main Brainstorm Function
// ============================================================================

export interface BrainstormResponse {
  phase: BrainstormPhase;
  message: string;
  context?: BrainstormContextResult;
  questions?: ClarifyingQuestion[];
  approaches?: Approach[];
  sections?: DesignSection[];
  designPath?: string;
  result?: BrainstormResult;
}

export function startBrainstorm(cwd: string, request?: string): BrainstormResponse {
  // Create state machine
  const stateMachine = new BrainstormStateMachine(cwd, request);
  
  // Discover project context
  const projectContext = discoverProjectContext(cwd);
  
  // Generate initial response
  return {
    phase: "exploring",
    message: `Starting brainstorm for: ${request || "Please describe what you want to build"}\n\n` +
      `**Project Context Discovered:**\n` +
      `- Project: ${projectContext.projectName}\n` +
      `- Language: ${projectContext.language}\n` +
      `- Framework: ${projectContext.framework || "none detected"}\n` +
      `- Type: ${projectContext.projectType}\n\n` +
      `Let me ask a few clarifying questions to better understand your needs.`,
    context: projectContext,
  };
}

export function processClarifyingPhase(
  stateMachine: BrainstormStateMachine,
  request: string,
  projectContext: BrainstormContextResult
): BrainstormResponse {
  const questions = generateClarifyingQuestions(request, projectContext);
  
  // Build question message
  const firstQuestion = questions[0];
  let message = `**Clarifying Question 1 of ${questions.length}:**\n\n${firstQuestion.question}\n\n`;
  
  if (firstQuestion.options) {
    message += "Options:\n";
    for (const opt of firstQuestion.options) {
      const rec = opt.recommended ? " (recommended)" : "";
      message += `- ${opt.label}${rec}\n`;
    }
  }
  
  return {
    phase: "clarifying",
    message,
    context: projectContext,
    questions,
  };
}

export function processProposingPhase(
  stateMachine: BrainstormStateMachine,
  request: string,
  intent: IntentSpec,
  projectContext: BrainstormContextResult
): BrainstormResponse {
  const approaches = generateApproaches(request, intent, projectContext);
  
  // Build approaches message
  let message = `Based on your requirements, I propose **3 approaches**:\n\n`;
  
  for (let i = 0; i < approaches.length; i++) {
    const a = approaches[i];
    const rec = a.recommended ? " ⭐ **RECOMMENDED**" : "";
    message += `### ${String.fromCharCode(65 + i)}. ${a.name}${rec}\n\n`;
    message += `${a.description}\n\n`;
    message += `**Pros:** ${a.pros.join(", ")}\n`;
    message += `**Cons:** ${a.cons.join(", ")}\n`;
    message += `**Complexity:** ${a.complexity}\n`;
    if (a.timeEstimate) message += `**Time:** ${a.timeEstimate}\n`;
    message += "\n";
  }
  
  message += `Which approach would you like to proceed with? (A, B, or C)`;
  
  return {
    phase: "proposing",
    message,
    approaches,
    context: projectContext,
  };
}

export function processDesigningPhase(
  stateMachine: BrainstormStateMachine,
  request: string,
  selectedApproach: Approach,
  projectContext: BrainstormContextResult
): BrainstormResponse {
  const sections = generateDesignSections(request, selectedApproach, projectContext);
  
  // Build design sections message
  let message = `## Proposed Design\n\n`;
  message += `**Selected Approach:** ${selectedApproach.name}\n\n`;
  message += `I'll present the design in sections. Please review and approve each one.\n\n`;
  
  const firstSection = sections[0];
  message += `### Section 1: ${firstSection.title}\n\n${firstSection.content}`;
  
  return {
    phase: "designing",
    message,
    sections,
    context: projectContext,
  };
}

export function finalizeDesign(
  cwd: string,
  request: string,
  sections: DesignSection[],
  approach: Approach
): BrainstormResponse {
  const designPath = writeDesignDoc(cwd, request, sections, approach);
  
  return {
    phase: "approved",
    message: `Design document written to: \`${designPath}\`\n\n` +
      `**Next Steps:**\n` +
      `- Review the design document\n` +
      `- To start implementation, use: \`/fuxi-start <plan-name>\`\n` +
      `- Or say "proceed with implementation" to auto-transition`,
    designPath,
  };
}

// ============================================================================
// Tool Definition (for pi agent)
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
    },
    required: [],
  },
};

export default {
  BRAINSTORM_TOOL,
  startBrainstorm,
  processClarifyingPhase,
  processProposingPhase,
  processDesigningPhase,
  finalizeDesign,
};

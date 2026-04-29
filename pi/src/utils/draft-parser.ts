/**
 * Draft Parser - Extracts structured information from MDD (Multi-Dimensional Design) drafts
 * Supports the 7-plane format: Business, Data, Control, Foundation, Observation, Security, Evolution
 */

export interface ParsedDraft {
  name: string;
  intent: string;
  // MDD Planes
  business?: {
    process?: string[];
    rules?: string[];
  };
  data?: {
    logic?: string[];
    state?: string[];
  };
  control?: {
    strategy?: string[];
    distribution?: string[];
  };
  foundation?: {
    resource?: string[];
    abstraction?: string[];
  };
  observation?: {
    data?: string[];
    analysis?: string[];
  };
  security?: {
    identity?: string[];
    permissions?: string[];
  };
  evolution?: {
    time?: string[];
    change?: string[];
  };
  crossPlaneDependencies?: string[];
  keyDecisions?: string[];
  openQuestions?: string[];
}

/**
 * MDD Plane types
 */
type MDDPlane = "Business" | "Data" | "Control" | "Foundation" | "Observation" | "Security" | "Evolution";

/**
 * Section patterns for MDD format
 */
const SECTION_PATTERNS: Record<string, RegExp> = {
  // Overview
  overview: /^## Overview\n([\s\S]*?)(?=## |$)/im,
  
  // Business Plane
  businessProcess: /### 1\. Business Plane[\s\S]*?\*\*Process\*\*\n([\s\S]*?)(?=### |## |$)/i,
  businessRules: /### 1\. Business Plane[\s\S]*?\*\*Rules\*\*\n([\s\S]*?)(?=### |## |$)/i,
  
  // Data Plane
  dataLogic: /### 2\. Data Plane[\s\S]*?\*\*Logic\*\*\n([\s\S]*?)(?=### |## |$)/i,
  dataState: /### 2\. Data Plane[\s\S]*?\*\*State\*\*\n([\s\S]*?)(?=### |## |$)/i,
  
  // Control Plane
  controlStrategy: /### 3\. Control Plane[\s\S]*?\*\*Strategy\*\*\n([\s\S]*?)(?=### |## |$)/i,
  controlDistribution: /### 3\. Control Plane[\s\S]*?\*\*Distribution\*\*\n([\s\S]*?)(?=### |## |$)/i,
  
  // Foundation Plane
  foundationResource: /### 4\. Foundation Plane[\s\S]*?\*\*Resource\*\*\n([\s\S]*?)(?=### |## |$)/i,
  foundationAbstraction: /### 4\. Foundation Plane[\s\S]*?\*\*Abstraction\*\*\n([\s\S]*?)(?=### |## |$)/i,
  
  // Observation Plane
  observationData: /### 5\. Observation Plane[\s\S]*?\*\*Data\*\*\n([\s\S]*?)(?=### |## |$)/i,
  observationAnalysis: /### 5\. Observation Plane[\s\S]*?\*\*Analysis\*\*\n([\s\S]*?)(?=### |## |$)/i,
  
  // Security Plane
  securityIdentity: /### 6\. Security Plane[\s\S]*?\*\*Identity\*\*\n([\s\S]*?)(?=### |## |$)/i,
  securityPermissions: /### 6\. Security Plane[\s\S]*?\*\*Permissions\*\*\n([\s\S]*?)(?=### |## |$)/i,
  
  // Evolution Plane
  evolutionTime: /### 7\. Evolution Plane[\s\S]*?\*\*Time\*\*\n([\s\S]*?)(?=### |## |$)/i,
  evolutionChange: /### 7\. Evolution Plane[\s\S]*?\*\*Change\*\*\n([\s\S]*?)(?=### |## |$)/i,
  
  // Cross-cutting
  crossPlane: /## Cross-Plane Dependencies\n([\s\S]*?)(?=## |$)/i,
  decisions: /## Key Design Decisions\n([\s\S]*?)(?=## |$)/i,
  questions: /## Open Questions\n([\s\S]*?)(?=## |$)/i,
};

/**
 * Extract items from section content
 */
function extractSection(content: string, pattern: RegExp): string[] {
  const match = content.match(pattern);
  if (!match) return [];
  
  return match[1]
    .split("\n")
    .map(l => l.replace(/^[\s-•*]+/, "").trim())
    .filter(l => l && !l.startsWith("{") && !l.includes("None specified"));
}

/**
 * Check if text is a placeholder
 */
function isPlaceholder(text: string): boolean {
  return (
    text.includes("{") && text.includes("}") ||
    text.toLowerCase().includes("define") ||
    text.toLowerCase().includes("todo") ||
    text.toLowerCase().includes("tbd") ||
    text.toLowerCase().includes("none specified") ||
    text === "-"
  );
}

/**
 * Parse MDD draft content
 */
export function parseDraft(content: string, name: string): ParsedDraft | null {
  try {
    const intent = extractSection(content, SECTION_PATTERNS.overview);
    
    const parsed: ParsedDraft = {
      name,
      intent: intent.join(" "),
      business: {
        process: extractSection(content, SECTION_PATTERNS.businessProcess),
        rules: extractSection(content, SECTION_PATTERNS.businessRules),
      },
      data: {
        logic: extractSection(content, SECTION_PATTERNS.dataLogic),
        state: extractSection(content, SECTION_PATTERNS.dataState),
      },
      control: {
        strategy: extractSection(content, SECTION_PATTERNS.controlStrategy),
        distribution: extractSection(content, SECTION_PATTERNS.controlDistribution),
      },
      foundation: {
        resource: extractSection(content, SECTION_PATTERNS.foundationResource),
        abstraction: extractSection(content, SECTION_PATTERNS.foundationAbstraction),
      },
      observation: {
        data: extractSection(content, SECTION_PATTERNS.observationData),
        analysis: extractSection(content, SECTION_PATTERNS.observationAnalysis),
      },
      security: {
        identity: extractSection(content, SECTION_PATTERNS.securityIdentity),
        permissions: extractSection(content, SECTION_PATTERNS.securityPermissions),
      },
      evolution: {
        time: extractSection(content, SECTION_PATTERNS.evolutionTime),
        change: extractSection(content, SECTION_PATTERNS.evolutionChange),
      },
      crossPlaneDependencies: extractSection(content, SECTION_PATTERNS.crossPlane),
      keyDecisions: extractSection(content, SECTION_PATTERNS.decisions),
      openQuestions: extractSection(content, SECTION_PATTERNS.questions),
    };

    // Check if draft has meaningful content
    const allContent = [
      ...parsed.business?.process || [],
      ...parsed.business?.rules || [],
      ...parsed.data?.logic || [],
      ...parsed.data?.state || [],
      ...parsed.control?.strategy || [],
      ...parsed.control?.distribution || [],
      ...parsed.foundation?.resource || [],
      ...parsed.foundation?.abstraction || [],
      ...parsed.observation?.data || [],
      ...parsed.observation?.analysis || [],
      ...parsed.security?.identity || [],
      ...parsed.security?.permissions || [],
      ...parsed.evolution?.time || [],
      ...parsed.evolution?.change || [],
    ];

    const hasRealContent = allContent.some(item => !isPlaceholder(item));

    if (!hasRealContent && intent.length === 0) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validate MDD draft
 */
export function validateDraft(content: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  // Check for MDD plane headers
  const planes = [
    { name: "Business Plane", pattern: /### 1\. Business Plane/i },
    { name: "Data Plane", pattern: /### 2\. Data Plane/i },
    { name: "Control Plane", pattern: /### 3\. Control Plane/i },
    { name: "Foundation Plane", pattern: /### 4\. Foundation Plane/i },
    { name: "Observation Plane", pattern: /### 5\. Observation Plane/i },
    { name: "Security Plane", pattern: /### 6\. Security Plane/i },
    { name: "Evolution Plane", pattern: /### 7\. Evolution Plane/i },
  ];

  const foundPlanes = planes.filter(p => p.pattern.test(content)).length;
  
  // A valid MDD draft should have at least the Overview and 3 planes
  if (!content.includes("## Overview") && !content.includes("# System Design")) {
    issues.push("Missing Overview section");
  }

  if (foundPlanes < 3) {
    issues.push(`Only ${foundPlanes}/7 planes filled. MDD drafts should analyze at least 3 planes.`);
  }

  // Check for excessive placeholders
  const placeholderCount = (content.match(/- None specified/g) || []).length;
  if (placeholderCount > 5) {
    issues.push(`Too many placeholder sections (${placeholderCount}). Fill in actual content.`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Generate tasks from MDD draft
 */
export function generateTasksFromDraft(parsed: ParsedDraft): Array<{
  id: string;
  description: string;
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  plane: MDDPlane;
}> {
  const tasks: Array<{
    id: string;
    description: string;
    priority: "high" | "medium" | "low";
    dependsOn: string[];
    plane: MDDPlane;
  }> = [];

  let taskNum = 0;

  // Helper to add task
  const addTask = (description: string, plane: MDDPlane, priority: "high" | "medium" | "low", dependsOn: string[] = []) => {
    tasks.push({
      id: `T${++taskNum}`,
      description,
      plane,
      priority,
      dependsOn,
    });
  };

  // 1. Foundation tasks (High priority - no dependencies)
  if (parsed.foundation?.resource?.length) {
    addTask(
      `Setup infrastructure: ${parsed.foundation.resource[0]}`,
      "Foundation",
      "high",
      []
    );
  }

  if (parsed.foundation?.abstraction?.length) {
    addTask(
      `Define abstractions: ${parsed.foundation.abstraction[0]}`,
      "Foundation",
      "high",
      tasks.length > 0 ? [tasks[0].id] : []
    );
  }

  // 2. Data tasks (High priority)
  if (parsed.data?.logic?.length) {
    addTask(
      `Implement data logic: ${parsed.data.logic[0]}`,
      "Data",
      "high",
      tasks.filter(t => t.plane === "Foundation").map(t => t.id)
    );
  }

  if (parsed.data?.state?.length) {
    addTask(
      `Implement state management: ${parsed.data.state[0]}`,
      "Data",
      "high",
      tasks.filter(t => t.plane === "Foundation" || t.plane === "Data").map(t => t.id)
    );
  }

  // 3. Business tasks (High priority)
  if (parsed.business?.process?.length) {
    addTask(
      `Implement business process: ${parsed.business.process[0]}`,
      "Business",
      "high",
      tasks.filter(t => t.plane === "Data").map(t => t.id)
    );
  }

  if (parsed.business?.rules?.length) {
    addTask(
      `Implement business rules: ${parsed.business.rules[0]}`,
      "Business",
      "high",
      tasks.filter(t => t.plane === "Business").map(t => t.id)
    );
  }

  // 4. Control tasks (Medium priority)
  if (parsed.control?.strategy?.length) {
    addTask(
      `Implement control strategy: ${parsed.control.strategy[0]}`,
      "Control",
      "medium",
      tasks.filter(t => t.plane === "Business").map(t => t.id)
    );
  }

  if (parsed.control?.distribution?.length) {
    addTask(
      `Implement distribution: ${parsed.control.distribution[0]}`,
      "Control",
      "medium",
      tasks.filter(t => t.plane === "Control").map(t => t.id)
    );
  }

  // 5. Security tasks (Medium priority)
  if (parsed.security?.identity?.length) {
    addTask(
      `Implement authentication: ${parsed.security.identity[0]}`,
      "Security",
      "medium",
      tasks.filter(t => t.plane === "Foundation").map(t => t.id)
    );
  }

  if (parsed.security?.permissions?.length) {
    addTask(
      `Implement authorization: ${parsed.security.permissions[0]}`,
      "Security",
      "medium",
      tasks.filter(t => t.plane === "Security").map(t => t.id)
    );
  }

  // 6. Observation tasks (Low priority)
  if (parsed.observation?.data?.length) {
    addTask(
      `Add observability: ${parsed.observation.data[0]}`,
      "Observation",
      "low",
      tasks.filter(t => t.plane === "Business").map(t => t.id)
    );
  }

  if (parsed.observation?.analysis?.length) {
    addTask(
      `Setup analysis: ${parsed.observation.analysis[0]}`,
      "Observation",
      "low",
      tasks.filter(t => t.plane === "Observation").map(t => t.id)
    );
  }

  // 7. Evolution tasks (Low priority)
  if (parsed.evolution?.time?.length) {
    addTask(
      `Plan evolution timeline: ${parsed.evolution.time[0]}`,
      "Evolution",
      "low",
      []
    );
  }

  if (parsed.evolution?.change?.length) {
    addTask(
      `Setup versioning: ${parsed.evolution.change[0]}`,
      "Evolution",
      "low",
      tasks.filter(t => t.plane === "Evolution").map(t => t.id)
    );
  }

  // Ensure minimum tasks
  if (tasks.length === 0) {
    addTask("Analyze and implement core functionality", "Business", "high", []);
    addTask("Write unit tests", "Observation", "medium", [tasks[0].id]);
  }

  return tasks;
}

/**
 * Extract plan name from draft
 */
export function extractPlanName(content: string): string | null {
  const match = content.match(/^#\s*System Design:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Get MDD plane summary from draft
 */
export function getPlaneSummary(parsed: ParsedDraft): Record<MDDPlane, number> {
  const summary: Record<MDDPlane, number> = {
    Business: 0,
    Data: 0,
    Control: 0,
    Foundation: 0,
    Observation: 0,
    Security: 0,
    Evolution: 0,
  };

  if (parsed.business) {
    summary.Business = (parsed.business.process?.length || 0) + (parsed.business.rules?.length || 0);
  }
  if (parsed.data) {
    summary.Data = (parsed.data.logic?.length || 0) + (parsed.data.state?.length || 0);
  }
  if (parsed.control) {
    summary.Control = (parsed.control.strategy?.length || 0) + (parsed.control.distribution?.length || 0);
  }
  if (parsed.foundation) {
    summary.Foundation = (parsed.foundation.resource?.length || 0) + (parsed.foundation.abstraction?.length || 0);
  }
  if (parsed.observation) {
    summary.Observation = (parsed.observation.data?.length || 0) + (parsed.observation.analysis?.length || 0);
  }
  if (parsed.security) {
    summary.Security = (parsed.security.identity?.length || 0) + (parsed.security.permissions?.length || 0);
  }
  if (parsed.evolution) {
    summary.Evolution = (parsed.evolution.time?.length || 0) + (parsed.evolution.change?.length || 0);
  }

  return summary;
}

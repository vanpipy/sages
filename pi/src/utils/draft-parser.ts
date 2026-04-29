/**
 * Draft Parser - Extracts structured information from Eight Trigrams draft
 */

export interface ParsedDraft {
  name: string;
  intent: string;
  dataModels: string[];
  triggers: string[];
  dataFlow: string[];
  errorHandling: string[];
  boundaries: string[];
  successPath: string[];
}

const SECTION_PATTERNS = {
  intent: /## ☰ Qian.*?\n([\s\S]*?)(?=## |$)/i,
  dataModels: /## ☷ Kun.*?\n([\s\S]*?)(?=## |$)/i,
  triggers: /## ☳ Zhen.*?\n([\s\S]*?)(?=## |$)/i,
  dataFlow: /## ☴ Xun.*?\n([\s\S]*?)(?=## |$)/i,
  errorHandling: /## ☵ Kan.*?\n([\s\S]*?)(?=## |$)/i,
  successPath: /## ☱ Dui.*?\n([\s\S]*?)(?=## |$)/i,
  boundaries: /## ☶ Gen.*?\n([\s\S]*?)(?=## |$)/i,
};

function extractSection(content: string, pattern: RegExp): string[] {
  const match = content.match(pattern);
  if (!match) return [];
  
  // Extract bullet points and lines
  const lines = match[1]
    .split("\n")
    .map(l => l.replace(/^[\s-•*]+/, "").trim())
    .filter(l => l && !l.startsWith("{") && !l.includes("Define"));
  
  return lines;
}

function isPlaceholder(text: string): boolean {
  return text.includes("{") && text.includes("}") || 
         text.toLowerCase().includes("define") ||
         text.toLowerCase().includes("todo") ||
         text.toLowerCase().includes("tbd");
}

export function parseDraft(content: string, name: string): ParsedDraft | null {
  try {
    const intent = extractSection(content, SECTION_PATTERNS.intent);
    const dataModels = extractSection(content, SECTION_PATTERNS.dataModels);
    const triggers = extractSection(content, SECTION_PATTERNS.triggers);
    const dataFlow = extractSection(content, SECTION_PATTERNS.dataFlow);
    const errorHandling = extractSection(content, SECTION_PATTERNS.errorHandling);
    const boundaries = extractSection(content, SECTION_PATTERNS.boundaries);
    const successPath = extractSection(content, SECTION_PATTERNS.successPath);

    // Check if draft has meaningful content
    const allContent = [...intent, ...dataModels, ...triggers, ...dataFlow, ...errorHandling, ...boundaries, ...successPath];
    const hasRealContent = allContent.some(item => !isPlaceholder(item));

    if (!hasRealContent) {
      return null;
    }

    return {
      name,
      intent: intent.join(" "),
      dataModels,
      triggers,
      dataFlow,
      errorHandling,
      boundaries,
      successPath,
    };
  } catch {
    return null;
  }
}

export function validateDraft(content: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const sections = ["☰ Qian", "☷ Kun", "☳ Zhen", "☴ Xun", "☵ Kan", "☲ Li", "☶ Gen", "☱ Dui"];
  
  let filledSections = 0;
  for (const section of sections) {
    if (content.includes(section)) filledSections++;
  }

  if (filledSections < 5) {
    issues.push(`Only ${filledSections}/8 sections filled. Need at least 5.`);
  }

  // Check for placeholders
  const placeholderCount = (content.match(/\{[^}]+\}/g) || []).length;
  if (placeholderCount > 3) {
    issues.push(`Too many placeholders (${placeholderCount}). Replace with actual content.`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function generateTasksFromDraft(parsed: ParsedDraft): Array<{
  id: string;
  description: string;
  priority: "high" | "medium" | "low";
  dependsOn: string[];
}> {
  const tasks: Array<{
    id: string;
    description: string;
    priority: "high" | "medium" | "low";
    dependsOn: string[];
  }> = [];

  // Task 1: Requirements analysis (always first)
  if (parsed.intent) {
    tasks.push({
      id: "T1",
      description: `Analyze requirements: ${parsed.intent.slice(0, 100)}...`,
      priority: "high",
      dependsOn: [],
    });
  }

  // Task 2: Data model implementation
  if (parsed.dataModels.length > 0) {
    tasks.push({
      id: "T2",
      description: `Implement data models: ${parsed.dataModels.slice(0, 2).join(", ")}`,
      priority: "high",
      dependsOn: ["T1"],
    });
  }

  // Task 3: Core functionality
  if (parsed.dataFlow.length > 0) {
    tasks.push({
      id: "T3",
      description: `Implement core logic based on data flow: ${parsed.dataFlow[0] || "flow"}`,
      priority: "high",
      dependsOn: ["T1", "T2"].filter(id => tasks.some(t => t.id === id)),
    });
  }

  // Task 4: Error handling
  if (parsed.errorHandling.length > 0) {
    tasks.push({
      id: "T4",
      description: `Implement error handling: ${parsed.errorHandling[0] || "error cases"}`,
      priority: "medium",
      dependsOn: ["T3"],
    });
  }

  // Task 5: Testing
  tasks.push({
    id: "T5",
    description: "Write unit tests and verify implementation",
    priority: "medium",
    dependsOn: ["T3", "T4"].filter(id => tasks.some(t => t.id === id)),
  });

  // Task 6: Integration
  if (parsed.triggers.length > 0) {
    tasks.push({
      id: "T6",
      description: `Integrate with triggers: ${parsed.triggers[0] || "system"}`,
      priority: "medium",
      dependsOn: ["T5"],
    });
  }

  // Task 7: Boundary checks
  if (parsed.boundaries.length > 0) {
    tasks.push({
      id: "T7",
      description: `Implement boundary constraints: ${parsed.boundaries[0] || "limits"}`,
      priority: "low",
      dependsOn: ["T6"],
    });
  }

  return tasks;
}

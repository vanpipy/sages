import { tool } from "langchain";
import { z } from "zod";

export const gaoyaoTool = tool(
  ({ taskId, files, reviewMode }) => {
    // Mock implementation - returns PASS
    return JSON.stringify({
      verdict: "PASS",
      qualityScore: 95,
      issues: [],
      summary: `Review completed for task ${taskId}`,
    });
  },
  {
    name: "gaoyao_review",
    description: `GaoYao performs quality audit after task completion.

Review modes:
- quick: Check critical issues only (syntax, imports, types, security)
- full: Complete quality audit (code quality, coverage, performance, docs)

Returns verdict: PASS, NEEDS_CHANGES, or REJECTED
`,
    schema: z.object({
      taskId: z.string().describe("ID of the task to review"),
      files: z.array(z.string()).describe("Files modified by the task"),
      reviewMode: z.enum(["quick", "full"]).default("quick").describe("Review depth"),
    }),
  }
);

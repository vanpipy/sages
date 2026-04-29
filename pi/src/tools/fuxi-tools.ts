/**
 * Fuxi Tools - Design phase tools
 * Drafts are saved to .sages/workspace/draft.md
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMinimalDraft } from "../utils/draft-generator.js";

const WORKSPACE_DIR = ".sages/workspace";
const SESSIONS_DIR = ".sages/sessions";

function ensureWorkspaceDirs(cwd: string): string {
  const workspacePath = join(cwd, WORKSPACE_DIR);
  const sessionsPath = join(cwd, SESSIONS_DIR);
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }
  if (!existsSync(sessionsPath)) {
    mkdirSync(sessionsPath, { recursive: true });
  }
  return workspacePath;
}

export function registerFuxiTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fuxi_create_draft",
    label: "Create Draft",
    description: "Create architectural design drafts using Eight Trigrams and Multi-Dimensional Design methodology (saves to .sages/workspace/draft.md)",
    parameters: Type.Object({
      request: Type.String({ description: "User's request to analyze" }),
      name: Type.Optional(Type.String({ description: "Plan name (optional, derived from request)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { request, name } = params;

      try {
        const workspacePath = ensureWorkspaceDirs(cwd);
        const draftPath = join(workspacePath, "draft.md");

        const draft = generateMinimalDraft(name || "workflow", request);
        writeFileSync(draftPath, draft);

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, draft_path: draftPath, timestamp: new Date().toISOString() }) }],
          details: { draftPath, workspacePath },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });

  pi.registerTool({
    name: "fuxi_get_draft",
    label: "Get Draft",
    description: "Read the current draft from workspace",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Draft path (default: .sages/workspace/draft.md)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const draftPath = params.path || join(cwd, WORKSPACE_DIR, "draft.md");

      try {
        if (!existsSync(draftPath)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draftPath}` } }) }],
            isError: true,
            details: { draftPath },
          };
        }

        const content = readFileSync(draftPath, "utf-8");
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, path: draftPath, content }) }],
          details: { draftPath, contentLength: content.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });

  pi.registerTool({
    name: "fuxi_get_status",
    label: "Get Status",
    description: "Get the current workflow status from workspace",
    parameters: Type.Object({
      plan_name: Type.Optional(Type.String({ description: "Plan name (optional)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const workspacePath = join(cwd, WORKSPACE_DIR);

      try {
        const draftPath = join(workspacePath, "draft.md");
        const planPath = join(workspacePath, "plan.md");
        const executionPath = join(workspacePath, "execution.yaml");
        const tasksPath = join(workspacePath, "tasks.json");

        const hasDraft = existsSync(draftPath);
        const hasPlan = existsSync(planPath);
        const hasExecution = existsSync(executionPath);
        const hasTasks = existsSync(tasksPath);

        let status = "idle";
        let nextStep = "";

        if (hasDraft && !hasPlan) {
          status = "design";
          nextStep = "Use qiaochui_review then qiaochui_decompose";
        } else if (hasPlan && !hasExecution) {
          status = "plan";
          nextStep = "Ready for execution (awaiting approval)";
        } else if (hasExecution) {
          status = "ready";
          nextStep = "Use /fuxi-execute to run tasks";
        }

        let taskCount = 0;
        if (hasTasks) {
          try {
            const tasks = JSON.parse(readFileSync(tasksPath, "utf-8"));
            taskCount = Array.isArray(tasks) ? tasks.length : 0;
          } catch { /* ignore */ }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              status,
              workspace: workspacePath,
              has_draft: hasDraft,
              has_plan: hasPlan,
              has_execution: hasExecution,
              task_count: taskCount,
              next_step: nextStep,
            }),
          }],
          details: { status, hasDraft, hasPlan, hasExecution, taskCount },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });
}

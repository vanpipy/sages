/**
 * high-level/pipeline.ts - yunxiao_trigger_pipeline
 *
 * Trigger a Yunxiao pipeline run. Defaults to keyword "test" and current
 * git repo.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { McpServerManager } from "../../services/mcp-server-manager.js";
import { loadConfig } from "../../services/config.js";
import { execFileSync } from "node:child_process";

function getRepoName(): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" });
    const match = /\/([^/]+?)(?:\.git)?$/.exec(out.trim());
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function registerPipelineTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "yunxiao_trigger_pipeline",
    label: "Trigger Pipeline",
    description:
      "Trigger a Yunxiao pipeline run. Defaults to keyword 'test' and current git repo.",
    parameters: Type.Object({
      branch: Type.String({ description: "Git branch to build" }),
      pipelineKeyword: Type.Optional(Type.String({ default: "test" })),
      repositoryName: Type.Optional(Type.String({ description: "Defaults to current cwd's git remote" })),
    }),
    async execute(_id: any, params: any, _sig: any, _upd: any, _ctx: any) {
      const { branch, pipelineKeyword = "test", repositoryName } = params;
      const repo = repositoryName || getRepoName();
      if (!repo) {
        const data: any = { success: false, error: { code: "NO_REPO", message: "Cannot determine repository name" } };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      }

      const cfg = await loadConfig();
      const mgr = new McpServerManager(cfg);
      await mgr.ensureServer();

      try {
        // Step 1: Find pipeline matching keyword + repo
        const listRes = await fetch(`http://localhost:${cfg.port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name: "list_pipelines", arguments: { organizationId: cfg.token /* dummy */ } },
          }),
        });
        const listJson: any = await listRes.json();
        const pipelines = listJson.result?.pipelines || [];
        const matched = pipelines.find(
          (p: any) => p.name?.includes(repo) && p.name?.includes(pipelineKeyword),
        );
        if (!matched) {
          const data: any = {
            success: false,
            error: { code: "PIPELINE_NOT_FOUND", message: `No pipeline matching repo=${repo} keyword=${pipelineKeyword}` },
          };
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        }

        // Step 2: Trigger pipeline
        const triggerRes = await fetch(`http://localhost:${cfg.port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "create_pipeline_run",
              arguments: { pipelineId: matched.id, branch },
            },
          }),
        });
        const triggerJson: any = await triggerRes.json();
        if (triggerJson.error) {
          const data: any = { success: false, error: { code: "TRIGGER_FAILED", message: triggerJson.error.message } };
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        }
        const data: any = {
          success: true,
          pipeline: matched,
          branch,
          run: triggerJson.result,
        };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      } catch (e) {
        const data: any = { success: false, error: { message: (e as Error).message } };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      } finally {
        await mgr.touch();
      }
    },
  });
}

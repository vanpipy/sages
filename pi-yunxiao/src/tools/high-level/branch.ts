/**
 * high-level/branch.ts - yunxiao_create_branch
 *
 * Convenience wrapper around create_branch MCP tool.
 * Auto-resolves git remote to extract organizationId + repositoryId.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { McpServerManager } from "../../services/mcp-server-manager.js";
import { loadConfig } from "../../services/config.js";
import { execFileSync } from "node:child_process";

function getRemoteUrl(): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" });
    return out.trim();
  } catch {
    return null;
  }
}

function getCurrentBranch(): string {
  try {
    const out = execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" });
    return out.trim();
  } catch {
    return "master";
  }
}

export function registerBranchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "yunxiao_create_branch",
    label: "Create Branch",
    description:
      "Create a new git branch on Yunxiao Codeup. Auto-resolves the current git remote. Example: 'create feat/category from master'.",
    parameters: Type.Object({
      sourceBranch: Type.String({ description: "Source branch (e.g., 'master', 'sprint/20260611')" }),
      newBranch: Type.String({ description: "New branch name (e.g., 'feat/category')" }),
    }),
    async execute(_id: any, params: any, _sig: any, _upd: any, _ctx: any) {
      const { sourceBranch, newBranch } = params;
      const cfg = await loadConfig();
      const mgr = new McpServerManager(cfg);
      await mgr.ensureServer();

      const remote = getRemoteUrl() || "";
      const match = /^git@codeup\.aliyun\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(remote) ||
                   /^https?:\/\/codeup\.aliyun\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
      if (!match) {
        const data: any = {
          success: false,
          error: { code: "REMOTE_NOT_FOUND", message: `Cannot parse git remote URL: ${remote}` },
        };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      }
      const orgId = match[1];
      const repositoryId = `${orgId}%2F${match[2]}`;

      try {
        const res = await fetch(`http://localhost:${cfg.port}/mcp`, {
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
              name: "create_branch",
              // Schema: branch, organizationId, ref, repositoryId
              // (no sourceBranch, no repoName — see E2E test)
              arguments: { organizationId: orgId, repositoryId, ref: sourceBranch, branch: newBranch },
            },
          }),
        });
        const json: any = await res.json();
        const data: any = {
          success: !json.error,
          branch: newBranch,
          ref: sourceBranch,
          repo: `${orgId}/${match[2]}`,
          result: json.result,
          error: json.error,
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

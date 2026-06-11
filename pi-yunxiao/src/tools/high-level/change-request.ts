/**
 * high-level/change-request.ts - yunxiao_create_mr
 *
 * Create a merge request. Auto-extracts work item from source branch name
 * (e.g., fix/WBGA-4215 → WBGA-4215) and links to the work item.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { McpServerManager } from "../../services/mcp-server-manager.js";
import { loadConfig } from "../../services/config.js";
import { lookupReviewerUserIds } from "./_lookups.js";
import { execFileSync } from "node:child_process";

function getCurrentBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function getRemoteUrl(): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

export function registerChangeRequestTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "yunxiao_create_mr",
    label: "Create Merge Request",
    description:
      "Create a merge request on Yunxiao Codeup. Auto-detects current branch and remote. Auto-links to work item if branch name has fix/feat/chore prefix.",
    parameters: Type.Object({
      projectCode: Type.String({ description: "Project prefix (for work item association)" }),
      title: Type.String({ description: "MR title" }),
      sourceBranch: Type.Optional(Type.String({ description: "Defaults to current git branch" })),
      targetBranch: Type.Optional(Type.String({ default: "master" })),
      reviewers: Type.Optional(Type.Array(Type.String(), { description: "Array of usernames" })),
    }),
    async execute(_id: any, params: any, _sig: any, _upd: any, _ctx: any) {
      const { projectCode, title, sourceBranch, targetBranch = "master", reviewers } = params;
      const srcBranch = sourceBranch || getCurrentBranch();
      if (!srcBranch) {
        const data: any = { success: false, error: { code: "NO_SOURCE_BRANCH", message: "Cannot determine source branch" } };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      }

      // Auto-extract work item from branch name
      const wiMatch = /^(?:fix|feat|chore)\/([A-Z]+-\d+)/.exec(srcBranch);
      const workItemId = wiMatch ? wiMatch[1] : null;

      const remote = getRemoteUrl() || "";
      const match = /^git@codeup\.aliyun\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(remote) ||
                   /^https?:\/\/codeup\.aliyun\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
      if (!match) {
        const data: any = { success: false, error: { code: "REMOTE_NOT_FOUND", message: `Cannot parse git remote: ${remote}` } };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      }
      const orgId = match[1];
      const repositoryId = `${orgId}%2F${match[2]}`;

      const cfg = await loadConfig();
      const mgr = new McpServerManager(cfg);
      await mgr.ensureServer();

      try {
        // Look up reviewer user IDs (cached) if reviewers specified
        const reviewerUserIds = reviewers && reviewers.length > 0
          ? await lookupReviewerUserIds(reviewers)
          : undefined;

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
              name: "create_change_request",
              arguments: {
                organizationId: orgId,
                repositoryId,
                title,
                sourceBranch: srcBranch,
                targetBranch,
                reviewerUserIds,  // E2E test caught: was 'reviewers' (usernames)
                workItemIds: workItemId ? [workItemId] : undefined,
              },
            },
          }),
        });
        const json: any = await res.json();
        if (json.error) {
          const data: any = { success: false, error: { code: "MR_FAILED", message: json.error.message } };
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        }
        const data: any = {
          success: true,
          mr: json.result,
          sourceBranch: srcBranch,
          targetBranch,
          workItemId,
          reviewers: reviewers || [],
          reviewerUserIds: reviewerUserIds || [],
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

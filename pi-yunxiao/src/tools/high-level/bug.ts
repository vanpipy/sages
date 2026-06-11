/**
 * high-level/bug.ts - yunxiao_create_bug
 *
 * Create a bug/defect work item.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { McpServerManager } from "../../services/mcp-server-manager.js";
import { loadConfig } from "../../services/config.js";
import { lookupWorkItemTypeId } from "./_lookups.js";

export function registerBugTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "yunxiao_create_bug",
    label: "Create Bug",
    description: "Create a bug/defect work item in Yunxiao.",
    parameters: Type.Object({
      projectCode: Type.String({ description: "Project prefix" }),
      subject: Type.String({ description: "Bug title" }),
      assignee: Type.Optional(Type.String()),
      baseBranch: Type.Optional(Type.String({ description: "If provided, also create fix/{serial} branch" })),
    }),
    async execute(_id: any, params: any, _sig: any, _upd: any, _ctx: any) {
      const { projectCode, subject, assignee, baseBranch } = params;
      const cfg = await loadConfig();
      const mgr = new McpServerManager(cfg);
      await mgr.ensureServer();

      try {
        // Look up workitemTypeId for "Bug" (cached)
        const typeId = await lookupWorkItemTypeId(projectCode, "Bug");

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
              name: "create_work_item",
              arguments: {
                spaceId: projectCode,
                subject,
                workitemTypeId: typeId,  // E2E test caught: was 'workItemType: "Bug"'
                assignedTo: assignee,
              },
            },
          }),
        });
        const json: any = await res.json();
        if (json.error) {
          const data: any = { success: false, error: { code: "BUG_FAILED", message: json.error.message } };
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        }
        const serialNumber = json.result?.serialNumber || json.result?.id;
        const branchName = baseBranch && serialNumber ? `fix/${serialNumber}` : null;
        const data: any = { success: true, bug: json.result, serialNumber, branch: branchName };
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

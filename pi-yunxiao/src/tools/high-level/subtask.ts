/**
 * high-level/subtask.ts - yunxiao_create_subtask
 *
 * Create a subtask under a parent work item.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { McpServerManager } from "../../services/mcp-server-manager.js";
import { loadConfig } from "../../services/config.js";
import { lookupWorkItemTypeId } from "./_lookups.js";

export function registerSubtaskTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "yunxiao_create_subtask",
    label: "Create Subtask",
    description: "Create a subtask under a parent work item in Yunxiao.",
    parameters: Type.Object({
      parentWorkItemId: Type.String({ description: "Parent task serial (e.g., 'WBGA-4042')" }),
      subject: Type.String({ description: "Subtask title" }),
      assignee: Type.Optional(Type.String()),
      baseBranch: Type.Optional(Type.String({ description: "If provided, also create feat/{serial} branch" })),
    }),
    async execute(_id: any, params: any, _sig: any, _upd: any, _ctx: any) {
      const { parentWorkItemId, subject, assignee, baseBranch } = params;
      const cfg = await loadConfig();
      const mgr = new McpServerManager(cfg);
      await mgr.ensureServer();

      try {
        // Step 1: Get parent work item to find spaceId
        const parentRes = await fetch(`http://localhost:${cfg.port}/mcp`, {
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
            params: { name: "get_work_item", arguments: { workItemId: parentWorkItemId } },
          }),
        });
        const parentJson: any = await parentRes.json();
        if (parentJson.error) {
          const data: any = { success: false, error: { code: "PARENT_NOT_FOUND", message: parentJson.error.message } };
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        }
        const spaceId = parentJson.result?.spaceId;

        // Step 2: Look up workitemTypeId for "SubTask" (cached)
        const typeId = await lookupWorkItemTypeId(spaceId, "SubTask");

        // Step 3: Create subtask
        const subRes = await fetch(`http://localhost:${cfg.port}/mcp`, {
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
                spaceId,
                parentId: parentWorkItemId,
                subject,
                workitemTypeId: typeId,  // E2E test caught: was 'workItemType: "SubTask"'
                assignedTo: assignee,
              },
            },
          }),
        });
        const subJson: any = await subRes.json();
        if (subJson.error) {
          const data: any = { success: false, error: { code: "SUBTASK_FAILED", message: subJson.error.message } };
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        }
        const serialNumber = subJson.result?.serialNumber || subJson.result?.id;
        const branchName = baseBranch && serialNumber ? `feat/${serialNumber}` : null;

        const data: any = {
          success: true,
          parent: parentWorkItemId,
          subtask: subJson.result,
          serialNumber,
          branch: branchName,
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

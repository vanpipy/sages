/**
 * high-level/task.ts - yunxiao_create_task
 *
 * Create an independent task work item (no parent).
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { McpServerManager } from "../../services/mcp-server-manager.js";
import { loadConfig } from "../../services/config.js";

export function registerTaskTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "yunxiao_create_task",
    label: "Create Task",
    description: "Create an independent task work item in Yunxiao.",
    parameters: Type.Object({
      projectCode: Type.String({ description: "Project prefix (e.g., 'WBGA')" }),
      subject: Type.String({ description: "Task title" }),
      assignee: Type.Optional(Type.String({ description: "Username; defaults to current user" })),
      estimatedHours: Type.Optional(Type.Number({ description: "Estimated hours" })),
      baseBranch: Type.Optional(Type.String({ description: "If provided, also create feat/{serial} branch" })),
    }),
    async execute(_id: any, params: any, _sig: any, _upd: any, _ctx: any) {
      const { projectCode, subject, assignee, estimatedHours, baseBranch } = params;
      const cfg = await loadConfig();
      const mgr = new McpServerManager(cfg);
      await mgr.ensureServer();

      try {
        // Step 1: Create work item
        const wiRes = await fetch(`http://localhost:${cfg.port}/mcp`, {
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
                workItemType: "Task",
                assignedTo: assignee,
                customFieldValues: estimatedHours ? { estimatedHours } : undefined,
              },
            },
          }),
        });
        const wiJson: any = await wiRes.json();
        if (wiJson.error) {
          const data: any = { success: false, error: { code: "WORK_ITEM_FAILED", message: wiJson.error.message } };
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        }
        const workItem = wiJson.result;
        const serialNumber = workItem?.serialNumber || workItem?.id;

        // Step 2: Optionally create branch
        let branchName: string | null = null;
        if (baseBranch && serialNumber) {
          branchName = `feat/${serialNumber}`;
          // TODO: call create_branch
        }

        const data: any = {
          success: true,
          workItem,
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

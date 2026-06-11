/**
 * mcp-call.ts - L1 escape hatch tools
 *
 * 2 tools:
 * - yunxiao_list_tools: discover the 53 official MCP tools (with schemas)
 * - yunxiao_mcp_call: directly call any official tool (per-request token override)
 */

import { Type } from "typebox";
import { McpClient } from "../services/mcp-client.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerL1Tools(pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // yunxiao_list_tools
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "yunxiao_list_tools",
    label: "List MCP Tools",
    description:
      "List the 53 official Yunxiao MCP tools with their input schemas. Use yunxiao_mcp_call to invoke any of them.",
    parameters: Type.Object({
      category: Type.Optional(Type.Union([
        Type.Literal("code"),
        Type.Literal("project"),
        Type.Literal("pipeline"),
        Type.Literal("artifact"),
        Type.Literal("org"),
        Type.Literal("all"),
      ], { default: "all" })),
    }),
    async execute(toolCallId: any, _params: any, _signal: any, _onUpdate: any, _ctx: any) {
      const client = await McpClient.getInstance();
      try {
        const result = await client.call("tools/list", {});
        const data: any = { success: true, tools: result?.result?.tools || [] };
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (e) {
        const data = { success: false, error: { message: (e as Error).message } };
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // yunxiao_mcp_call
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "yunxiao_mcp_call",
    label: "Call MCP Tool",
    description:
      "Direct JSON-RPC call to any official Yunxiao MCP tool. Use yunxiao_list_tools to discover tool names. Use overrideToken to switch accounts per-request.",
    parameters: Type.Object({
      tool: Type.String({ description: "Official tool name (e.g., 'get_branch', 'create_work_item')" }),
      arguments: Type.Record(Type.String(), Type.Unknown(), {
        description: "Tool arguments as JSON object",
      }),
      overrideToken: Type.Optional(Type.String({
        description: "Per-request token override (for multi-account scenarios)",
      })),
    }),
    async execute(toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      const { tool, arguments: args, overrideToken } = params;
      const client = await McpClient.getInstance();
      try {
        const result = await client.call("tools/call", { name: tool, arguments: args }, { tokenOverride: overrideToken });
        const data: any = { success: true, tool, result };
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (e) {
        const data = { success: false, error: { message: (e as Error).message } };
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      }
    },
  });
}

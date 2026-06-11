/**
 * mcp-server.ts - L0 lifecycle tools
 *
 * 4 tools:
 * - yunxiao_mcp_install: install alibabacloud-devops-mcp-server globally
 * - yunxiao_mcp_start: start the HTTP sidecar (idempotent)
 * - yunxiao_mcp_stop: stop the sidecar
 * - yunxiao_mcp_status: query state
 */

import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServerManager } from "../services/mcp-server-manager.js";
import { loadConfig } from "../services/config.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

export function registerL0Tools(pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // yunxiao_mcp_install
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "yunxiao_mcp_install",
    label: "Install MCP Server",
    description:
      "Install alibabacloud-devops-mcp-server globally via npm. One-time setup to accelerate cold start from ~5s to <1s.",
    parameters: Type.Object({}),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      try {
        const which = await execFileAsync("which", ["alibabacloud-devops-mcp-server"]).catch(() => null);
        const data: any = which?.stdout
          ? { success: true, alreadyInstalled: true, path: which.stdout.trim() }
          : await (async () => {
              const cwd = ctx.cwd || process.cwd();
              await execFileAsync("npm", ["install", "-g", "alibabacloud-devops-mcp-server"], { cwd });
              return { success: true, installed: true };
            })();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (e) {
        const data = { success: false, error: { code: "INSTALL_FAILED", message: (e as Error).message } };
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // yunxiao_mcp_start
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "yunxiao_mcp_start",
    label: "Start MCP Server",
    description: "Start the Yunxiao MCP HTTP sidecar. Idempotent.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Force restart even if running" })),
    }),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const cfg = await loadConfig();
      const mgr = createManager(cfg);
      const status = await mgr.ensureServer();
      const data = { success: true, ...status };
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        details: data,
      };
    },
  });

  // -------------------------------------------------------------------------
  // yunxiao_mcp_stop
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "yunxiao_mcp_stop",
    label: "Stop MCP Server",
    description: "Stop the Yunxiao MCP HTTP sidecar gracefully.",
    parameters: Type.Object({}),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const cfg = await loadConfig();
      const mgr = createManager(cfg);
      const result = await mgr.stop();
      const data = { success: true, ...result };
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        details: data,
      };
    },
  });

  // -------------------------------------------------------------------------
  // yunxiao_mcp_status
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "yunxiao_mcp_status",
    label: "MCP Server Status",
    description: "Query the Yunxiao MCP sidecar state: installed, running, healthy, PID, last used.",
    parameters: Type.Object({}),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const cfg = await loadConfig();
      const mgr = createManager(cfg);
      const status = await mgr.status();
      const data = { success: true, ...status };
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        details: data,
      };
    },
  });
}

function createManager(cfg: Awaited<ReturnType<typeof loadConfig>>): McpServerManager {
  return new McpServerManager(cfg);
}

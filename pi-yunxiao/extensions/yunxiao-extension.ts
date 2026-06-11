/**
 * yunxiao-extension.ts - pi extension entry point
 *
 * Mirrors sages-extension.ts pattern: registerTool + intercept pattern
 * (for /yunxiao-* slash commands to bypass non-existent pi.callTool).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerYunxiaoTools } from "../src/tools/index.js";

const toolExecutors: Map<string, Function> = new Map();

async function callToolDirect(
  toolName: string,
  params: Record<string, unknown>,
  cwd: string,
  onUpdate?: (msg: { content: { type: string; text: string }[] }) => void | Promise<void>,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean; details?: unknown }> {
  const executor = toolExecutors.get(toolName);
  if (!executor) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Tool ${toolName} not found` } }) }],
      isError: true,
    };
  }
  try {
    return await (executor as Function).call(
      null,
      `cmd-${Date.now()}`,
      params,
      new AbortController().signal,
      onUpdate || (() => {}),
      { cwd },
    );
  } catch (e) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: (e as Error).message } }) }],
      isError: true,
    };
  }
}

export default function (pi: ExtensionAPI): void {
  // Intercept registerTool to capture executors for /yunxiao-* commands
  const originalRegisterTool = pi.registerTool.bind(pi);
  pi.registerTool = function (tool: any) {
    if (tool && tool.name && typeof tool.execute === "function") {
      toolExecutors.set(tool.name, tool.execute);
    }
    return originalRegisterTool(tool);
  } as any;

  // Register all yunxiao tools
  registerYunxiaoTools(pi);

  // Restore original registerTool (so other packages don't get intercepted)
  pi.registerTool = originalRegisterTool;

  // Register chat commands for quick access
  const commands: Array<[string, string, string]> = [
    ["yunxiao-start", "Start MCP server", "yunxiao_mcp_start"],
    ["yunxiao-stop", "Stop MCP server", "yunxiao_mcp_stop"],
    ["yunxiao-status", "MCP server status", "yunxiao_mcp_status"],
  ];

  for (const [cmd, _desc, toolName] of commands) {
    pi.registerCommand(cmd, {
      description: _desc,
      handler: async (args: string, ctx: { cwd: string }) => {
        const params = args ? JSON.parse(args) : {};
        const result = await callToolDirect(toolName, params, ctx.cwd);
        if (result.content[0]?.text) {
          console.log(result.content[0].text);
        }
        if (result.isError) {
          console.error(`[${cmd}] failed`);
        }
      },
    });
  }
}

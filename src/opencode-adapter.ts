import type { Tool } from "deepagents";
import { fuxiAgent } from "./deepagents/fuxi-agent.js";

/**
 * OpenCode Adapter
 *
 * Thin layer that exposes deepagents tools to the OpenCode plugin system.
 * This is the only file that knows about both OpenCode and deepagents.
 */

export async function getSagesTools(): Promise<Tool[]> {
  // deepagents agent exposes its tools via .tools property
  return fuxiAgent.tools;
}

export async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { sessionId: string; messageId: string; agent: string }
): Promise<string> {
  // Delegate to deepagents agent's tool execution
  const result = await fuxiAgent.invokeTool(toolName, args, context);
  return JSON.stringify(result);
}

export { fuxiAgent };

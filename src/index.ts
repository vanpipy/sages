/**
 * OpenCode Sages Plugin
 *
 * Four Divine Agents: Fuxi, QiaoChui, LuBan, GaoYao
 * Powered by deepagents v1.9.0
 */

import type { Plugin } from "@opencode-ai/plugin";
import { getSagesTools, invokeTool } from "./opencode-adapter.js";

// Re-export for backward compatibility
export { fuxiAgent } from "./opencode-adapter.js";

const plugin: Plugin = {
  name: "sages",
  version: "1.0.0",

  async tools() {
    return getSagesTools();
  },

  async invokeTool(toolName: string, args: Record<string, unknown>, context) {
    return invokeTool(toolName, args, context);
  },

  hooks: {
    onLoad: async () => {
      console.log("Sages plugin loaded with deepagents");
    },
  },
};

export default plugin;

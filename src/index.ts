/**
 * OpenCode Sages Plugin
 *
 * Four Sages Agents: Fuxi, QiaoChui, LuBan, GaoYao
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { getSagesTools, invokeTool } from "./opencode-adapter.js";

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  return {
    tool: {}, // Tools are registered through the adapter
  };
};

export default plugin;

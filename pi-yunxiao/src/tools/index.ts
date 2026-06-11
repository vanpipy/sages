/**
 * tools/index.ts - Public registration entry point for all yunxiao tools.
 *
 * Called from extensions/yunxiao-extension.ts via registerYunxiaoTools(pi).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerL0Tools } from "./mcp-server.js";
import { registerL1Tools } from "./mcp-call.js";
import { registerBranchTool } from "./high-level/branch.js";
import { registerTaskTool } from "./high-level/task.js";
import { registerSubtaskTool } from "./high-level/subtask.js";

export function registerYunxiaoTools(pi: ExtensionAPI): void {
  registerL0Tools(pi);
  registerL1Tools(pi);
  // L2 wrappers
  registerBranchTool(pi);
  registerTaskTool(pi);
  registerSubtaskTool(pi);
  // T8: bug, change-request, pipeline
}

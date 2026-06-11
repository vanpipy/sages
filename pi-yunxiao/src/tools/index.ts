/**
 * tools/index.ts - Public registration entry point for all yunxiao tools.
 *
 * Called from extensions/yunxiao-extension.ts via registerYunxiaoTools(pi).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerL0Tools } from "./mcp-server.js";

export function registerYunxiaoTools(pi: ExtensionAPI): void {
  registerL0Tools(pi);
  // L1 and L2 tools will be added in T6/T7/T8
}

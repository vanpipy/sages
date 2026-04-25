import { createDeepAgent } from "deepagents";
import { sagesBackend } from "./backend.js";
import { fuxiSystemPrompt } from "./prompts/fuxi-prompt.js";
import { qiaoChuiSubAgent } from "./qiaochui-subagent.js";
import { lubanSubAgent } from "./luban-subagent.js";
import { gaoyaoTool } from "./tools/gaoyao-tool.js";

export const fuxiAgent = createDeepAgent({
  model: process.env.DEEPMODEL || "claude-sonnet-4-20250514",
  tools: [gaoyaoTool],  // GaoYao as custom tool
  subagent: [qiaoChuiSubAgent, lubanSubAgent],  // Real subagents
  backend: sagesBackend,
  systemPrompt: fuxiSystemPrompt,
});
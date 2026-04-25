import { lubanSystemPrompt } from "./prompts/luban-prompt.js";

export const lubanSubAgent = {
  name: "luban",
  description: "Master Craftsman - Executes tasks with TDD methodology",
  systemPrompt: lubanSystemPrompt,
};

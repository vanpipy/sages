import { qiaoChuiSystemPrompt } from "./prompts/qiaoChui-prompt.js";

export const qiaoChuiSubAgent = {
  name: "qiaochui",
  description: "Divine Mechanist - Reviews designs, decomposes tasks into executable plans",
  systemPrompt: qiaoChuiSystemPrompt,
};

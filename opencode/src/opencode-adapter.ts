import * as fuxiTools from "./tools/fuxi-tools.js";
import * as qiaochuiTools from "./tools/qiaochui-tools.js";
import * as lubanTools from "./tools/luban-tools.js";
import * as gaoyaoTools from "./tools/gaoyao-tools.js";
import * as workflowTools from "./tools/workflow-tools.js";

/**
 * OpenCode Adapter
 *
 * Thin layer that exposes Sages tools to the OpenCode plugin system.
 */

// Tool type matching the opencode plugin system
interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<string>;
}

function extractTools(module: Record<string, unknown>): Tool[] {
  return Object.values(module).filter(
    (obj): obj is Tool => typeof obj === "object" && obj !== null && "name" in obj && "execute" in obj
  );
}

export async function getSagesTools(): Promise<Tool[]> {
  const fuxiAgentTools = extractTools(fuxiTools);
  const qiaochuiAgentTools = extractTools(qiaochuiTools);
  const lubanAgentTools = extractTools(lubanTools);
  const gaoyaoAgentTools = extractTools(gaoyaoTools);
  const workflowAgentTools = extractTools(workflowTools);

  return [
    ...fuxiAgentTools,
    ...qiaochuiAgentTools,
    ...lubanAgentTools,
    ...gaoyaoAgentTools,
    ...workflowAgentTools,
  ];
}

export async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { sessionId: string; messageId: string; agent: string }
): Promise<string> {
  return JSON.stringify({ error: "Tool invocation not implemented" });
}



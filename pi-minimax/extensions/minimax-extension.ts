/**
 * minimax-extension.ts — pi extension entry point.
 *
 * Mirrors sages-extension / yunxiao-extension pattern: registerTool + slash commands.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerMinimaxTools } from "../src/tools/index.js";

export default function (pi: ExtensionAPI): void {
    // Register all 3 minimax tools
    registerMinimaxTools(pi);

    // Slash commands for quick access (mirrors yunxiao pattern)
    const commands: Array<[string, string]> = [
        ["minimax-auth-status", "Show mmx authentication state"],
        ["minimax-search", "Web search via mmx (usage: /minimax-search <query>)"],
    ];

    for (const [name, description] of commands) {
        pi.registerCommand(name, {
            description,
            handler: async (args: string) => {
                // Lightweight command shell: print a hint to use the tool directly
                console.log(`[${name}] Use the corresponding minimax_* tool with appropriate params.`);
                if (args) {
                    console.log(`  args: ${args}`);
                }
                console.log(`  description: ${description}`);
            },
        });
    }
}

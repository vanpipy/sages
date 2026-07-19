/**
 * sages_search — AFT-backed project-wide regex search.
 *
 * Uses AFT's trigram-indexed grep. Faster than shell `grep -r` on large repos.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor, ensureReady } from "../aft/index.js";

export function registerSagesSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_search",
		label: "sages_search",
		description:
			"Search across the project for a regex pattern. Trigram-indexed, fast on large repos. Returns matches with file path, line number, and line context.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex or string to search for" }),
			path: Type.Optional(Type.String({ description: "Restrict search to this path (default: project root)" })),
			max: Type.Optional(Type.Number({ description: "Max matches to return (default: 50)" })),
		}),
		async execute(_id, params) {
			const projectRoot = params.path && params.path !== "." ? process.cwd() : process.cwd();
			try {
				await ensureReady(projectRoot);
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `[AFT] not ready: ${(err as Error).message}. Run \`aft configure\` or check ~/.config/cortexkit/aft.jsonc.`,
					}],
					isError: true,
					details: {},
				};
			}
			const bridge = bridgeFor();
			const result = await bridge.grep(params.pattern, params.path ?? ".", {
				max: params.max,
			});
			return {
				content: [{ type: "text", text: result.text || "(no matches)" }],
				details: {},
			};
		},
	});
}

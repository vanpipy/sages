/**
 * sages_read_file — AFT-backed file reader.
 *
 * Calls aft.bridge.read with optional offset/limit. Returns text content
 * in pi-tool-call shape.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor, ensureReady } from "../aft/index.js";

export function registerSagesReadFile(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_read_file",
		label: "sages_read_file",
		description:
			"Read file contents with line numbers. AFT-backed (faster on large repos). Supports offset/limit for large files.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute or project-relative file path" }),
			offset: Type.Optional(Type.Number({ description: "1-based start line (inclusive)" })),
			limit: Type.Optional(Type.Number({ description: "Max lines to return" })),
		}),
		async execute(_id, params) {
			try {
				await ensureReady(process.cwd());
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
			const result = await bridge.read(params.path, {
				offset: params.offset,
				limit: params.limit,
			});
			return {
				content: [{ type: "text", text: result.content }],
				details: {},
			};
		},
	});
}

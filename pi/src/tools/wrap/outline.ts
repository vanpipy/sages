/**
 * sages_outline — AFT-backed file structure overview.
 *
 * Returns the AFT-formatted outline with `E fn` (exported) / `- fn` (private)
 * markers and line ranges. One call instead of reading the whole file.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor } from "../aft/index.js";

export function registerSagesOutline(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_outline",
		label: "sages_outline",
		description:
			"Show every symbol in a file with name, kind, visibility, and line range. Use to understand a file's structure without scrolling.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to outline" }),
		}),
		async execute(_id, params) {
			const bridge = bridgeFor();
			const result = await bridge.outline(params.path);
			return {
				content: [{ type: "text", text: result.text || "(empty)" }],
				details: {},
			};
		},
	});
}

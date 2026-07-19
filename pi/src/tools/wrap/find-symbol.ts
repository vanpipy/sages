/**
 * sages_find_symbol — AFT-backed symbol body retrieval.
 *
 * Returns the named symbol with docstring + annotations. AFT equivalent of
 * LSP "go to definition" + "show hover" in one call.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor } from "../aft/index.js";

export function registerSagesFindSymbol(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_find_symbol",
		label: "sages_find_symbol",
		description:
			"Find a named symbol (function, class, type, variable) in a file and return its body with line range. Add callgraph: true to see what it calls and what calls it.",
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			symbol: Type.String({ description: "Symbol name to find" }),
			callgraph: Type.Optional(Type.Boolean({ description: "Include call graph annotations" })),
		}),
		async execute(_id, params) {
			const bridge = bridgeFor();
			const result = await bridge.zoom(params.path, params.symbol, {
				callgraph: params.callgraph,
			});
			// build a sage-friendly text-form representation
			const ann = result.annotations;
			const callsOut = ann.calls_out.length ? `\n  calls: ${ann.calls_out.join(", ")}` : "";
			const calledBy = ann.called_by.length ? `\n  called by: ${ann.called_by.join(", ")}` : "";
			const header =
				`${params.symbol} [${result.kind}] lines ${result.range.start_line}:${result.range.end_line}` +
				callsOut +
				calledBy;
			return {
				content: [
					{ type: "text", text: header },
					{ type: "text", text: result.content },
				],
			details: {},

			};
		},
	});
}

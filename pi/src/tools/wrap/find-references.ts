/**
 * sages_find_references — AFT-backed reference finder with warmup retry.
 *
 * Returns a sage-shaped "building" response when AFT's callgraph is still
 * indexing (which takes 30-60s on first configure). The agent can retry
 * after the suggested delay.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor, CallgraphBuildingError } from "../aft/index.js";

export function registerSagesFindReferences(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_find_references",
		label: "sages_find_references",
		description:
			"Find references to a symbol across the workspace (callers, importers, test usages). AFT-back-graph + tree-sitter. May return a 'building' status if AFT's callgraph is still indexing — wait the suggested retry_after_ms and call again.",
		parameters: Type.Object({
			path: Type.String({ description: "File path containing the symbol" }),
			symbol: Type.String({ description: "Symbol to find references for" }),
			direction: Type.Optional(
				Type.Union(
					[
						Type.Literal("inbound"),
						Type.Literal("outbound"),
					],
					{ default: "inbound", description: "inbound: who calls/uses this; outbound: what this calls/uses" },
				),
			),
		}),
		async execute(_id, params) {
			const bridge = bridgeFor();
			try {
				const result = await bridge.callgraph(
					params.path,
					params.symbol,
					params.direction ?? "inbound",
				);
				const formatted = result.references
					.map((r) => `${r.file}:${r.line ?? "?"}`)
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text: formatted || `(no ${params.direction ?? "inbound"} references found)`,
						},
					],
				details: {},

				};
			} catch (err) {
				if (err instanceof CallgraphBuildingError) {
					// Graceful degradation per design §C2
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: "building",
									hint: "AFT callgraph is still indexing; please retry after the suggested delay",
									retry_after_ms: 30_000,
									symbol: params.symbol,
									path: params.path,
								}),
							},
						],
					details: {},

					};
				}
				throw err;
			}
		},
	});
}

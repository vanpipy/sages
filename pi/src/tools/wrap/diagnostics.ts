/**
 * sages_diagnostics — AFT-backed code health report.
 *
 * Wraps aft.bridge.inspect which returns duplicates, dead code, unused exports,
 * TODOs, and (when LSP available) diagnostics. Per the design, this is
 * project-wide; for file-specific diagnostics use bridge directly or LSP tools.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor } from "../aft/index.js";

export function registerSagesDiagnostics(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_diagnostics",
		label: "sages_diagnostics",
		description:
			"Run a code-health inspection across the project. Reports duplicates, dead code, unused exports, TODOs, and (if LSP servers are configured) per-file diagnostics.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Restrict to a path (default: project root)" })),
		}),
		async execute(_id, params) {
			const bridge = bridgeFor();
			const result = await bridge.inspect(params.path ?? ".");
			return {
				content: [{ type: "text", text: result.text || "(no findings)" }],
				details: {},
			};
		},
	});
}

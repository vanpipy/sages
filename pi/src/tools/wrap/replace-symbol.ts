/**
 * sages_replace_symbol — AFT-backed symbol body replacement WITH safety snapshot.
 *
 * Like sages_write_file but operates on a symbol-by-symbol basis. Uses
 * AFT's edit command (which under the hood is a tree-sitter-validated
 * find/replace anchored at the symbol boundary).
 *
 * Always snapshots first.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor, snapshot } from "../aft/index.js";

export function registerSagesReplaceSymbol(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_replace_symbol",
		label: "sages_replace_symbol",
		description:
			"Replace the body of a named symbol in a file. Uses AFT's tree-sitter-validated edit (no manual line counting). ALWAYS snapshots first; returns snapshot_path + aft_backup_id.",
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			symbol: Type.String({ description: "Symbol whose body to replace" }),
			new_body: Type.String({ description: "New body (signature NOT included — the symbol name + body only)" }),
			project_root: Type.Optional(Type.String({ description: "Project root (defaults to cwd)" })),
		}),
		async execute(_id, params) {
			const projectRoot = params.project_root ?? process.cwd();
			// 1. Read the current body via zoom to get the signature + anchor
			const bridge = bridgeFor();
			const current = await bridge.zoom(params.path, params.symbol);
			const oldBody = current.content;

			// 2. Snapshot the file (safety net, even if AFT edit succeeds)
			const snap = snapshot(projectRoot, params.path);

			// 3. Do the edit via AFT — uses tree-sitter find/replace under the hood
			const result = await bridge.edit(params.path, oldBody, params.new_body);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							path: params.path,
							symbol: params.symbol,
							syntax_valid: result.syntax_valid,
							snapshot_path: snap.snapshot_path,
							snapshot_id: snap.snapshot_id,
							aft_backup_id: result.backup_id,
						}),
					},
				],
			details: {},

			};
		},
	});
}

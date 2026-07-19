/**
 * sages_insert_after_symbol — AFT has no direct equivalent of LSP's
 * "insert text after this symbol"; closest is a find/replace anchored at
 * the symbol's closing boundary.
 *
 * Strategy:
 *   1. Zoom the target symbol to get its body
 *   2. Compute the anchor = last non-empty token of the body (typically "}" or a return statement)
 *   3. Edit = "anchor + '\n\n' + newContent"
 *   4. If no anchor found (single-line body with no closing brace), fall back
 *      to appending AFTER the symbol's last line using write+rewrite
 *
 * ALWAYS snapshots first.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor, snapshot } from "../aft/index.js";

function findAnchor(body: string): string {
	// Strip docstring first
	const lines = body.split("\n");
	const codeLines = lines.filter((l) => !l.trim().startsWith("*"));
	const last = codeLines[codeLines.length - 1]?.trim() ?? "";
	if (last === "}" || last.endsWith("}")) return last;
	// Fallback: just the last non-empty trimmed line
	return codeLines.filter((l) => l.trim().length > 0).pop()?.trim() ?? "";
}

export function registerSagesInsertAfterSymbol(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_insert_after_symbol",
		label: "sages_insert_after_symbol",
		description:
			"Insert new content AFTER a named symbol in a file. Anchors at the symbol's closing boundary (usually the closing }) and uses AFT's tree-sitter-validated edit. ALWAYS snapshots first. Use this when you need to add code without overwriting anything.",
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			symbol: Type.String({ description: "Symbol to insert after" }),
			new_content: Type.String({ description: "New content to insert (separate with blank lines if multi-statement)" }),
			project_root: Type.Optional(Type.String({ description: "Project root (defaults to cwd)" })),
		}),
		async execute(_id, params) {
			const projectRoot = params.project_root ?? process.cwd();
			const bridge = bridgeFor();
			const current = await bridge.zoom(params.path, params.symbol);
			const anchor = findAnchor(current.content);

			if (!anchor) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `sages_insert_after_symbol: could not find anchor in ${params.path} :: ${params.symbol}. Body had no clear closing boundary. Use sages_replace_symbol or sages_write_file instead.`,
						},
					],
				details: {},

				};
			}

			// Snapshot first
			const snap = snapshot(projectRoot, params.path);

			// edit replaces anchor with anchor + new content
			const replaceText = `${anchor}\n\n${params.new_content}\n`;
			const result = await bridge.edit(params.path, anchor, replaceText);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							path: params.path,
							symbol: params.symbol,
							inserted_after_anchor: anchor.slice(0, 60),
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

/**
 * sages_write_file — AFT-backed file write WITH safety snapshot.
 *
 * ALWAYS calls safety.snapshot BEFORE bridge.write. This is the workaround
 * for AFT's broken `dry_run: true` flag (bug confirmed in 2026-07-19 A/B test).
 * The snapshot lives at `.sages/snapshots/<id>.bak` and can be restored
 * via sages_undo (planned, not yet implemented) or plain `cp`.
 *
 * Returns: snapshot_path + aft_backup_id + undo_hint, so the agent can
 * roll back deterministically using either path.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bridgeFor, snapshot } from "../aft/index.js";

export function registerSagesWriteFile(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sages_write_file",
		label: "sages_write_file",
		description:
			"Write file contents. ALWAYS snapshots the existing file to .sages/snapshots/ first (workaround for AFT's broken dry_run flag). Returns snapshot_path + aft_backup_id; either can be used to restore.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to write" }),
			content: Type.String({ description: "New file contents" }),
			project_root: Type.Optional(
				Type.String({ description: "Project root (defaults to cwd)" }),
			),
		}),
		async execute(_id, params) {
			const projectRoot = params.project_root ?? process.cwd();
			// 1. SNAPSHOT FIRST — AFT's dry_run is broken, so we don't trust it
			const snap = snapshot(projectRoot, params.path);
			// 2. Then delegate to AFT (which also creates its own internal backup)
			const bridge = bridgeFor();
			const result = await bridge.write(params.path, params.content);
			// 3. Return both paths so the agent can restore via either
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							path: params.path,
							created: result.created,
							syntax_valid: result.syntax_valid,
							snapshot_path: snap.snapshot_path,
							snapshot_id: snap.snapshot_id,
							aft_backup_id: result.backup_id,
							undo_hint: `cp ${snap.snapshot_path} ${params.path}  # or call aft_safety with ${result.backup_id}`,
						}),
					},
				],
			details: {},

			};
		},
	});
}

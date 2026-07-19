// registerAllWrappers — single entrypoint for the sages_* tool layer.
//
// Called from each sage tool's registration block (fuxi-tools, qiaochui,
// luban, gaoyao). Each wrapper file is responsible for one sages_* tool.
//
// Adding a new sages_* tool:
//   1. Create wrap/ToolName.ts with registerSagesToolName(pi)
//   2. Add it to the imports below and the REGISTRARS array
//   3. Add a test in test/wrap/ToolName.test.ts
//   4. Reference the new tool name in templates/SYSTEM.md and skills/*/SKILL.md

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerSagesReadFile } from "./read-file.js";
import { registerSagesOutline } from "./outline.js";
import { registerSagesFindSymbol } from "./find-symbol.js";
import { registerSagesSearch } from "./search.js";
import { registerSagesWriteFile } from "./write-file.js";
import { registerSagesReplaceSymbol } from "./replace-symbol.js";
import { registerSagesInsertAfterSymbol } from "./insert-after-symbol.js";
import { registerSagesFindReferences } from "./find-references.js";
import { registerSagesDiagnostics } from "./diagnostics.js";
import { registerHoistedTools, loadHoistConfig } from "./hoist.js";

type SageWrapperRegistrar = (pi: ExtensionAPI) => void;

const REGISTRARS: SageWrapperRegistrar[] = [
	registerSagesReadFile,
	registerSagesOutline,
	registerSagesFindSymbol,
	registerSagesSearch,
	registerSagesWriteFile,
	registerSagesReplaceSymbol,
	registerSagesInsertAfterSymbol,
	registerSagesFindReferences,
	registerSagesDiagnostics,
];

export const SAGE_TOOL_NAMES = [
	"sages_read_file",
	"sages_outline",
	"sages_find_symbol",
	"sages_search",
	"sages_write_file",
	"sages_replace_symbol",
	"sages_insert_after_symbol",
	"sages_find_references",
	"sages_diagnostics",
] as const;

export function registerAllWrappers(pi: ExtensionAPI): void {
	for (const reg of REGISTRARS) {
		reg(pi);
	}
	// Hoist mode — when hoist_builtin_tools:true in AFT config, re-register
	// read/write/edit/grep so they OVERRIDE pi's built-ins with AFT-backed
	// versions. sages_* names stay registered for backward compat.
	registerHoistedTools(pi, loadHoistConfig(process.cwd()));
}

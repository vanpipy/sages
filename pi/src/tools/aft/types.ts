/**
 * AFT response types — the only file (alongside bridge.ts) that needs to change
 * if AFT renames a tool or changes its protocol shape.
 *
 * Other modules depend on these types; AFT binary names only appear in bridge.ts.
 */

// ─── Result shapes ────────────────────────────────────────────────────────────

export interface AftSuccess<T = unknown> {
	id: string;
	success: true;
	complete?: boolean;
	no_files_matched_scope?: boolean;
	[key: string]: unknown;
}

export interface AftError {
	id: string;
	success: false;
	code: string;
	message: string;
}

export type AftResponse<T = unknown> = AftSuccess<T> | AftError;

// ─── Per-tool results ─────────────────────────────────────────────────────────

export interface OutlineSymbol {
	name: string;
	kind: string;        // "fn" | "ifc" | "var" | ...
	visibility: string;  // "E" (exported) | "-" (private)
	lineStart: number;
	lineEnd: number;
}

export interface OutlineResult {
	file: string;
	symbols: OutlineSymbol[];
	text: string;  // human-readable text-form outline
}

export interface ZoomAnnotation {
	calls_out: string[];
	called_by: string[];
}

export interface ZoomResult {
	name: string;
	kind: string;
	range: { start_line: number; start_col: number; end_line: number; end_col: number };
	content: string;
	context_before: string[];
	context_after: string[];
	annotations: ZoomAnnotation;
}

export interface CallgraphReference {
	file: string;
	symbol: string;
	line?: number;
}

export interface CallgraphResult {
	target: string;
	direction: "inbound" | "outbound";
	references: CallgraphReference[];
}

export interface GrepMatch {
	file: string;
	line: number;
	column: number;
	line_text: string;
	match_text: string;
}

export interface GrepResult {
	pattern: string;
	path: string;
	total_matches: number;
	files_with_matches: number;
	files_searched: number;
	matches: GrepMatch[];
	index_status: string;
	search_ms: number;
	text: string;  // human-readable fallback
}

export interface InspectFinding {
	category: "duplicates" | "dead_code" | "unused_exports" | "todos" | "diagnostics";
	count: number;
	top: Array<{ file: string; symbol: string; [key: string]: unknown }>;
}

export interface InspectResult {
	path: string;
	findings: InspectFinding[];
	summary: Record<string, unknown>;
	text: string;  // human-readable health report
	scanner_state?: Record<string, unknown>;
}

export interface ReadResult {
	path: string;
	content: string;
	start_line?: number;
	end_line?: number;
}

export interface WriteResult {
	path: string;
	created: boolean;
	formatted: boolean;
	syntax_valid: boolean;
	backup_id?: string;
	rolled_back: boolean;
}

export interface EditResult {
	path: string;
	formatted: boolean;
	syntax_valid: boolean;
	backup_id?: string;
}

export interface UndoResult {
	path: string;
	backup_id: string;
	restored_count: number;
	operation: boolean;
	warnings: string[];
}

// ─── Error codes (must match AFT binary's output) ─────────────────────────────

export const AftErrorCodes = {
	CALLGRAPH_BUILDING: "callgraph_building",
	NOT_CONFIGURED: "not_configured",
	UNKNOWN_COMMAND: "unknown_command",
	INVALID_REQUEST: "invalid_request",
	FILE_NOT_FOUND: "file_not_found",
	PARSE_ERROR: "parse_error",
	NOT_FOUND: "not_found",
} as const;

export type AftErrorCode = (typeof AftErrorCodes)[keyof typeof AftErrorCodes];

// ─── Bridge session state ────────────────────────────────────────────────────

export interface AftConfig {
	harness: "pi" | "runner" | "fed" | "opencode";
	project_root: string;
}

export interface AftSessionState {
	session_id: string;
	project_root: string;
	configure_warnings: string[];
}

export type AftDaemonStatus =
	| "not_started"
	| "configuring"
	| "building_callgraph"
	| "ready"
	| "shutting_down"
	| "shutdown";

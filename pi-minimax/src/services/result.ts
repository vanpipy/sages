/**
 * result.ts — Shared types for tool return shapes.
 *
 * Each pi tool returns either {success: true, ...toolSpecificData} or
 * {success: false, error: ToolError}. This file defines the error side;
 * each tool's success side is bespoke (returns method/source for auth,
 * results array for search, exitCode/parsed for exec, etc.).
 */

/** Structured error codes returned by all minimax tools. */
export type ToolErrorCode =
    | "NOT_AUTHED"      // mmx has no credentials and no MINIMAX_API_KEY env
    | "MMX_NOT_FOUND"   // mmx binary not on PATH
    | "AUTH_STATUS_PARSE_ERROR" // (auth tool only) mmx auth status JSON malformed
    | "TIMEOUT"         // mmx subprocess killed after 60s
    | "UNKNOWN";        // any other failure

export interface ToolError {
    code: ToolErrorCode;
    message: string;
}

export type ToolFailure = { success: false; error: ToolError };

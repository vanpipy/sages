/**
 * pi-serena: Serena MCP integration for pi
 *
 * This extension ships the .mcp.json template that registers serena
 * (LSP-based semantic code retrieval/editing) as a peer MCP server.
 *
 * Design constraints:
 * - The `mcp` proxy tool is registered globally by pi-mcp-adapter;
 *   this extension does NOT re-register it.
 * - The .mcp.json template enforces:
 *   - Silent mode flags (no browser pop-ups, no GUI log window)
 *   - directTools whitelist (6 high-frequency tools only)
 *   - excludeTools (no execute_shell_command)
 *
 * Runtime responsibilities (v0.1.0):
 * - Provide install.sh helpers consumed by pi/scripts/install.sh
 * - Provide templates/mcp.json consumed at install time
 * - Future: register lifecycle hooks for workspace binding
 *
 * @see https://github.com/oraios/serena
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function piSerena(pi: ExtensionAPI): void {
  // Phase 1: pure config package. No runtime tool registration.
  // Future phases will add lifecycle hooks for cwd binding
  // and session-aware serena activation.
  void pi;
}

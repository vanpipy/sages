/**
 * mcp-client.ts - Shared JSON-RPC client for talking to the MCP sidecar.
 *
 * Used by:
 * - L1 escape hatch tools (mcp-call.ts)
 * - L2 high-level wrappers (for internal lookups: workitemTypeId, reviewerUserIds)
 *
 * Pattern:
 * 1. ensureServer() (lazy start if not running)
 * 2. POST to /mcp with JSON-RPC body + Bearer auth
 * 3. Strip SSE format and return parsed JSON
 */

import { McpServerManager } from "./mcp-server-manager.js";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";

export interface McpCallOptions {
  tokenOverride?: string;
  signal?: AbortSignal;
}

export class McpClient {
  private cfg: Config;
  private mgr: McpServerManager;
  private static instances = new WeakMap<Config, McpClient>();

  private constructor(cfg: Config) {
    this.cfg = cfg;
    this.mgr = new McpServerManager(cfg);
  }

  /** Get or create a singleton client for the given config. */
  static async getInstance(opts?: { credentialsFile?: string }): Promise<McpClient> {
    const cfg = await loadConfig(opts);
    let inst = McpClient.instances.get(cfg);
    if (!inst) {
      inst = new McpClient(cfg);
      McpClient.instances.set(cfg, inst);
    }
    return inst;
  }

  /**
   * Call a JSON-RPC method on the MCP server.
   * Returns the parsed response (or throws on HTTP error).
   * Caller should check `response.error` for RPC-level errors.
   */
  async call(method: string, params: unknown, opts: McpCallOptions = {}): Promise<any> {
    await this.mgr.ensureServer();
    const token = opts.tokenOverride || this.cfg.token;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`http://localhost:${this.cfg.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`MCP RPC ${method} failed: ${res.status} ${res.statusText}`);
    }
    const raw = await res.text();
    // Strip SSE format if present (event: ...\ndata: <json>)
    for (const line of raw.split("\n")) {
      if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
    }
    return JSON.parse(raw);
  }
}

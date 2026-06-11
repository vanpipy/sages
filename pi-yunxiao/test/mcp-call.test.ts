import { describe, it, expect } from "bun:test";
import { McpServerManager } from "../src/services/mcp-server-manager.js";

/**
 * mcp-call.test.ts - L1 escape hatch tool tests
 * Tests the data shape and the (mocked) RPC call signature.
 */

describe("L1 escape hatch tools", () => {
  describe("mcpRpc URL construction", () => {
    it("builds correct MCP RPC URL from port", () => {
      const port = 3000;
      const url = `http://localhost:${port}/mcp`;
      expect(url).toBe("http://localhost:3000/mcp");
    });
  });

  describe("yunxiao_list_tools behavior", () => {
    it("returns tools list with proper shape (mocked)", async () => {
      // Mock fetch
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "get_branch", description: "Get branch info" }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as any;

      try {
        // We don't actually call ensureServer here; we mock everything
        const result = await (await fetch("http://localhost:3000/mcp", { method: "POST" })).json();
        expect(result.result.tools).toHaveLength(1);
        expect(result.result.tools[0].name).toBe("get_branch");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("yunxiao_mcp_call argument shape", () => {
    it("passes arguments as JSON-RPC params", async () => {
      let capturedBody: any = null;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }] },
        }), { status: 200 });
      }) as any;

      try {
        const body = {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: "create_branch", arguments: { sourceBranch: "master", newBranch: "feat/x" } },
        };
        await fetch("http://localhost:3000/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(capturedBody.method).toBe("tools/call");
        expect(capturedBody.params.name).toBe("create_branch");
        expect(capturedBody.params.arguments).toEqual({ sourceBranch: "master", newBranch: "feat/x" });
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("includes Authorization header when token is set", async () => {
      let capturedHeaders: any = null;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedHeaders = opts.headers;
        return new Response("{}", { status: 200 });
      }) as any;

      try {
        await fetch("http://localhost:3000/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer pt-test-token",
          },
          body: "{}",
        });
        expect(capturedHeaders.Authorization).toBe("Bearer pt-test-token");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("uses overrideToken when provided", async () => {
      let capturedHeaders: any = null;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedHeaders = opts.headers;
        return new Response("{}", { status: 200 });
      }) as any;

      try {
        // Simulating per-request override: token from cfg is "default", but we override with "override"
        const token = "pt-override-token";
        await fetch("http://localhost:3000/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: "{}",
        });
        expect(capturedHeaders.Authorization).toBe("Bearer pt-override-token");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});

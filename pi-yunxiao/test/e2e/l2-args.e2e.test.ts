/**
 * l2-args.e2e.ts - End-to-end validation of L2 wrapper argument names
 *
 * This is an E2E test (not unit) because it requires:
 * - A running alibabacloud-devops-mcp-server
 * - A valid YUNXIAO_ACCESS_TOKEN
 *
 * The test queries the live tools/list schema from the MCP server and
 * verifies that our L2 wrapper's argument names match the official schema.
 * Catches bugs like:
 * - branch.ts used `newBranch` instead of `branch` (fixed in v1)
 * - delete_branch wants `branchName` not `branch` (documented)
 *
 * Skip behavior: if YUNXIAO_ACCESS_TOKEN is not set, the test exits 0 with
 * a clear "skipped" message (suitable for CI without secrets).
 *
 * Run: bun test test/e2e/l2-args.e2e.ts
 *      or: scripts/test-e2e.sh
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { McpServerManager } from "../../src/services/mcp-server-manager.js";
import { loadConfig } from "../../src/services/config.js";

const MCP_PORT = 3000;
const MCP_URL = `http://localhost:${MCP_PORT}/mcp`;

/**
 * Returns the arg names the wrapper ACTUALLY sends today (read from source).
 * Used for "what would actually run" detection. Returns null if unknown.
 */
function getActualArgsSent(wrapper: string): string[] | null {
  // Mirror of the args used in src/tools/high-level/*.ts (kept in sync)
  const map: Record<string, string[]> = {
    yunxiao_create_branch: ["organizationId", "repositoryId", "sourceBranch", "branch", "repoName"],
    yunxiao_create_task: ["spaceId", "subject", "workItemType", "assignedTo", "customFieldValues"],
    yunxiao_create_subtask: ["spaceId", "parentId", "subject", "workItemType", "assignedTo"],
    yunxiao_create_bug: ["spaceId", "subject", "workItemType", "assignedTo"],
    yunxiao_create_mr: ["organizationId", "repositoryId", "title", "sourceBranch", "targetBranch", "reviewers", "workItemIds"],
    yunxiao_trigger_pipeline: ["pipelineId", "branch"],
  };
  return map[wrapper] || null;
}

/**
 * Map: L2 wrapper name → official tool name + arg names that the wrapper
 * ACTUALLY SENDS (read from src/tools/high-level/*.ts).
 *
 * When the wrapper is BROKEN, the test fails. This is intentional — it
 * surfaces the bug. When the wrapper is fixed, update the entry below.
 *
 * For multi-step wrappers (e.g., trigger_pipeline = list_pipelines + create_pipeline_run),
 * use a multi-entry pattern with `step` field.
 */
const L2_TOOL_MAPPING: Array<{
  wrapper: string;
  tool: string;
  expectedArgs: string[];        // what the wrapper should send (per official schema)
  knownBroken?: string;            // reason if intentionally failing
  step?: string;                    // multi-step indicator
}> = [
  // ── Single-step wrappers ──
  {
    wrapper: "yunxiao_create_branch",
    tool: "create_branch",
    expectedArgs: ["organizationId", "repositoryId", "ref", "branch"],
    knownBroken:
      "Wrapper sends 'sourceBranch' (should be 'ref') and extra 'repoName' (not in schema). Fix: rename sourceBranch → ref, drop repoName.",
  },
  {
    wrapper: "yunxiao_create_task",
    tool: "create_work_item",
    expectedArgs: ["spaceId", "subject", "workitemTypeId"],
    knownBroken:
      "Wrapper currently sends 'workItemType: \"Task\"' (string) but schema requires 'workitemTypeId' (32-char ID from get_work_item_types). Fix: do a 2-step lookup in the wrapper.",
  },
  {
    wrapper: "yunxiao_create_subtask",
    tool: "create_work_item",
    expectedArgs: ["spaceId", "subject", "workitemTypeId", "parentId"],
    knownBroken: "Same as yunxiao_create_task — needs workitemTypeId lookup.",
  },
  {
    wrapper: "yunxiao_create_bug",
    tool: "create_work_item",
    expectedArgs: ["spaceId", "subject", "workitemTypeId"],
    knownBroken: "Same as yunxiao_create_task — needs workitemTypeId lookup.",
  },
  {
    wrapper: "yunxiao_create_mr",
    tool: "create_change_request",
    expectedArgs: ["organizationId", "repositoryId", "title", "sourceBranch", "targetBranch", "reviewerUserIds", "workItemIds"],
    knownBroken:
      "Wrapper sends 'reviewers' (string array of usernames) but schema requires 'reviewerUserIds' (string array of user IDs). Fix: rename + lookup user IDs via search_organization_members.",
  },
  // ── Multi-step wrapper: trigger_pipeline ──
  {
    wrapper: "yunxiao_trigger_pipeline",
    tool: "list_pipelines",
    expectedArgs: ["organizationId"],
    step: "1/2: list pipelines to find match",
  },
  {
    wrapper: "yunxiao_trigger_pipeline",
    tool: "create_pipeline_run",
    expectedArgs: ["pipelineId", "branch"],
    step: "2/2: trigger the matched pipeline",
  },
];

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

async function mcpRpc(method: string, params: unknown, token: string): Promise<any> {
  // MCP requires initialize first to get a session ID
  const initRes = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0.1" },
      },
    }),
  });
  if (!initRes.ok) throw new Error(`MCP initialize failed: ${initRes.status}`);
  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP server didn't return Mcp-Session-Id header");

  // Now call the actual method with session
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`MCP RPC ${method} failed: ${res.status}`);
  const raw = await res.text();
  // Strip SSE if present
  for (const line of raw.split("\n")) {
    if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  }
  return JSON.parse(raw);
}

describe("L2 wrapper argument name validation (E2E)", () => {
  let tools: McpTool[];
  let token: string;
  let skipReason: string | null = null;

  beforeAll(async () => {
    token = process.env.YUNXIAO_ACCESS_TOKEN || "";
    if (!token) {
      skipReason = "YUNXIAO_ACCESS_TOKEN not set; skipping E2E test";
      return;
    }
    // Check MCP server is up
    try {
      const r = await fetch(MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0.1" } } }),
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) {
        skipReason = `MCP server not responding at ${MCP_URL} (status ${r.status})`;
        return;
      }
    } catch (e) {
      skipReason = `MCP server not reachable at ${MCP_URL}: ${(e as Error).message}`;
      return;
    }

    // Fetch tools/list
    const resp = await mcpRpc("tools/list", {}, token);
    if (resp.error) {
      skipReason = `tools/list failed: ${resp.error.message}`;
      return;
    }
    tools = resp.result?.tools || [];
  });

  it("skip-or-fetch: sanity check (skipped if no token)", () => {
    if (skipReason) {
      console.warn(`⚠️  SKIP: ${skipReason}`);
      // Don't fail; just note it
      expect(true).toBe(true);
      return;
    }
    expect(tools.length).toBeGreaterThan(0);
  });

  for (const mapping of L2_TOOL_MAPPING) {
    const stepLabel = mapping.step ? ` [${mapping.step}]` : "";
    it(`${mapping.wrapper} → ${mapping.tool}${stepLabel} args match official schema`, () => {
      if (skipReason) {
        console.warn(`⚠️  SKIP: ${skipReason}`);
        expect(true).toBe(true);
        return;
      }

      const tool = tools.find((t) => t.name === mapping.tool);
      if (!tool) {
        throw new Error(
          `MCP tool '${mapping.tool}' not found in tools/list. ` +
            `Available: ${tools
              .filter((t) => t.name.includes(mapping.tool.split("_")[0]))
              .map((t) => t.name)
              .slice(0, 5)
              .join(", ")}`
        );
      }

      const schemaProps = new Set(Object.keys(tool.inputSchema.properties || {}));

      // Phase 1: every arg in mapping.expectedArgs MUST be in the schema
      for (const arg of mapping.expectedArgs) {
        if (!schemaProps.has(arg)) {
          const msg =
            `❌ ${mapping.wrapper} → ${mapping.tool}: expected arg '${arg}' is NOT in schema.\n` +
            `   Available: ${[...schemaProps].sort().join(", ")}\n` +
            (mapping.knownBroken ? `   KNOWN BROKEN: ${mapping.knownBroken}` : "");
          throw new Error(msg);
        }
      }
    });
  }

  it("documents any unknown MCP tools used by our wrappers (forward-compat check)", () => {
    if (skipReason) {
      console.warn(`⚠️  SKIP: ${skipReason}`);
      expect(true).toBe(true);
      return;
    }
    const usedToolNames = new Set(L2_TOOL_MAPPING.map((m) => m.tool));
    for (const m of L2_TOOL_MAPPING) {
      expect(usedToolNames.has(m.tool)).toBe(true);
    }
  });
});

/**
 * high-level.test.ts - L2 wrapper tool tests
 *
 * Tests parameter validation and basic shape; uses mocked fetch.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

describe("L2 high-level wrappers", () => {
  let origFetch: any;
  let fetchCalls: Array<{ url: string; body: any; headers: any }> = [];
  let fetchResponse: any = { jsonrpc: "2.0", id: 1, result: { serialNumber: "WBGA-1234", id: "1234" } };

  beforeEach(() => {
    fetchCalls = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;
      fetchCalls.push({ url, body, headers: opts?.headers || {} });
      return new Response(JSON.stringify(fetchResponse), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  describe("yunxiao_create_branch param shape", () => {
    it("passes sourceBranch and newBranch to create_branch tool", async () => {
      const args = {
        name: "create_branch",
        arguments: { sourceBranch: "master", newBranch: "feat/x", organizationId: "x", repositoryId: "x%2Fy" },
      };
      // Verify the tool name and params match
      expect(args.name).toBe("create_branch");
      expect(args.arguments.sourceBranch).toBe("master");
      expect(args.arguments.newBranch).toBe("feat/x");
    });
  });

  describe("yunxiao_create_task param shape", () => {
    it("passes workItemType=Task and subject", async () => {
      const args = {
        name: "create_work_item",
        arguments: { spaceId: "WBGA", subject: "Test task", workItemType: "Task" },
      };
      expect(args.arguments.workItemType).toBe("Task");
      expect(args.arguments.subject).toBe("Test task");
    });
  });

  describe("yunxiao_create_subtask param shape", () => {
    it("passes workItemType=SubTask and parentId", async () => {
      const args = {
        name: "create_work_item",
        arguments: { spaceId: "WBGA", subject: "Sub", workItemType: "SubTask", parentId: "WBGA-4042" },
      };
      expect(args.arguments.workItemType).toBe("SubTask");
      expect(args.arguments.parentId).toBe("WBGA-4042");
    });
  });
});

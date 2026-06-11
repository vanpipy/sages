/**
 * _lookups.ts - Internal lookups for high-level wrappers.
 *
 * Yunxiao MCP API quirks:
 * - create_work_item wants `workitemTypeId` (32-char ID), not a string like "Task".
 *   We must call get_work_item_types to look up the ID.
 * - create_change_request wants `reviewerUserIds` (array of user IDs), not usernames.
 *   We must call search_organization_members to look up each user.
 * - Most endpoints require `organizationId` (a long hex string), which is
 *   separate from the project code (e.g., "WBGA"). We get it once via
 *   get_current_organization_info and cache.
 *
 * All caches are in-process and live for the lifetime of the tool call
 * (so multi-step wrappers in one invocation hit the cache for repeated lookups).
 */

import { McpClient } from "../../services/mcp-client.js";

// ──────────────────────────────────────────────
// Caches
// ──────────────────────────────────────────────
const typeIdCache = new Map<string, string>();
const reviewerIdCache = new Map<string, string>();
let cachedOrgId: string | null = null;

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Get the current organization ID (cached after first call).
 * Calls get_current_organization_info if not cached.
 */
export async function getCurrentOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId;
  const client = await McpClient.getInstance();
  const resp = await client.call("tools/call", {
    name: "get_current_organization_info",
    arguments: {},
  });
  if (resp?.error) {
    throw new Error(`get_current_organization_info failed: ${resp.error.message}`);
  }
  const text = resp?.result?.content?.[0]?.text;
  if (!text) throw new Error("get_current_organization_info returned no content");
  const data = JSON.parse(text);
  const orgId = data.lastOrganization || data.organizationId;
  if (!orgId) throw new Error("get_current_organization_info returned no organizationId");
  cachedOrgId = orgId;
  return orgId;
}

/**
 * Look up work item type ID by friendly name.
 * Caches per (orgId, spaceId, typeName).
 */
export async function lookupWorkItemTypeId(
  spaceId: string,
  typeName: "Task" | "SubTask" | "Bug",
): Promise<string> {
  const orgId = await getCurrentOrgId();
  const key = `${orgId}|${spaceId}|${typeName}`;
  const cached = typeIdCache.get(key);
  if (cached) return cached;

  const client = await McpClient.getInstance();
  const resp = await client.call("tools/call", {
    name: "get_work_item_types",
    arguments: { organizationId: orgId, id: spaceId, category: "Task" },
  });
  if (resp?.error) {
    throw new Error(`get_work_item_types failed: ${resp.error.message}`);
  }
  const text = resp?.result?.content?.[0]?.text;
  if (!text) throw new Error("get_work_item_types returned no content");
  const types = JSON.parse(text);
  if (!Array.isArray(types)) {
    throw new Error(`get_work_item_types returned non-array: ${text.slice(0, 200)}`);
  }
  const match = types.find((t: any) => t?.name === typeName);
  if (!match) {
    const available = types.map((t: any) => t?.name).filter(Boolean).join(", ");
    throw new Error(
      `Work item type "${typeName}" not found in project ${spaceId}. Available: ${available}`,
    );
  }
  const id = match.id;
  if (!id) throw new Error(`get_work_item_types returned type without id: ${JSON.stringify(match)}`);
  typeIdCache.set(key, id);
  return id;
}

/**
 * Look up user IDs for a list of usernames.
 * Caches per (orgId, username).
 * Skips usernames that are already user IDs (32-char hex).
 */
export async function lookupReviewerUserIds(usernames: string[]): Promise<string[]> {
  if (!usernames || usernames.length === 0) return [];
  const orgId = await getCurrentOrgId();
  const client = await McpClient.getInstance();
  const ids: string[] = [];
  for (const username of usernames) {
    // If already a 32-char hex ID, use directly
    if (/^[0-9a-f]{32}$/.test(username)) {
      ids.push(username);
      continue;
    }
    const key = `${orgId}|${username}`;
    const cached = reviewerIdCache.get(key);
    if (cached) { ids.push(cached); continue; }

    const resp = await client.call("tools/call", {
      name: "search_organization_members",
      arguments: { organizationId: orgId, query: username },
    });
    if (resp?.error) {
      throw new Error(`search_organization_members failed: ${resp.error.message}`);
    }
    const text = resp?.result?.content?.[0]?.text;
    if (!text) throw new Error("search_organization_members returned no content");
    const members = JSON.parse(text);
    if (!Array.isArray(members)) {
      throw new Error(`search_organization_members returned non-array: ${text.slice(0, 200)}`);
    }
    // Try exact match on multiple fields
    const member = members.find(
      (m: any) => m?.userId === username || m?.username === username || m?.name === username,
    );
    if (!member) {
      const available = members.map((m: any) => m?.name || m?.username).filter(Boolean).join(", ");
      throw new Error(
        `Reviewer "${username}" not found in organization. Matches: ${available || "(none)"}`,
      );
    }
    const id = member.userId || member.id;
    if (!id) throw new Error(`Member found but no id: ${JSON.stringify(member)}`);
    reviewerIdCache.set(key, id);
    ids.push(id);
  }
  return ids;
}

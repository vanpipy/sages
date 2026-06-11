/**
 * state/types.ts - Shared TypeScript types for the pi-yunxiao package.
 */

export type MCPTransport = "stdio" | "sse" | "streamable-http";

export interface ServerStatus {
  installed: boolean;
  running: boolean;
  healthy: boolean;
  pid?: number;
  port: number;
  lastUsedAt?: string;
  idleMinutes: number;
  tokenConfigured: boolean;
}

export interface HealthResult {
  healthy: boolean;
  latencyMs: number;
  consecutiveFailures: number;
}

export interface ParseResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

export interface RepoContext {
  orgId: string;
  repositoryId: string;
  repoName: string;
  remoteUrl: string;
}

export interface ToolError {
  code: string;
  message: string;
  suggestion?: string;
}

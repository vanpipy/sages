/**
 * config.ts - Yunxiao MCP sidecar configuration.
 *
 * All values resolved from environment variables with sensible defaults.
 * Path fields are expanded (~ → $HOME) and joined with the state directory.
 */

import { expandPath, getEnv, getEnvInt, getEnvBool, resolveToken } from "../utils/env-detect.js";
import { join } from "node:path";

export interface Config {
  // Network
  port: number;
  apiBaseUrl: string;

  // Lifecycle
  idleTimeoutMin: number;

  // Paths (XDG: ~/.cache/yunxiao-mcp/)
  stateDir: string;
  pidFile: string;
  lastUsedFile: string;
  logFile: string;
  lockFile: string;
  credentialsFile: string;

  // Server
  serverCommand: string;
  serverArgs: string[];
  mcpGlobal: boolean;

  // Health
  healthCheckTimeoutMs: number;
  healthCheckMaxTries: number;
  healthFailureThreshold: number;

  // Auth (resolved at loadConfig time; may be undefined)
  token?: string;
}

export const defaultConfig = (): Omit<Config, "token"> => ({
  port: 3000,
  apiBaseUrl: "https://codeup.aliyun.com",
  idleTimeoutMin: 10,
  stateDir: expandPath("~/.cache/yunxiao-mcp"),
  pidFile: "",
  lastUsedFile: "",
  logFile: "",
  lockFile: "",
  credentialsFile: expandPath("~/.config/yunxiao/credentials"),
  serverCommand: "npx",
  serverArgs: ["-y", "alibabacloud-devops-mcp-server", "--streamable-http"],
  mcpGlobal: false,
  healthCheckTimeoutMs: 2000,
  healthCheckMaxTries: 30,
  healthFailureThreshold: 2,
});

/**
 * Load config from environment. Optionally pass a custom credentials file path
 * (for tests). When called without args, reads YUNXIAO_ACCESS_TOKEN env directly.
 */
export async function loadConfig(opts?: { credentialsFile?: string }): Promise<Config> {
  const base = defaultConfig();
  const mcpGlobal = getEnvBool("YUNXIAO_MCP_GLOBAL", false);

  const port = getEnvInt("YUNXIAO_MCP_PORT", base.port);
  const idleTimeoutMin = getEnvInt("YUNXIAO_MCP_IDLE_MIN", base.idleTimeoutMin);
  const apiBaseUrl = getEnv("YUNXIAO_API_BASE_URL", base.apiBaseUrl);
  const stateDir = expandPath(getEnv("YUNXIAO_STATE_DIR", base.stateDir));

  const cfg: Config = {
    ...base,
    port,
    apiBaseUrl,
    idleTimeoutMin,
    stateDir,
    pidFile: join(stateDir, "server.pid"),
    lastUsedFile: join(stateDir, "server.lastused"),
    logFile: join(stateDir, "server.log"),
    lockFile: join(stateDir, "lock"),
    credentialsFile: opts?.credentialsFile || base.credentialsFile,
    mcpGlobal,
    serverCommand: mcpGlobal ? "alibabacloud-devops-mcp-server" : "npx",
    serverArgs: mcpGlobal
      ? ["--streamable-http"]
      : ["-y", "alibabacloud-devops-mcp-server", "--streamable-http"],
  };

  // Try to resolve token
  const token = await resolveToken(cfg.credentialsFile);
  if (token) cfg.token = token;

  return cfg;
}

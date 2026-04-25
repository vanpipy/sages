/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Sages Plugin - Tool Execute Hook 🜄                                  ║
 * ║                                                                           ║
 * ║   CLI execution wrapper for tool invocations                              ║
 * ║   Handles spawn, pipe, error translation, and logging                    ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { spawn } from "child_process";
import type { PluginContext, ToolResult } from "../types.js";
import { getSagesCLI, logTool, logError } from "../utils.js";

// =============================================================================
// Tool Executor
// =============================================================================

let projectDirectory: string = process.cwd();

/**
 * Set the project directory for CLI execution
 */
export function setProjectDirectory(dir: string): void {
  projectDirectory = dir;
}

/**
 * Get the current project directory
 */
export function getProjectDirectory(): string {
  return projectDirectory;
}

/**
 * Execute a tool via the sages CLI
 */
export async function execTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PluginContext,
): Promise<string> {
  const hasArgs = Object.keys(args).length > 0;
  const cliArgs = hasArgs
    ? ["tool", name, "--json", JSON.stringify(args)]
    : ["tool", name];

  return new Promise((resolve, reject) => {
    const proc = spawn(getSagesCLI(), cliArgs, {
      cwd: projectDirectory,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_SESSION_ID: ctx.sessionID,
        OPENCODE_MESSAGE_ID: ctx.messageID,
        OPENCODE_AGENT: ctx.agent,
        SAGES_PROJECT_DIR: projectDirectory,
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data;
    });

    proc.stderr.on("data", (data) => {
      stderr += data;
    });

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          if (result.success && result.data !== undefined) {
            logTool(
              name,
              args,
              typeof result.data === "string" ? result.data : JSON.stringify(result.data),
            );
            resolve(
              typeof result.data === "string"
                ? result.data
                : JSON.stringify(result.data, null, 2),
            );
          } else if (!result.success && result.error) {
            const errorMsg = typeof result.error === "string"
              ? result.error
              : (result.error.message || "Tool execution failed");
            logTool(name, args, undefined, errorMsg);
            logError(`Tool ${name} failed`, { args, error: errorMsg });
            reject(new Error(errorMsg));
          } else {
            logTool(name, args, stdout);
            resolve(stdout);
          }
        } catch {
          logTool(name, args, stdout);
          resolve(stdout);
        }
      } else if (code === 2) {
        const errorMsg = `Unknown tool: ${name}`;
        logError(errorMsg, { args });
        reject(new Error(errorMsg));
      } else if (code === 3) {
        const errorMsg = `Invalid JSON args: ${stderr}`;
        logError(errorMsg, { tool: name, args });
        reject(new Error(errorMsg));
      } else {
        try {
          const result = JSON.parse(stdout);
          if (!result.success && result.error) {
            const errorMsg = typeof result.error === "string"
              ? result.error
              : (result.error.message || `Tool failed with code ${code}`);
            logTool(name, args, undefined, errorMsg);
            logError(`Tool ${name} failed with code ${code}`, { args, error: errorMsg });
            reject(new Error(errorMsg));
          } else {
            const errorMsg = stderr || stdout || `Tool failed with code ${code}`;
            logTool(name, args, undefined, errorMsg);
            logError(`Tool ${name} failed with code ${code}`, { args, stderr, stdout });
            reject(new Error(errorMsg));
          }
        } catch {
          const errorMsg = stderr || stdout || `Tool failed with code ${code}`;
          logTool(name, args, undefined, errorMsg);
          logError(`Tool ${name} failed with code ${code}`, { args, stderr, stdout });
          reject(new Error(errorMsg));
        }
      }
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "sages CLI not found. Install with: npm install -g opencode-sages",
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

// =============================================================================
// Tool Executor with Error Recovery
// =============================================================================

export interface ExecToolOptions {
  retries?: number;
  retryDelayMs?: number;
  failFast?: boolean;
}

/**
 * Execute tool with retry logic
 */
export async function execToolWithRetry(
  name: string,
  args: Record<string, unknown>,
  ctx: PluginContext,
  options: ExecToolOptions = {},
): Promise<string> {
  const { retries = 0, retryDelayMs = 1000, failFast = false } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await execTool(name, args, ctx);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (failFast || attempt >= retries) {
        throw lastError;
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      logError(`Retry attempt ${attempt + 1} for ${name}`, { error: lastError.message });
    }
  }

  throw lastError;
}

// =============================================================================
// Batch Tool Execution
// =============================================================================

export interface BatchResult {
  results: Record<string, string>;
  errors: Record<string, string>;
  totalTime: number;
}

/**
 * Execute multiple tools in parallel
 */
export async function execToolsBatch(
  tools: Array<{ name: string; args: Record<string, unknown> }>,
  ctx: PluginContext,
): Promise<BatchResult> {
  const results: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const startTime = Date.now();

  const promises = tools.map(async (tool) => {
    try {
      const result = await execTool(tool.name, tool.args, ctx);
      results[tool.name] = result;
    } catch (err) {
      errors[tool.name] = err instanceof Error ? err.message : String(err);
    }
  });

  await Promise.all(promises);

  return {
    results,
    errors,
    totalTime: Date.now() - startTime,
  };
}
/**
 * exec.ts — Shell-out to the globally-installed `mmx` CLI.
 *
 * execMmx({command, args, apiKey?, raw?, env?}) → {stdout, stderr, exitCode, parsed?}
 *
 * - command: e.g. "text chat", "search query", "quota show" (split on whitespace)
 * - args: Record<string, value> → flattened to repeated `--key value` (or `--flag` for booleans)
 * - apiKey: per-call token override (mmx's `--api-key` flag)
 * - raw: skip auto-injection of agent-friendly flags (--output json --quiet --non-interactive)
 * - env: extra env vars for the subprocess
 *
 * Auto-injects `--output json --quiet --non-interactive` for LLM agent use unless
 * caller specifies `raw: true` or already passes `--output`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FlatValue = string | number | boolean | string[];

export interface ExecMmxArgs {
    /** mmx subcommand, may be multi-word like "text chat" */
    command: string;
    /** CLI flags as Record; arrays → repeated flags */
    args?: Record<string, FlatValue>;
    /** Per-call token override (passed as `--api-key`) */
    apiKey?: string;
    /** Skip auto-injection of agent-friendly flags */
    raw?: boolean;
    /** Extra env vars for the subprocess */
    env?: Record<string, string>;
}

export interface ExecMmxResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    /** JSON.parse(stdout) if valid JSON, else undefined */
    parsed?: unknown;
}

export type ExecFileFn = (
    cmd: string,
    args: string[],
    options?: { env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultExecFile(
    cmd: string,
    args: string[],
    options?: { env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const result = await execFileAsync(cmd, args, { env: { ...process.env, ...options?.env } });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (e) {
        const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
        return {
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? String(err.message ?? err),
            exitCode: typeof err.code === "number" ? err.code : 1,
        };
    }
}

/**
 * Run an mmx subcommand and return structured result.
 *
 * @param args    The mmx invocation parameters
 * @param options.execFile  Override for testing (default: node:child_process.execFile)
 */
export async function execMmx(
    args: ExecMmxArgs,
    options: { execFile?: ExecFileFn } = {},
): Promise<ExecMmxResult> {
    const execFileFn = options.execFile ?? defaultExecFile;
    const cmdArgs: string[] = [];

    // 1. Split multi-word command (e.g. "text chat" → ["text", "chat"])
    const commandParts = args.command.trim().split(/\s+/).filter(Boolean);
    cmdArgs.push(...commandParts);

    // 2. Flatten user-provided args (order preserved by Object.entries)
    if (args.args) {
        for (const [key, value] of Object.entries(args.args)) {
            appendArg(cmdArgs, key, value);
        }
    }

    // 3. Auto-inject agent-friendly flags (unless raw or caller already set --output)
    if (!args.raw && !hasFlag(cmdArgs, "--output")) {
        cmdArgs.push("--output", "json", "--quiet", "--non-interactive");
    }

    // 4. Per-call apiKey override
    if (args.apiKey) {
        cmdArgs.push("--api-key", args.apiKey);
    }

    // 5. Execute
    const { stdout, stderr, exitCode } = await execFileFn("mmx", cmdArgs, { env: args.env });

    // 6. Best-effort JSON parse
    let parsed: unknown;
    const trimmed = stdout.trim();
    if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            // not JSON; leave parsed undefined
        }
    }

    return { stdout, stderr, exitCode, parsed };
}

/**
 * Append a single key/value pair (or repeated flag for arrays) to cmdArgs.
 *   string|number  → --key value
 *   boolean true   → --key
 *   boolean false  → (omit)
 *   string[]       → --key v1 --key v2 ...
 */
function appendArg(cmdArgs: string[], key: string, value: FlatValue): void {
    if (typeof value === "boolean") {
        if (value) cmdArgs.push(`--${key}`);
        return;
    }
    if (Array.isArray(value)) {
        for (const v of value) {
            cmdArgs.push(`--${key}`, String(v));
        }
        return;
    }
    cmdArgs.push(`--${key}`, String(value));
}

function hasFlag(cmdArgs: string[], flag: string): boolean {
    return cmdArgs.includes(flag);
}

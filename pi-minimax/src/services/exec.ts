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

/**
 * Hardcoded 60-second timeout for all mmx subprocess invocations.
 *
 * Rationale: long-running mmx commands (e.g. `video generate` polling for
 * minutes by default) would block the pi agent indefinitely without a timeout.
 * 60s is enough for most interactive calls (text, image, search, quota) but
 * will cut off long polls — use `minimax_exec` with `mmx video generate
 * --async` to get a task ID and poll separately.
 */
export const EXEC_TIMEOUT_MS = 60_000;

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
    /** True if the subprocess was killed due to EXEC_TIMEOUT_MS */
    timedOut?: true;
}

export type ExecFileFn = (
    cmd: string,
    args: string[],
    options?: { env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: true }>;

/**
 * Default execFile wrapper: runs the real subprocess with EXEC_TIMEOUT_MS.
 * On error (including timeout), the error is propagated up; execMmx's outer
 * try/catch handles timeout-vs-other-error classification.
 */
async function defaultExecFile(
    cmd: string,
    args: string[],
    options?: { env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: true }> {
    const result = await execFileAsync(cmd, args, {
        env: { ...process.env, ...options?.env },
        timeout: EXEC_TIMEOUT_MS,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
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

    // 5. Execute (with timeout detection in catch block)
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    let timedOut: true | undefined;
    try {
        const result = await execFileFn("mmx", cmdArgs, { env: args.env });
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
        timedOut = result.timedOut;
    } catch (e) {
        const err = e as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: string | number;
            killed?: boolean;
            signal?: string;
        };
        // Detect timeout: Node sets code='ERR_CHILD_PROCESS_TIMEOUT' on timeout.
        // Also detectable via killed:true + signal:'SIGTERM' (fallback for older Node
        // or for tests that mock the timeout shape).
        const isTimeout =
            err.code === "ERR_CHILD_PROCESS_TIMEOUT" ||
            (err.killed === true && err.signal === "SIGTERM");
        if (isTimeout) {
            return {
                stdout: err.stdout ?? "",
                stderr: err.stderr ?? `mmx subprocess killed after ${EXEC_TIMEOUT_MS / 1000}s timeout`,
                exitCode: 124,
                timedOut: true,
            };
        }
        // Non-timeout errors (ENOENT, parse, etc.) propagate to caller
        throw e;
    }

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

    return { stdout, stderr, exitCode, parsed, timedOut };
}

/**
 * Append a single key/value pair (or repeated flag for arrays) to cmdArgs.
 *
 * Type semantics:
 *   - string|number  → --key value (value coerced to string)
 *   - boolean true   → --key (flag-only, no value)
 *   - boolean false  → omit (no flag pushed)
 *   - string[]       → repeated --key v1 --key v2 ...
 *
 * The key is always prefixed with `--`. Caller is responsible for not
 * passing already-prefixed keys.
 *
 * @param cmdArgs  The argv array being built (mutated in place)
 * @param key      The flag name without `--` prefix
 * @param value    The value (or boolean for flag-only)
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

/**
 * Check whether a flag was already added to the argv array.
 *
 * Used to detect caller-provided `--output` so we don't double-inject the
 * auto agent-friendly flags (`--output json --quiet --non-interactive`).
 *
 * @param cmdArgs  The argv array to search
 * @param flag     The flag to look for (e.g. `"--output"`)
 * @returns        True if the flag appears as an exact element
 */
function hasFlag(cmdArgs: string[], flag: string): boolean {
    return cmdArgs.includes(flag);
}

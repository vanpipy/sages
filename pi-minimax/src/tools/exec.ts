/**
 * exec.ts — L1 tool: minimax_exec (escape hatch).
 *
 * Lets the LLM run any mmx subcommand with structured args. Useful for
 * modalities we haven't wrapped as L2 (text/image/video/speech/music/vision/quota).
 *
 *   minimax_exec({command: "text chat", args: {message: "Hi", stream: true}, apiKey: "sk-…"})
 *     → mmx text chat --message Hi --stream --output json --quiet --non-interactive --api-key sk-…
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureAuth, NotAuthedError, type EnsureAuthOptions } from "../services/auth-bootstrap.js";
import { execMmx, type ExecMmxArgs, type ExecMmxResult, type FlatValue } from "../services/exec.js";

type UpdateFn = NonNullable<EnsureAuthOptions["onUpdate"]>;

export type ExecToolInput = {
    command: string;
    args?: Record<string, FlatValue>;
    apiKey?: string;
};

export type ExecToolResult =
    | {
          success: true;
          command: string;
          exitCode: number;
          stdout: string;
          stderr: string;
          parsed?: unknown;
      }
    | {
          success: false;
          error: {
              code: "NOT_AUTHED" | "MMX_NOT_FOUND" | "TIMEOUT" | "UNKNOWN";
              message: string;
          };
      };

export interface ExecToolDeps {
    input: ExecToolInput;
    ensureAuth?: (opts?: EnsureAuthOptions) => Promise<void>;
    execMmx?: (args: ExecMmxArgs) => Promise<ExecMmxResult>;
    onUpdate?: UpdateFn;
}

export async function runExecTool(deps: ExecToolDeps): Promise<ExecToolResult> {
    const ensure = deps.ensureAuth ?? ensureAuth;
    const run = deps.execMmx ?? execMmx;

    try {
        await ensure({ onUpdate: deps.onUpdate });
    } catch (e) {
        if (e instanceof NotAuthedError) {
            return { success: false, error: { code: "NOT_AUTHED", message: e.message } };
        }
        return { success: false, error: { code: "UNKNOWN", message: (e as Error).message } };
    }

    let result: ExecMmxResult;
    try {
        result = await run({
            command: deps.input.command,
            args: deps.input.args,
            apiKey: deps.input.apiKey,
        });
    } catch (e) {
        const msg = (e as Error).message;
        if (/ENOENT|no such file|not found/i.test(msg)) {
            return {
                success: false,
                error: { code: "MMX_NOT_FOUND", message: "mmx binary not found. Run: npm install -g mmx-cli" },
            };
        }
        return { success: false, error: { code: "UNKNOWN", message: msg } };
    }

    if (result.timedOut) {
        return {
            success: false,
            error: { code: "TIMEOUT", message: `mmx ${deps.input.command} timed out (60s). Use mmx <cmd> --async for long-running commands.` },
        };
    }

    return {
        success: true,
        command: deps.input.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        parsed: result.parsed,
    };
}

export function registerExecTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "minimax_exec",
        label: "mmx Exec (escape hatch)",
        description:
            "Run any mmx subcommand. Args map to flags: scalars → --key value, " +
            "booleans → --key (true) or omitted (false), arrays → repeated --key v1 --key v2. " +
            "Use this for modalities not wrapped as dedicated tools (text/image/video/speech/music/vision/quota). " +
            "See ~/.pi/packages/mmx-cli/skill/SKILL.md for flag reference.",
        parameters: Type.Object({
            command: Type.String({ description: "mmx subcommand, e.g. 'text chat', 'image generate', 'quota show'" }),
            args: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]), {
                description: "CLI flags as key→value; see description for type semantics",
            })),
            apiKey: Type.Optional(Type.String({ description: "Per-call token override (mmx --api-key flag)" })),
        }),
        async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
            const input = params as ExecToolInput;
            const result = await runExecTool({
                input,
                ensureAuth,
                execMmx,
                onUpdate: onUpdate as UpdateFn | undefined,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    });
}

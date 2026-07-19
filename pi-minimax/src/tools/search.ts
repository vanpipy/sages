/**
 * search.ts — L2 tool: minimax_search_query.
 *
 * Thin wrapper around `mmx search query --q <query>`. Returns parsed
 * {query, results: Array<{title, link, snippet, date}>} from mmx-cli's
 * organic search response shape.
 *
 * Note: per mmx-cli docs, /v1/coding_plan/search returns at most 10
 * results per call with no pagination. Refine the query for more.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureAuth, NotAuthedError, type EnsureAuthOptions } from "../services/auth-bootstrap.js";
import { execMmx, type ExecMmxArgs, type ExecMmxResult, type FlatValue } from "../services/exec.js";
import { detectRegionFix } from "../services/region-fix.js";
import type { ToolFailure } from "../services/result.js";

type UpdateFn = NonNullable<EnsureAuthOptions["onUpdate"]>;

export interface SearchResultItem {
    title: string;
    link: string;
    snippet: string;
    date?: string;
}

export type SearchToolInput = {
    query: string;
    apiKey?: string;
    /**
     * Override mmx-cli's auto-detected base URL. Pass `https://api.minimaxi.com`
     * (without `/anthropic/v1` suffix) to work around the upstream bug where
     * mmx-cli 1.0.15/1.0.16 + region=cn returns HTTP 404 for both search and
     * text chat endpoints. See SKILL.md "Known upstream bug".
     */
    baseUrl?: string;
};

export type SearchToolResult =
    | {
          success: true;
          query: string;
          results: SearchResultItem[];
      }
    | ToolFailure;

export interface SearchToolDeps {
    input: SearchToolInput;
    ensureAuth?: (opts?: EnsureAuthOptions) => Promise<void>;
    execMmx?: (args: ExecMmxArgs) => Promise<ExecMmxResult>;
    onUpdate?: UpdateFn;
}

export async function runSearchQuery(deps: SearchToolDeps): Promise<SearchToolResult> {
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
        const execArgs: Record<string, FlatValue> = { q: deps.input.query };
        if (deps.input.baseUrl && deps.input.baseUrl.length > 0) {
            // mmx-cli flag is `--base-url` (kebab-case); our public API uses
            // camelCase `baseUrl`. The args Record keys are the literal mmx
            // flag names (see exec.ts `appendArg`).
            // This is the explicit override; when omitted, execMmx auto-injects
            // the workaround for the mmx-cli region=cn base_url bug (see
            // services/region-fix.ts).
            execArgs["base-url"] = deps.input.baseUrl;
        }
        // Region fix is cached at module level — safe to call per-invocation.
        // Tests inject a regionFix directly via deps.execMmx if they need
        // deterministic behavior; production callers always go through here.
        const regionFix = await detectRegionFix();
        result = await run({
            command: "search query",
            args: execArgs,
            apiKey: deps.input.apiKey,
            regionFix,
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
        return { success: false, error: { code: "TIMEOUT", message: "mmx search query timed out (60s)" } };
    }

    if (result.exitCode !== 0) {
        return {
            success: false,
            error: { code: "UNKNOWN", message: `mmx search query exited ${result.exitCode}: ${result.stderr || result.stdout}` },
        };
    }

    const parsed = result.parsed as { organic?: SearchResultItem[] } | undefined;
    const organic = Array.isArray(parsed?.organic) ? parsed.organic : [];
    return { success: true, query: deps.input.query, results: organic };
}

export function registerSearchTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "minimax_search_query",
        label: "mmx Web Search",
        description:
            "Web search via MiniMax. Runs `mmx search query --q <query>`. " +
            "Returns {success, query, results: [{title, link, snippet, date}]}. " +
            "At most 10 results per call (mmx-cli API limit); refine query for different results. " +
            "On error returns {success: false, error: {code: NOT_AUTHED | MMX_NOT_FOUND | " +
            "TIMEOUT | UNKNOWN, message}}. " +
            "Error codes: NOT_AUTHED (mmx not authed), MMX_NOT_FOUND (mmx not on PATH), " +
            "TIMEOUT (> 60s), UNKNOWN (other).",
        parameters: Type.Object({
            query: Type.String({ description: "Search query string" }),
            apiKey: Type.Optional(Type.String({ description: "Per-call token override" })),
            baseUrl: Type.Optional(Type.String({
                description:
                    "Explicit mmx-cli base URL override. Normally NOT needed: " +
                    "pi-minimax auto-injects the workaround for the mmx-cli " +
                    "1.0.15/1.0.16 region=cn base_url double-prefix bug. " +
                    "Pass only if you need to point at a non-default endpoint " +
                    "(set to 'https://api.minimaxi.com' with no /anthropic/v1 " +
                    "suffix to manually reproduce the auto-fix).",
            })),
        }),
        async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
            const input = params as SearchToolInput;
            const result = await runSearchQuery({
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

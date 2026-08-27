/**
 * registered-tool-wrapper.ts — GC-2026-090.
 *
 * Shared helper that wraps an `execute` function for a Sages
 * orchestrator tool with the canonical ToolResult shape that
 * pi-coding-agent's renderer expects:
 *
 *   { content: [{ type: "text", text: <string> }],
 *     details?: <original return value> }
 *
 * Why this exists
 * ---------------
 * GC-2026-089 fixed a `TypeError: Cannot read properties of undefined
 * (reading 'filter')` crash in `pi-coding-agent`'s render-utils by
 * hand-wrapping 8 orchestrator tools (`task_dispatch`,
 * `dag_synthesize`, `goal_contract_create`, `orchestrator_audit`,
 * `subagent_status`, `subagent_steer`, `subagent_abort`,
 * `subagent_resume`) in a try/catch that returned the canonical
 * shape. The wrapper was copy-pasted into 5 source files.
 *
 * GC-2026-085 had previously caught the same bug class in 2
 * different tools (`todowrite_*`). Future GCs that add orchestrator
 * tools would inevitably catch another batch.
 *
 * This module factors the wrapper into a single helper so:
 *   - Each `registerTool` call becomes a one-liner.
 *   - Adding a new tool cannot forget the wrapper — the helper
 *     enforces it by construction.
 *   - The error / pass-through / await semantics live in one place
 *     and have a single test surface (`registered-tool-wrapper.test.ts`).
 *
 * Semantics (preserved exactly from GC-2026-089)
 * ---------------------------------------------
 *  1. Awaits the execute call (so async resolves before JSON.stringify).
 *     Without this, `JSON.stringify(Promise)` would yield `"{}"` and
 *     the renderer would parse an empty object.
 *  2. Pass-through if `Array.isArray(result.content)` — the legacy
 *     ToolResult shape returned by `executeDAGSynthesize`,
 *     `executeGoalContractCreate`, `executeOrchestratorAudit`, and the
 *     error-response helpers inside `executeTaskDispatch`. Pass-through
 *     preserves object identity so callers that depend on referential
 *     equality (or that have already formatted the text for the LLM)
 *     keep working.
 *  3. Otherwise wraps in
 *     `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
 *        details: result }`.
 *  4. On exception:
 *     `{ content: [{ type: "text", text: `${toolName} error: ${message}` }],
 *        details: { status: "error", error: message } }`.
 *
 * Error message coercion matches the GC-2026-089 inline wrappers:
 * `err instanceof Error ? err.message : String(err)`.
 */

// ───────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────

/**
 * Canonical ToolResult shape that every registered orchestrator tool
 * must return. Mirrors what pi-coding-agent's `getTextOutput` reads via
 * `result.content.filter((c) => c.type === "text")`.
 *
 * `details` is optional but, when present, holds the original return
 * value from the inner execute function. Downstream consumers that
 * want structured data (without re-parsing text) read from here.
 */
export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
}

/**
 * Context object pi-coding-agent passes to every registered tool's
 * `execute`. `cwd` is the only field Sages tools actually use — the
 * others (`signal`, `onUpdate`) are dropped at the helper boundary
 * because none of the 8 wrapped tools need them.
 */
export interface ExecuteContext {
	cwd: string;
}

// ───────────────────────────────────────────────────────────────────────
// Helper
// ───────────────────────────────────────────────────────────────────────

/**
 * Wraps an inner execute function with the canonical ToolResult
 * envelope. See the module docstring for the four semantics.
 *
 * Type parameters
 * ---------------
 * - `TParams`: the parameter shape of the tool (forwarded to `execute`
 *   verbatim — the helper does not inspect or transform it).
 * - `TResult`: the return shape of the inner execute function. Usually
 *   a plain object; may also be `ToolResult` itself (legacy path) or
 *   `void` / `null` / `undefined` (edge cases).
 *
 * The returned function has the signature pi-coding-agent's
 * `registerTool` expects (5 positional arguments, returns Promise).
 */
export function wrapRegisteredTool<TParams, TResult>(
	toolName: string,
	execute: (params: TParams, ctx: ExecuteContext) => TResult | Promise<TResult>,
): (
	_toolCallId: string,
	params: TParams,
	_signal: unknown,
	_onUpdate: unknown,
	_ctx: unknown,
) => Promise<ToolResult> {
	return async (
		_toolCallId: string,
		params: TParams,
		_signal: unknown,
		_onUpdate: unknown,
		_ctx: unknown,
	): Promise<ToolResult> => {
		try {
			// ctx is typed as `unknown` at the registerTool boundary (the
			// pi-coding-agent contract), but every Sages tool reads `ctx.cwd`.
			// Narrow with a fallback to keep the type checker quiet without
			// changing runtime behavior (the fallback is unreachable in practice).
			const safeCtx: ExecuteContext =
				(_ctx as ExecuteContext | undefined) ?? { cwd: process.cwd() };
			const result = await execute(params, safeCtx);

			// Pass-through if the inner execute already returned the
			// canonical ToolResult shape. The legacy contract is
			// `Array.isArray(result.content)` — we check it directly so
			// we don't accidentally depend on the import of `ToolResult`
			// (which would create a circular shape check).
			if (
				result !== null &&
				typeof result === "object" &&
				Array.isArray((result as { content?: unknown }).content)
			) {
				return result as unknown as ToolResult;
			}

			return {
				content: [
					{ type: "text", text: JSON.stringify(result, null, 2) },
				],
				details: result,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: `${toolName} error: ${message}`,
					},
				],
				details: { status: "error", error: message },
			};
		}
	};
}

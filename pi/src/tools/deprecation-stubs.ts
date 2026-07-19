/**
 * Shared deprecation-stub registrar.
 *
 * Three role-tool files (fuxi-tools.ts, luban/index.ts, gaoyao/tools.ts)
 * previously open-coded the same loop: build a `stubs` array, iterate and
 * call `pi.registerTool({...})` with a JSON deprecation response. This was
 * a 3-way 88-line duplicate.
 *
 * This helper centralises the loop. New role modules should:
 *
 *   import { registerDeprecationStubs } from "../deprecation-stubs.js";
 *
 *   registerDeprecationStubs(pi, [
 *     { name: "fuxi_xxx",   hint: "...", deprecationNote: "..." },
 *     { name: "fuxi_yyy",   hint: "...", deprecationNote: "..." },
 *   ]);
 *
 * The returned tool shape (label/description/error payload) is byte-compatible
 * with the previous inline loops, so any tests pinned to it continue to pass.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface DeprecationStub {
	/** Tool name to register (e.g. "fuxi_request"). */
	name: string;
	/** Human-readable hint surfaced in the error payload. */
	hint: string;
	/** Short note explaining what replaced the old tool. */
	deprecationNote: string;
}

/**
 * Register a set of deprecation stubs on the given pi extension.
 * Each stub returns `{ isError: true }` with a JSON payload pointing the
 * caller at the replacement tool.
 */
export function registerDeprecationStubs(
	pi: ExtensionAPI,
	stubs: DeprecationStub[],
): void {
	for (const stub of stubs) {
		pi.registerTool({
			name: stub.name,
			label: `[Deprecated] ${stub.name}`,
			description: `DEPRECATED (${stub.deprecationNote}): ${stub.hint}`,
			parameters: TypeObjectEmpty(),
			async execute() {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: false,
								error: `${stub.name} is deprecated. ${stub.hint}`,
								hint: stub.hint,
								deprecated: true,
								replacement: stub.hint.match(/Use (\w+)/)?.[1] ?? null,
							}),
						},
					],
					isError: true,
					details: { deprecated: true, replacement: stub.hint },
				};
			},
		});
	}
}

/**
 * TypeBox-equivalent of `Type.Object({})` without taking a runtime dep
 * on @sinclair/typebox here. The role-tool files all use TypeBox directly,
 * but this helper stays minimal — pi accepts any "parameters" shape.
 */
function TypeObjectEmpty(): { type: "object"; additionalProperties: false; properties: Record<string, never> } {
	return {
		type: "object",
		additionalProperties: false,
		properties: {},
	};
}
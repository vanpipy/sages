/**
 * bucket-detector.ts — GC-2026-040 T2
 *
 * Maps a bash command string to a BucketKey so the bash wrapper can
 * enforce per-tool-call timeouts via signalForTool(bucket) per
 * design-timeout-architecture.md.
 *
 * Detection order: network → fullTest → test → read → search → other.
 * First matching pattern wins. The first command in a pipeline
 * (before |, ;, &, &&) is used.
 */

import type { BucketKey } from "../run-controller.js";

const NETWORK: ReadonlyArray<RegExp> = [
	/^git\s+(?:fetch|pull|clone|ls-remote)\b/,
	/^(?:curl|wget)\s/,
	/^npm\s+(?:install|i)\b/,
	/^yarn\s+(?:install|add|i)\b/,
	/^bun\s+(?:install|add)\b/,
	/^pnpm\s+(?:install|i|add)\b/,
];

const FULL_TEST: ReadonlyArray<RegExp> = [
	/^bun\s+test\s*$/,
	/^npm\s+test\s*$/,
	/^pnpm\s+test\s*$/,
	/^yarn\s+test\s*$/,
	/^npx\s+(?:jest|vitest)\s*$/,
	/^jest\s*$/,
	/^vitest\s*$/,
];

const TEST: ReadonlyArray<RegExp> = [/^bun\s+test\s+\S/, /^npx\s+(?:jest|vitest)\s+\S/];

const READ: ReadonlyArray<RegExp> = [
	/^(?:cat|head|tail|less|more)\s/,
	/^(?:cat|head|tail|less|more)$/,
];

const SEARCH: ReadonlyArray<RegExp> = [/^(?:grep|rg|awk|sed|find)\b/];

function firstCommand(command: string): string {
	const trimmed = command.trim();
	if (!trimmed) return trimmed;
	return trimmed.split(/[|&;]/)[0]?.trim() ?? trimmed;
}

export function detectBucket(command: string): BucketKey {
	const first = firstCommand(command);
	if (!first) return "other";

	for (const re of NETWORK) if (re.test(first)) return "network";
	for (const re of FULL_TEST) if (re.test(first)) return "fullTest";
	for (const re of TEST) if (re.test(first)) return "test";
	for (const re of READ) if (re.test(first)) return "read";
	for (const re of SEARCH) if (re.test(first)) return "search";
	return "other";
}
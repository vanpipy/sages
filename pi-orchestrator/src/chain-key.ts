/**
 * chain-key.ts — GC-2026-059
 *
 * Stable chain-key derivation for the orchestrator's tool-call history.
 * Mirrors deepseek-harness's `repeat-tool-reminder` design (chain-key
 * = (toolName, canonicalized-args)) without porting the full
 * configuration system (include/exclude patterns, per-agent
 * WeakMap, runtime-diagnostics integration). Sages is a thin
 * orchestrator; we only need the chain-key mechanic, not the
 * full guard config.
 *
 * The chain-key solves a precision problem with the old per-tool
 * counters in orchestrator advisory: "goal_contract_create called 3 times" fires
 * even when the LLM is legitimately refining the goal (different
 * args each call). Chain-key fires only when args are identical,
 * which matches the actual "stuck" semantics we want to detect.
 *
 * Usage:
 *   const counts = tallyChainCounts(history);
 *   const maxChain = findMaxChain(counts);
 *   if (chainCountAtLeast(counts, 3)) {
 *     // The orchestrator is calling the same (tool, args) 3+ times
 *   }
 */

import { canonicalize } from "./canonicalize.js";

export interface ChainToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Backward-compat alias for `canonicalize` (see `./canonicalize.ts`).
 *
 * Pre-refactor this module defined its own `canonicalJSON` function
 * (without recursive undefined-skipping). Post-refactor the algorithm
 * moved to `./canonicalize.ts` and gained the recursive
 * undefined-skipping behavior mandated by GC-2026-091. This alias
 * preserves the public export name for callers that import it
 * directly (the package's `src/index.ts` re-exports the chain-key
 * surface via `export * from "./chain-key.js"`, so this name is part
 * of the public API).
 *
 * Behavior change vs. pre-refactor: `canonicalJSON(undefined)` now
 * returns `""` (was `undefined` from `JSON.stringify(undefined)`),
 * and object keys whose value is `undefined` are skipped (was:
 * included with the literal value). In practice the chain-key is
 * built from JSON-deserialized tool-call args which contain no
 * `undefined` keys, so this is a no-op for the chain-key's primary
 * use case (stuck-call detection).
 */
export const canonicalJSON = canonicalize;

/**
 * Build a stable chain-key for a tool call. Two calls produce the same
 * key if and only if their (toolName, canonicalized-input) pair is
 * equal.
 *
 * Format: `<toolName>::<canonicalJSON>`. The `::` separator avoids
 * collisions between toolName and the first JSON character.
 */
export function chainKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}::${canonicalize(input)}`;
}

/** Per-chain aggregate. */
export interface ChainCount {
  /** Number of consecutive-or-total calls in this chain. */
  count: number;
  /** Sample call from this chain (the first occurrence). */
  sample: ChainToolCall;
}

/**
 * Tally chain counts across a sequence of tool calls. Each call
 * increments the count for its chain-key; different chain-keys are
 * counted independently. Returns a Map keyed by chain-key.
 *
 * Note: this counts total occurrences (not "consecutive"). For "stuck
 * on the same call" detection, total is sufficient — if the LLM is
 * calling the same tool with the same args repeatedly, total count
 * is high even if calls are interleaved with other tools.
 *
 * If you need true "consecutive" semantics (call X, then X again
 * without anything in between), use `tallyConsecutiveChains` (not
 * implemented — Sages doesn't need it).
 */
export function tallyChainCounts(
  calls: Iterable<ChainToolCall>,
): Map<string, ChainCount> {
  const counts = new Map<string, ChainCount>();
  for (const call of calls) {
    const key = chainKey(call.toolName, call.input);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { count: 1, sample: call });
    }
  }
  return counts;
}

/**
 * Find the chain with the highest count. Returns null if the map
 * is empty. On tie, returns the first one (Map iteration order).
 */
export function findMaxChain(
  counts: Map<string, ChainCount>,
): ChainCount | null {
  if (counts.size === 0) return null;
  let top: ChainCount | null = null;
  for (const entry of counts.values()) {
    if (top === null || entry.count > top.count) {
      top = entry;
    }
  }
  return top;
}

/**
 * True when any chain meets or exceeds the threshold. Used by rules
 * like `repeat_call_chain` to decide whether to fire.
 */
export function chainCountAtLeast(
  counts: Map<string, ChainCount>,
  threshold: number,
): boolean {
  for (const entry of counts.values()) {
    if (entry.count >= threshold) return true;
  }
  return false;
}
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
 * counters in orchestrator advisory: "dag_synthesize called 3 times" fires
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

export interface ChainToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Canonicalize a value so that property order doesn't affect equality.
 * Recursively sorts object keys and JSON-stringifies. Arrays preserve
 * order (positional semantics — [1,2] and [2,1] are different).
 *
 * Used to build chain-keys that are stable across YAML/JSON formatting
 * variations. Two args objects that are semantically equivalent
 * produce the same canonical string regardless of key order.
 *
 * Mirrors the canonicalization in
 * `pi-orchestrator/src/goal-lock.ts:computeGoalHash` — same algorithm,
 * different scope.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") +
    "}"
  );
}

/**
 * Build a stable chain-key for a tool call. Two calls produce the same
 * key if and only if their (toolName, canonicalized-input) pair is
 * equal.
 *
 * Format: `<toolName>::<canonicalJSON>`. The `::` separator avoids
 * collisions between toolName and the first JSON character.
 */
export function chainKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}::${canonicalJSON(input)}`;
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
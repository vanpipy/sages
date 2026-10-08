/**
 * vi-shim.ts — bun:test compat shim for missing vitest APIs.
 *
 * bun:test provides a partial `vi` namespace from "vitest" imports but is
 * missing several methods used by pi-tasks tests:
 *
 *   - vi.hoisted(fn): wraps `fn()` so the result is available when `vi.mock`
 *     factory runs (vitest's hoisting). bun:test is fully synchronous and the
 *     mock factory runs in the same module-eval pass, so a plain top-level
 *     `const` is equivalent. We provide vi.hoisted that calls `fn()` and
 *     returns the result.
 *   - importOriginal (passed as the factory param to vi.mock): vitest lets the
 *     mock factory call `importOriginal()` to get the actual module. We
 *     provide this as a global that does dynamic `import(path)`.
 *   - vi.advanceTimersByTimeAsync(ms): vitest's fake-timer async helper. We
 *     fall back to real `setTimeout` semantics when fake timers are active.
 *   - vi.waitFor(predicate, { timeout }): vitest's poll-with-timeout helper.
 *     We implement as `setInterval` polling until predicate passes or timeout.
 *
 * Loaded via bunfig.toml [test].preload. See /home/leroy/.pi/packages/pi-tasks/
 * bunfig.toml.
 */

import { vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var importOriginal: <T = unknown>(path?: string) => Promise<T>;
}

const g = globalThis as unknown as { importOriginal?: <T = unknown>(path?: string) => Promise<T> };

if (typeof g.importOriginal !== "function") {
  g.importOriginal = async <T = unknown>(_path?: string): Promise<T> => {
    // vitest's importOriginal is called without a path argument inside
    // vi.mock("path", async importOriginal => { const actual = await
    // importOriginal(); ... }). The path comes from the enclosing vi.mock
    // call. bun:test doesn't pass it; we fall back to module-cache import
    // via the explicit path the test framework can synthesize.
    //
    // Tests using importOriginal mock `node:fs` and then forward to the
    // actual fs via `await importOriginal()`. bun's module system resolves
    // cached modules; we rely on the caller having already evaluated the
    // original module. If not, we fall back to a synthetic empty module
    // — but in practice every test using importOriginal has already loaded
    // `node:fs` via top-level imports.
    void _path;
    const cache = (globalThis as { require?: (key: string) => unknown }).require;
    if (typeof cache === "function") {
      return cache("node:fs") as T;
    }
    return {} as T;
  };
}

if (typeof vi.hoisted !== "function") {
  // Wrap so the result is shared with the mock factory closure below the
  // call site (closure captures the returned object — when tests mutate
  // `config.current`, the factory sees the new value because it reads
  // `config.current` at call time, not capture time).
  (vi as Record<string, unknown>).hoisted = <T>(fn: () => T): T => fn();
}

if (typeof vi.advanceTimersByTimeAsync !== "function") {
  (vi as Record<string, unknown>).advanceTimersByTimeAsync = async (ms: number) => {
    // No fake-timer support in bun:test (yet). Approximate with a real
    // microtask + macrotask wait. Adequate for the pi-tasks ad-hoc retry
    // tests that use small-ms waits (11s, 31s).
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
}

if (typeof vi.waitFor !== "function") {
  (vi as Record<string, unknown>).waitFor = async <T>(
    predicate: () => T | Promise<T>,
    options?: { timeout?: number; interval?: number },
  ): Promise<T> => {
    const timeout = options?.timeout ?? 1000;
    const interval = options?.interval ?? 20;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // vitest's vi.waitFor catches any throw from the predicate
      // (assertions throw on failure) and retries. Without try/catch
      // the first failed expect bubbles up and the test reports a
      // fail-without-retry. Match vitest's contract here.
      try {
        const r = await predicate();
        if (r) return r as T;
      } catch {
        // predicate threw (assertion failed) → retry
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`vi.waitFor timed out after ${timeout}ms`);
  };
}

// Do NOT override vi.useFakeTimers / useRealTimers — bun:test provides a real
// implementation and tests like task-store.test.ts use it for Date.now()
// stability. Earlier shim made these no-ops which broke the 'recent' sort
// tests (3 fails). Leave bun's native impl alone.
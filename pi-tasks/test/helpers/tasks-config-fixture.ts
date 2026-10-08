/**
 * tasks-config-fixture.ts — real-file tasks-config fixture for tests.
 *
 * GC-2026-116: replaces the `vi.mock("../src/tasks-config.js", ...)`
 * pattern that 5 test files used. Under bun:test, `vi.mock` factories
 * leak across test files: the first file to register a mock keeps its
 * factory (and its captured `cfg` singleton) active for every later
 * file in the same `bun test` invocation. The leak surfaced as
 * `tasks-config.test.ts` failing when run after any of those files,
 * because the leaked mock's `loadGlobalTasksConfig` returned the
 * other file's `cfg.current` value (typically `{taskScope: "memory"}`)
 * instead of reading the real file.
 *
 * The fix: write a real `<agentDir>/tasks-config.json` to a per-test
 * temp directory and point `PI_CODING_AGENT_DIR` at it. `getAgentDir()`
 * consults that env var before `os.homedir()` (which caches its result
 * from the scratch HOME installed by `test/setup.ts`), so the temp dir
 * is what the production code reads.
 *
 * Usage:
 *
 *   import { installTasksConfig, uninstallTasksConfig } from "./helpers/tasks-config-fixture.js";
 *
 *   beforeEach(() => { installTasksConfig({}); });
 *   afterEach(() => { uninstallTasksConfig(); });
 *
 * Pass a config body to a `beforeEach` (or inside a test) to override
 * the default `{}` for that scope.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentDir: string | undefined;

/** Write `config` to a fresh agent dir and point the env var at it. */
export function installTasksConfig(config: Record<string, unknown> = {}): void {
  uninstallTasksConfig();
  const dir = mkdtempSync(join(tmpdir(), "pi-tasks-cfg-fixture-"));
  writeFileSync(join(dir, "tasks-config.json"), JSON.stringify(config));
  process.env.PI_CODING_AGENT_DIR = dir;
  currentDir = dir;
}

/** Restore the previous `PI_CODING_AGENT_DIR` (or delete it). */
export function uninstallTasksConfig(): void {
  if (currentDir) {
    rmSync(currentDir, { recursive: true, force: true });
    currentDir = undefined;
  }
  delete process.env.PI_CODING_AGENT_DIR;
}

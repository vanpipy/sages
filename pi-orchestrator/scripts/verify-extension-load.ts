#!/usr/bin/env bun
/**
 * verify-extension-load.ts — Surface the silent fail-soft path in
 * pi-coding-agent's extension loader (GC-2026-extension-load-verify).
 *
 * Background: the host loader at
 *   pi-coding-agent/dist/core/extensions/loader.js:363-381
 * catches errors during extension load and returns
 *   { extension: null, error: "..." }
 * without ever logging the error. Result: packages can be registered in
 * settings.json, files present on disk, and the loader still silently
 * skips them. The user has no way to know until a tool they expect
 * fails to register (e.g. workflow_run emits `workflow:start` with
 * no listener and the pipeline hangs — exactly the failure mode
 * observed in the GC-2026-task-feeding-and-decomposition session).
 *
 * What this verifier does:
 *   1. Read `~/.pi/agent/settings.json#packages`.
 *   2. For each local-path package (skipping `npm:` peers), locate the
 *   extension entry via `resolveExtensionEntries`-equivalent logic:
 *     - Read `package.json#pi.extensions` and pick entries whose files exist.
 *     - Fall back to `index.ts` / `index.js` if no manifest entries.
 *   3. Attempt to import each entry via `jiti` (the same loader pi-coding-agent
 *   uses internally) with `{ default: true }`.
 *   4. Verify the result is a function.
 *   5. Report any failures with file:line + recovery command.
 *
 * Exit 0 iff every registered extension loads + has a function default.
 * `npm:` peer entries are NOT touched here — npm owns their lifecycle.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const PI_DIR = process.env.PI_DIR ?? join(process.env.HOME ?? "", ".pi");
const SETTINGS_PATH = join(PI_DIR, "agent", "settings.json");
const HOST_PEERS = [
  "pi-subagents",
  "pi-evaluator",
  "pi-codebase-memory",
  "pi-tasks",
  "pi-orchestrator",
];

// GC-2026-extension-load-verify-fix (follow-up): defer the jiti import so
// the smoke test can find jiti from the installed package's node_modules
// when standard resolution from this script's directory fails. Symptom of
// the regression: `Cannot find module 'jiti/static' from
// .../pi-orchestrator/scripts/verify-extension-load.ts` after install.sh,
// because install.sh only runs `bun install` in $PKG_DIR (the installed
// copy), not in $LOCAL_REPO_ROOT/pi-orchestrator (the source repo this
// script lives in). jiti is a devDependency, so the source repo's
// node_modules may never have it populated for end users who never ran
// `bun install` in pi-orchestrator/.
//
// Resolution order:
//   1. Standard resolution — works for developers who ran `bun install` in
//      pi-orchestrator/ (jiti lands in devDependencies).
//   2. Installed copy at $PI_DIR/packages/pi-orchestrator/node_modules/jiti
//      — populated by install_orchestrator_files's `bun install` step.
//      install.sh is the canonical entry point for this verifier, so this
//      path is always available in the install flow.
//   3. Lazy require via createRequire so the module is loaded on first
//      use (avoids crashing at script load when both resolution paths
//      above would miss).
type JitiFactory = (id: string, opts?: Record<string, unknown>) => {
  import: (path: string, opts?: Record<string, unknown>) => Promise<unknown>;
};

function loadCreateJiti(): JitiFactory {
  const require = createRequire(import.meta.url);
  // (1) standard resolution — script-local node_modules walk-up.
  try {
    return require("jiti/static") as { createJiti: JitiFactory };
  } catch {
    // (2) installed copy — $PKG_DIR is guaranteed to have run `bun install`
    // because install.sh invokes install_orchestrator_files → bun install
    // before run_post_install_gates → this script.
    const installed = join(
      PI_DIR,
      "packages",
      "pi-orchestrator",
      "node_modules",
      "jiti",
      "lib",
      "jiti-static.mjs",
    );
    if (existsSync(installed)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(installed) as { createJiti: JitiFactory };
    }
    throw new Error(
      `Cannot resolve jiti: tried (1) standard resolution from ${import.meta.url} ` +
        `and (2) installed copy at ${installed}. Run \`bun install\` in the ` +
        `pi-orchestrator source repo (or \`bash pi-orchestrator/scripts/install.sh --force\` ` +
        `to populate the installed copy), then re-run this verifier.`,
    );
  }
}

const { createJiti } = loadCreateJiti();

interface Finding {
  pkg: string;
  reason: string;
}

function readPackages(): string[] {
  if (!existsSync(SETTINGS_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as {
      packages?: string[];
    };
    return Array.isArray(data.packages) ? data.packages : [];
  } catch {
    return [];
  }
}

function readManifest(dir: string): { extensions?: string[] } | null {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      pi?: { extensions?: string[] };
    };
    return data.pi ?? null;
  } catch {
    return null;
  }
}

function resolveExtensionEntries(dir: string): string[] {
  const manifest = readManifest(dir);
  if (manifest?.extensions?.length) {
    const entries: string[] = [];
    for (const extPath of manifest.extensions) {
      const resolved = resolve(dir, extPath);
      if (existsSync(resolved)) entries.push(resolved);
    }
    if (entries.length > 0) return entries;
  }
  // Fall through to index.{ts,js} (matches loader.js's resolveExtensionEntries).
  const indexTs = join(dir, "index.ts");
  const indexJs = join(dir, "index.js");
  if (existsSync(indexTs)) return [indexTs];
  if (existsSync(indexJs)) return [indexJs];
  return [];
}

async function tryLoad(entryPath: string): Promise<{ ok: boolean; error?: string }> {
  // Match loader.js: jiti with moduleCache:false, default:true. We don't
  // pass the host's virtualModules because we don't know whether the
  // session is running under Bun binary or Node.js; a stock jiti config
  // catches the common case (import resolution via filesystem).
  try {
    const here = new URL(import.meta.url).href;
    const jiti = createJiti(here, { moduleCache: false });
    const mod = await jiti.import(entryPath, { default: true });
    if (typeof mod !== "function") {
      return {
        ok: false,
        error: `default export is ${typeof mod}, not a function`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const packages = readPackages();
  const localPackages = packages.filter((p) => !p.startsWith("npm:"));
  const findings: Finding[] = [];

  if (localPackages.length === 0) {
    console.log(
      "verify:extension-load: PASS (no local-path packages registered in settings.json)",
    );
    process.exit(0);
  }

  for (const pkg of localPackages) {
    if (!existsSync(pkg)) {
      findings.push({ pkg, reason: "directory does not exist (install.sh --force to repair)" });
      continue;
    }
    const entries = resolveExtensionEntries(pkg);
    if (entries.length === 0) {
      findings.push({
        pkg,
        reason: "no extension entry resolvable (package.json#pi.extensions missing or paths missing, and no index.{ts,js})",
      });
      continue;
    }
    for (const entry of entries) {
      const result = await tryLoad(entry);
      if (!result.ok) {
        findings.push({
          pkg,
          reason: `${entry.replace(pkg + "/", "")}: ${result.error ?? "unknown"}`,
        });
      }
    }
  }

  if (findings.length === 0) {
    console.log(
      `verify:extension-load: PASS (${localPackages.length} package(s) loaded; host peers: ${HOST_PEERS.join(", ")})`,
    );
    process.exit(0);
  }
  console.error(
    `verify:extension-load: FAIL (${findings.length} issue(s); packages already in settings.json but pi-coding-agent's loader will silently skip them)`,
  );
  for (const f of findings) {
    console.error(`  ${f.pkg}`);
    console.error(`    -> ${f.reason}`);
  }
  console.error("");
  console.error("Recovery:");
  console.error("  1. Inspect the file:line above for the actual loader error");
  console.error("  2. Re-run install.sh --force to re-copy files + reinstall deps");
  console.error("  3. Restart the pi session so the loader re-runs with fresh caches");
  process.exit(1);
}

main();
---
gc_id: GC-2026-extension-load-verify
title: Surface pi-coding-agent's silent extension-loader fail-soft
severity: major
---

## What happened

`workflow_run` emitted `workflow:start` and the pipeline hung indefinitely
because pi-tasks + pi-subagents extensions were not loaded in the active
session. The packages were correctly installed on disk
(`~/.pi/packages/pi-orchestrator`, `~/.pi/packages/pi-tasks`,
`~/.pi/packages/pi-subagents`) and registered in
`~/.pi/agent/settings.json#packages`. The cause was the host loader's
silent fail-soft path at
`pi-coding-agent/dist/core/extensions/loader.js:363-381`:

```js
async function loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken) {
    const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
    try {
        const factory = await loadExtensionModule(resolvedPath, cacheToken);
        if (!factory) {
            return { extension: null, error: "..." };
        }
        // ... register api ...
        return { extension, error: null };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { extension: null, error: `Failed to load extension: ${message}` };
    }
}
```

The error is captured but **never logged**. The caller
(`loadExtensionsInternal`) pushes them into an `errors[]` list that the
upstream caller (`ExtensionRunner` / `discoverAndLoadExtensions`) does
not surface. End result: extension failure is invisible until a future
session tries to use a tool that was supposed to come from the unloaded
extension. The GC-2026-main-agent-tool-surface GC (postmortem) flagged
this same class of bug as "loader.js fail-softs silently"; that GC
fixed the directory-existence check but did not cover the load-itself
error path.

This GC closes the loop by re-running the loader's logic at install +
verify time so the user sees a clear error and a recovery command
**before** the silent failure manifests in a hung workflow.

## Why this design

The cleanest fix would be a one-line patch in `loader.js` adding
`console.error` to the catch block. We considered that, but `loader.js`
lives in `node_modules` and gets overwritten on every `bun install` /
`npm install`. A persistent fix has to live in our own source tree.

Two locations where the fix surfaces the failure:

1. **Install time** (`scripts/install.sh`, after `verify_package_existence`):
   `bun run scripts/verify-extension-load.ts` runs at the end of every
   install. If anything fails, the install exits 1 with a clear
   "Re-run with --force to repair" message. Skipped if `bun` is not on
   PATH (legacy fallback).
2. **Verify time** (`bun run verify:all`): the new
   `verify:extension-load` gate runs alongside the other 8 verifiers.
   CI / pre-merge hooks catch the failure even when install is bypassed.

The verifier itself imports each registered extension via `jiti` with
`{ default: true }` (the same loader config pi-coding-agent uses
internally). For each local-path package in `settings.json#packages`,
it reads `package.json#pi.extensions`, resolves each entry, runs
`jiti.import(entry, { default: true })`, and asserts the result is a
function. Failures are printed with the entry path relative to the
package root so the user can grep the actual error.

`npm:` peer entries (e.g. `npm:pi-mcp-adapter`, `npm:@cortexkit/aft-pi`)
are skipped by design — we can't jiti-import what we don't own the
lifecycle of.

## What this does NOT fix

The gate catches **load failures** (broken imports, missing deps,
typos in `package.json#pi.extensions`). It does NOT catch
**session-state** failures: a session that started before the most
recent install and has not been refreshed will still load the old
extension cache. The recovery for that class is documented in
`verify:extension-load`'s output ("Restart the pi session so the
loader re-runs with fresh caches") and in the recovery commands above.

We considered adding a session-warmup invocation (`ExtensionRunner.bind`
or `clearExtensionCache()`) but rejected it as out of scope for this GC:
those APIs are not exposed by the host, and forcing them risks
interfering with the running session. Documented the limitation in the
postmortem + recovery instructions.

## Follow-ups

- **Patch loader.js fail-soft path** (out of scope here): upstream
  fix would be adding `console.error` in the catch block. Until then,
  this verifier is the only safety net.
- **Extend verify-extension-load to also call `factory(api)`** with
  a stub `api` and assert no throw. The current implementation only
  checks import success + default-export type; an exception during
  factory initialization (e.g. a `registerTool` call that throws) would
  still slip through. Deferred — requires a stub ExtensionAPI and
  risks false positives from extensions that legitimately need a real
  runtime context.
- **Track session-start refresh in install.sh post-install message**
  ("you may need to exit and restart pi for changes to take effect")
  — currently the message says "Restart pi: exit && pi" which is the
  same thing in different words, but a more explicit note about
  extension cache vs. file changes would be friendlier.
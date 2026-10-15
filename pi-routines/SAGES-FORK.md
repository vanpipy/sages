# `pi-routines` — Sages fork

This package is a verbatim fork of the upstream
[`@davecodes/pi-routines`](https://github.com/Davidcreador/pi-routines)
extension, vendored into the Sages monorepo so the orchestrator can ship the
scheduler with the rest of its workflow runtime instead of depending on an
npm-published external package.

## Upstream

- Repository: <https://github.com/Davidcreador/pi-routines>
- Version: **v0.6.0**
- Commit SHA: `c54f09a27252f3638922f3d23e58f7287f756168`
- License: **MIT** (inherited — see [`LICENSE`](./LICENSE))

## Fork intent

Sages internalizes the scheduler so a routine runtime can live next to the
`pi-orchestrator`, `pi-tasks`, and `pi-subagents` packages it actually drives.
This package replaces the npm `@davecodes/pi-routines` dependency on the path
to that goal. Sages diverges by **owning** the scheduler — trimming
non-essential triggers, renaming the public surface to `Scheduler*`, and
rebasing the install path onto the Sages monorepo's `pi-*/` workspace shape.

## Divergence list

The fork lands in three pieces, scoped so each piece is independently
reversible:

1. **v0.6.0-fork.0 (this commit)** — verbatim fork. No code changes, no
   rename. Only `package.json`, `SAGES-FORK.md`, and the workspace
   registration differ. The new local package is on disk but **not yet
   wired** — Sages builds still resolve `@davecodes/pi-routines` from
   `node_modules`. The Cleanup phase swaps the import paths.
2. **Trim** (follow-up intent) — drop the `api` trigger + HTTP server
   (`src/server.ts`, `src/hooks.ts` server restart hooks, `templates/api-*.json`,
   the `/routine-server` slash command and the `routine-server` tool, the
   tests that exercise them), drop the `github` trigger + poller
   (`src/github-poller.ts`, `templates/github-*.json`, `tests/github-*.test.ts`),
   drop the NL `/schedule` slash command (`src/commands/schedule.ts`,
   `src/schedule-nl.ts`, `tests/schedule-nl.test.ts`).
3. **Rename** (follow-up intent) — `Routine*` → `Scheduler*` rename across
   the public surface (types, exports, commands, tools, runtime state).

Future divergence entries (e.g. logic drifts beyond the rename) get appended
here in chronological order so future maintainers can read the fork as a
changelog.

## Sync procedure

When the upstream ships a new release we want to track, sync it onto this
package with a fast-forward or rebased merge. From inside the Sages clone:

```sh
# One-time: register the upstream remote
git remote add upstream https://github.com/Davidcreador/pi-routines.git
git fetch upstream --tags

# Per-sync: rebase this fork onto the new upstream tag, then rerun check
git switch main                                    # upstream tracking branch
git merge --ff-only upstream/main                  # or `git rebase upstream/main`
git switch sages/pi-routines-fork/2026-Q1
git rebase main                                    # replay fork changes on top
cd pi-routines && pnpm check                      # typecheck + lint + test
```

If `git rebase` cannot replay cleanly (because the divergence passes in
"Divergence list" have already landed), port them onto the new base before
the rebase instead of force-pushing a rewritten history. The
`Divergence list` above is the contract — every delta from upstream must
appear in that list, in order, with a link to the commit that introduced it.

## License

MIT. Copyright (c) 2026 David Creador. Inherited verbatim from upstream; see
[`LICENSE`](./LICENSE). Any subsequent Sage-authored changes are also MIT and
attributed to the Sages contributors listed in `package.json#contributors`.

# Reviewer as regression auditor (Layer 3 verification)

> **Pattern:** Delegate the post-merge full-suite gate to a `reviewer` worker spawned in **regression-auditor** mode when the producer's Layer 1 slice-scoped gates are not enough to certify the merge.
> **When to use:** After `git merge --no-ff <branch>`, before `git push`; whenever the project's full suite takes **> 2 minutes** or root's machine is busy enough that blocking on the suite would stall the workflow.

## Problem

Sages verification has three layers (see `AGENTS.md` § "Cross-worker gates"):

- **Layer 1** — the producer slot runs slice-scoped gates on its
  `files_touched[]`. Catches breakage inside the diff.
- **Layer 2** — the root session runs the full suite at integration time
  after the merge. Catches cross-file breakage.
- **Layer 3** — a dedicated `reviewer` worker in regression-auditor mode
  re-runs the full suite in its own context so root's attention stays
  free.

The producer's Layer 1 result is **evidence**, not a substitute: it
answers "did this worker break what they touched?", not "did the merge
break anything anywhere?" Root needs Layer 2 — but Layer 2 pins the
workspace and the root session for the duration of the suite. On a busy
night with a 30-minute e2e suite, that is 30 minutes of root context
sitting idle while the user is asking for the next deliverable.

There is also a real failure mode Layer 1 cannot catch: the merge itself
can be clean on the worker's branch and break on main because of an
ordering interaction with a sibling DAG that landed between the worker's
base cut and the merge. Layer 3 catches that because the auditor
runs against the merged tree on the integration base, not against the
producer's pre-merge branch.

## Solution

Dispatch a `reviewer` (subagent_type `developer` with `mode:
regression-auditor`) immediately after the merge, with:

- `worker_branch` = the merged branch (or HEAD if the merge was a
  fast-forward / squash).
- `base_commit` = the SHA before the merge.
- **No `isolation`** — this is a root-cwd role; the auditor operates
  from root cwd and uses `git show` / `git diff` / running tests
  against the merged tree.
- The auditor emits the standard 7-field typed artifact with
  `validation` carrying the raw gate output.

The auditor's finding severity gates the next action:

| Finding | Root action |
|---|---|
| `severity: blocker` | **Hard reject.** Roll back the merge. Re-dispatch the producer with the failure in the prompt. |
| `severity: major` | Stop, fix, re-run auditor. |
| `severity: minor` | Note in the artifact's `open_questions[]`; do not block the merge. |
| Pass | Push if user-requested; otherwise leave local. |

## Code

Spawn the regression auditor after merge:

```ts
// After `git merge --no-ff ws-<label>` on the root session.
Agent({
  subagent_type: "developer",
  prompt: `
    Regression audit for the merge of ws-<label> onto <integration-base>.

    Read your role instructions for regression-auditor mode.

    Audit scope:
      - Full test suite:    bun run test
      - Full typecheck:     bun run typecheck
      - Full lint:          bun run lint  (or project equivalent)
      - Diff stat check:    git diff <base>..HEAD --stat
      - Disjoint check:     per-file, each file appears in at most one
                             producer slot's evidence[].files_changed

    Emit the standard reviewer typed artifact. Treat severity: blocker
    findings as hard rejects — do not soften them.

    Do NOT edit production code. Do NOT amend commits. If you find a
    blocker, surface it; root decides the rollback.
  `,
  worker_branch: "ws-<label>",     // already merged into HEAD
  base_commit: "<pre-merge-base>",
  run_in_background: true,
  model: "<reviewer model>",
  effort: "high",
})
```

Worked examples from DAG-2026-047:

- **T1.3 audit** — verified the T1.1 catalog generator + T1.2 wiring
  on a fresh clone. Auditor flagged a hash-chain ordering bug that the
  producer's slice-scoped test had missed.
- **T2.3 audit** — checked the registry loader against the renamed
  `run_in_background` defaults. Disjoint check caught a duplicate
  file in two slots' commits.
- **T3.3 audit** — full suite regression on the 8th catalog mode; the
  merge itself was clean but the auditor caught an env-loading drift
  in a sibling DAG that landed the same morning.

## When to use

- **Always** after a merge that touches ≥ 2 files across ≥ 2 packages
  (the Layer 1 guarantee cannot cover cross-package interactions).
- When the project's full suite takes > 2 minutes — keep root free.
- When the merge touches build config, CI, or shared infra (Layer 1
  must broaden to "smallest meaningful superset" per `AGENTS.md` §
  "Cross-worker gates", which still misses downstream consumers).
- When the merge lands during a busy root turn cycle (other work in
  flight) — the auditor runs in its own context.

## When NOT to use

- **Trivial merges** (single-file typo, doc-only, config-only). Slice-scoped
  Layer 1 + root's quick visual review is enough.
- **Pre-merge** — slice-scoped gates are the right gate at that stage.
  The auditor's whole point is "did the merge break anything?".
- **Pure doc changes** — docs do not break tests; audit would waste the
  cycle.
- **When the producer already ran a full suite and reported it in
  `validation`** — Layer 2 already happened at the producer; Layer 3
  would be duplicate work unless cross-merge regression is the concern.
- **For replacing Layer 1** — Layer 1 catches slice breakage cheaply
  and synchronously; Layer 3 is the safety net, not the primary gate.
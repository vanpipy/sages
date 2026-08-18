# Handling `status: partial` from worker handoffs

> **Pattern:** When a worker emits `status: partial`, root treats it as a routing decision — never auto-integrate — and chooses between re-spawn, accept-partial, or re-scope based on the artifact's `findings` + `open_questions`.
> **When to use:** Every artifact arrival whose `status` field reads `partial` (one of the four valid statuses in the Sages status enum: `completed`, `partial`, `needs-info`, `blocked`).

## Problem

The Sages typed-artifact contract has a fixed 4-state `status` enum
(see `AGENTS.md` § "Worker reporting discipline"):

- `completed` — every goal in the spawn prompt met, all gates passed.
- `partial` — some goals met, others deferred or out of scope.
- `needs-info` — scope was ambiguous; worker proceeded with one
  interpretation and documented both.
- `blocked` — capability gap, zero useful work.

`partial` is the state most often mishandled. It looks like success at a
glance ("the worker said it shipped something") but it carries hidden
deferred scope. If root auto-integrates, the deferred slice lands on
main unannounced, the deferred slice's gates never ran, and the next
worker that touches the same surface discovers the rot.

The confusion is often with `blocked`:

- `blocked` = missing **capability** (tool, file, key). Cannot work around.
- `partial` = missing **decision** root didn't make, OR out-of-scope work
  discovered mid-task.

Concrete example from DAG-2026-047 T1.2: the worker finished the catalog
wiring for `pi/` but found that running the same wiring against the
peer `pi-subagents/` package was out of its `files_touched[]` allow-list
and would have collided with T2.1's disjoint file set. It committed
its slice, noted the deferral in `findings[]`, and emitted
`status: partial`. Root then chose to roll T2.1's wire-up into T1.2
(re-scope) rather than spawn a new task. The result was a cleaner
file-partition than the original DAG had planned.

## Solution

The routing decision has four options; pick based on what `findings[]`
and `open_questions[]` actually say:

| Worker status | Root action | Trigger |
|---|---|---|
| `completed` | Integrate if `confidence` is acceptable. | All gates green. |
| **`partial`** | **Choose: re-spawn with deferred slice, accept the slice as-is, or re-scope.** Do NOT auto-integrate. | The slice shipped but a piece is deferred. |
| `needs-info` | Read `open_questions[]` first. Arbitrate, then integrate / amend / re-spawn. | Scope was ambiguous. |
| `blocked` | Read `blockers[]`. Choose: unblock, re-scope, abort. | Capability gap, zero useful work. |

For `partial`, the decision heuristic:

1. **Re-spawn** when the deferred slice is concrete enough to be a new
   task with a tight scope ("fix the 3 call sites you found in module X").
   Cheapest when the deferred work is well-defined and self-contained.
2. **Accept partial** when the deferred slice is genuinely out of scope
   for this DAG, the worker documented it clearly, and the slice that's
   shipped is independently valuable. Note the deferral in the audit
   rollup so a future GC can pick it up.
3. **Re-scope** when the deferred slice is large enough to reshape the
   DAG — e.g., the original partition was wrong. Update the DAG, re-dispatch
   the affected tasks.

`partial` is **not** failure. It routes follow-up work automatically.
The `what_i_did_not_check[]` list tells you what the worker admits it
didn't verify.

## Code

Example partial artifact from DAG-2026-047 T1.2:

```json
{
  "status": "partial",
  "findings": [
    "Catalog wiring for pi/ is complete: 5 catalog files generated, verify-catalog passes on main, AGENTS.md updated.",
    "Discovered: peer pi-subagents/ registry has a parallel `default_subagents` constant that would also need to flow through the same wiring.",
    "Deferred: wiring pi-subagents/ registry into the catalog is out of T1.2's files_touched[] (pi/catalogs/* + pi/scripts/* only)."
  ],
  "evidence": [
    {
      "commit": "6c7a34a",
      "files_changed": [
        "pi/catalogs/subagent.json",
        "pi/catalogs/isolation.json",
        "pi/scripts/gen-catalog.ts",
        "pi/scripts/verify-catalog.ts",
        "AGENTS.md"
      ]
    }
  ],
  "validation": "bun run verify:catalog: 5/5 catalogs hash-match; bun test ./src ./test: 733/733 pass on slice",
  "open_questions": [
    "Should T2.1 (subagent registry) absorb the pi-subagents/ wiring, or should T1.2 be re-scoped to include it?"
  ],
  "confidence": "high",
  "what_i_did_not_check": [
    "End-to-end gen:catalog + verify:catalog cycle against pi-subagents/ HEAD",
    "Cross-package integration test (would need pi-subagents/ in deps)"
  ]
}
```

Root's routing table for this artifact:

```text
status       : partial
deferred     : wiring pi-subagents/ registry into the catalog
deferred size: significant (touches a peer package + the registry loader)
independent value of shipped slice: yes (pi/ catalog works today)
decision     : re-scope — extend T1.2's allow-list to include
               pi-subagents/default_subagents.ts; the new wiring
               fits naturally with T2.1's registry work and avoids
               a parallel-task collision
re-dispatch  : T1.2 re-spawned with extended allow-list; same task_id;
               commits append on top of 6c7a34a
```

## When to use

- **Every** `status: partial` arrival, without exception.
- When `findings[]` mentions discovered scope or deferred work.
- When `validation` mentions gates that did NOT run (`what_i_did_not_check[]`).
- When `confidence` is anything below `high` — re-read the artifact
  carefully before integrating.

## When NOT to use

- **Confused with `blocked`.** If the worker couldn't produce any useful
  output because of a missing capability, it is `blocked`, not
  `partial`. `blocked` is the **zero-work rule** — if any useful work
  shipped, it is `partial` regardless of how stuck the worker felt.
- **Confused with `needs-info`.** If the worker proceeded with one
  interpretation and documented both in `open_questions[]`, it is
  `needs-info`. `partial` is for completed-but-deferred; `needs-info`
  is for ambiguous-and-proceeded.
- **Treated as failure.** `partial` is success-with-followup. Routing
  follow-up is root's job; the worker did its job by surfacing the gap
  instead of silently expanding scope.
- **Auto-integrated.** The single biggest mistake. Never.
- **Ignored.** If root doesn't act on `partial` (re-spawn, accept,
  re-scope), the deferred slice never gets tracked. File it in the
  audit rollup or open a follow-up goal.
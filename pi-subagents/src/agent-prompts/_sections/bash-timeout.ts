/**
 * bash-timeout.ts — Canonical Bash Timeout Guard section.
 *
 * Header renamed from `Bash Timeout` → `Bash Timeout Guard` (per the GC's
 * sections-drift test) so the section title makes the per-bucket enforcement
 * role explicit. The bucket table is generated from `run-controller.ts`
 * via `renderBashTimeoutSection()` to keep prompt text in sync with runtime.
 *
 * Developer + Reviewer share this byte-identically (both run bash commands and
 * hit the same timeouts). Pinned by `sections-drift.test.ts`.
 */

import { renderBashTimeoutSection } from "../../run-controller.js";

export const BASH_TIMEOUT_SECTION = `${renderBashTimeoutSection()}

### Anti-patterns

- **Do NOT run \`bun test\` (full suite) in a loop.** Each run costs
  15-30s of foreground time. Scope to a single file with
  \`bun test test/foo.test.ts\`.
- **Do NOT run \`git log -p\` or \`git log --all -- <path>\`.** These
  are archaeology commands, not progress markers. Use AFT or
  codebase_memory for cross-package work.
- **Do NOT use bash grep/rg/find/cat for code exploration.** AFT is
  faster. The bash path is the LAST resort.
- **Do NOT run network commands without explicit authorization.**
  Default is OFF. The audit gate flags network calls as suspicious
  unless the parent overrode the per-dispatch setting.

The orchestrator's overhead per "wait for backgrounded command" is ~5s.
Plan your command budget accordingly.
`;

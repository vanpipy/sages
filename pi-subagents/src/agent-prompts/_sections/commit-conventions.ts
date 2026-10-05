/**
 * commit-conventions.ts — Canonical Conventional Commits + Author Rules section
 * (GC-2026-prompt-consistency).
 *
 * SINGLE SOURCE OF TRUTH for the Conventional Commits prose that lives inside
 * DEVELOPER_PROMPT and (after this GC) REVIEWER_PROMPT. Both prompts import
 * `COMMIT_CONVENTIONS_SECTION` and concatenate it byte-identically into their
 * runtime prompt. Byte-identity is pinned by `test/sections-drift.test.ts`,
 * mirroring the `WORKSPACE_PROTOCOL_SECTION` / `commit-discipline.ts` pattern
 * established in GC-2026-076 and GC-2026-prompt-parser-contract-cleanup.
 *
 * Why a single source: prior to this GC the prose lived inline in `developer.ts`
 * (lines 302-394, ~4.3 KB) with brief 1-line summaries in SYSTEM.md / AGENTS.md /
 * _fix.ts. Any change to the format / type table / forbidden-author list had to
 * be replicated in three+ places — the parent repo even shipped an
 * unreferenced failure-mode (`commit-message-non-conformant` in
 * failure-modes.v1.yaml:44) the prose never told subagents about. After this
 * GC the prose lives in ONE file; SYSTEM.md keeps a 2-line brief with a
 * cross-ref, `_fix.ts` and `reviewer.ts` import the section for spot-check /
 * commit-time use, and the failure-mode description references the section by
 * name so retry feedback can link back.
 *
 * Consumers:
 *   - developer.ts (DEVELOPER_PROMPT) — full concatenation, commits go here.
 *   - reviewer.ts (REVIEWER_PROMPT)  — full concatenation, used as the
 *     commit-subject spot-check reference for `correctness` dimension.
 *   - _fix.ts (DEVELOPER_FIX_PROMPT)  — NOT concatenated (Fix rarely produces
 *     a new subject; the `fix(<scope>): <description>` rule is already in the
 *     Fix-phase branches section above). Mentioned by name only.
 *
 * NOT a consumer:
 *   - merger.ts / explore.ts / plan.ts — these agents do not produce commits.
 *
 * Header note: the `📤 Commit Conventions` heading was preserved verbatim from
 * the original inline text. Adding a `Never .pi/` rule would be a useful
 * follow-up (currently lives in SYSTEM.md only, enforced as failure-mode
 * `pi-orchestrator-leak`), but is OUT OF SCOPE for this GC — byte-identity
 * with the prior inline slice is the contract.
 */

export const COMMIT_CONVENTIONS_SECTION = `## 📤 Commit Conventions

Every commit you make MUST follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). The orchestrator and any downstream tooling (release-please, changelog generators, semver calculators) parse the \`<type>\` prefix to classify work; a free-form commit breaks that pipeline.

### Format

\`\`\`
<type>[optional scope]: <description>

[optional body — wrap at 72 chars; explain WHAT and WHY, not HOW]

[optional footer(s) — BREAKING CHANGE / Refs: / Closes:]
\`\`\`

Allowed \`<type>\` values for this project:

| type | when to use |
|---|---|
| \`feat\` | New feature visible to users / callers |
| \`fix\` | Bug fix |
| \`docs\` | Documentation-only change (AGENTS.md, README, SKILL.md, comments) |
| \`refactor\` | Production code change that doesn't fix a bug or add a feature |
| \`test\` | Adding or correcting tests only (no production code) |
| \`perf\` | Performance improvement |
| \`chore\` | Build / CI / tooling / housekeeping |
| \`style\` | Formatting / whitespace only (no behavior change) |

Rules (per the spec):

- Description is **lowercase, imperative mood, no trailing period**. \`feat: add plugin loader\` not \`feat: Added plugin loader.\`
- \`<scope>\` is optional. Use when the change is bounded to a module: \`feat(bash-guard): ...\`, \`fix(extension.ts): ...\`.
- **Breaking changes**: append \`!\` after the type/scope (\`feat(api)!: ...\`) **and** include a \`BREAKING CHANGE: <description>\` footer.
- Body wraps at 72 chars. Explain motivation, not mechanics.
- Footer format: \`Refs: <issue-id>\` / \`Closes: <issue-id>\`.

Examples:

\`\`\`
feat(extension): wire session_start + tool_call handlers for main-agent gates
fix(bash-guard): chmod/chown with denied path must block, not allow
docs: document Layer 1+2 hard threshold in AGENTS.md
chore(deps): bump typescript to 6.0.3
feat(api)!: drop legacy \`state\` field from task report

BREAKING CHANGE: callers reading \`task.state\` must migrate to \`task.status\`.
Refs: #142
\`\`\`

### Author — derive from git, never invent

**The author field must come from a real source.** Fabricating an author is an automatic audit failure. Resolve it before your first commit in the worktree:

\`\`\`bash
# Step 1: try git config
NAME=$(git config user.name)
EMAIL=$(git config user.email)

# Step 2: fall back to most recent commit's author
if [ -z "$NAME" ] || [ -z "$EMAIL" ]; then
    LAST=$(git log -1 --format='%an%n%ae')
    NAME="\${NAME:-$(echo "$LAST" | head -1)}"
    EMAIL="\${EMAIL:-$(echo "$LAST" | tail -1)}"
fi

# Step 3: if still empty, STOP and report (do not invent)
if [ -z "$NAME" ] || [ -z "$EMAIL" ]; then
    echo "FATAL: cannot resolve git author from config or history." >&2
    echo "Run 'git config user.name "Your Name"' and 'git config user.email you@example.com' before committing." >&2
    exit 1
fi
\`\`\`

Then commit **without** any author override:

\`\`\`bash
git add <files>
git commit -m "feat(scope): description"
\`\`\`

**Forbidden — never use these**:

- \`git commit --author="Some Name <email@example.com>"\` — overrides the resolved author. Reserved for genuine committer/author divergence (e.g., applying someone else's patch). For your own commits, never.
- \`git -c user.name="..." -c user.email="..." commit ...\` — fabricates via local config override.
- \`GIT_AUTHOR_NAME=... GIT_AUTHOR_EMAIL=... git commit ...\` — same effect via env override.
- Using the LLM's training-data name (e.g., "Claude", "GPT-4", "AI Assistant") as the author.

The \`--author\` flag is a deliberate footgun in this project. A passing audit cannot include a commit whose author was set with \`--author\`, set via \`git -c user.*=...\`, or set via \`GIT_AUTHOR_*\` env vars. If you find yourself reaching for any of these, **stop** and resolve the real author first.

### Why this matters

- **Downstream tooling** parses the \`<type>\` prefix. A free-form commit breaks the pipeline and silently loses the change from changelogs.
- **Audit traceability** — the auditor's \`git log\` and \`git show\` show the author. Fabricated authors destroy the provenance trail and fail the orchestrator's evidence gate.
- **\`git blame\` accuracy** — fake authors corrupt the blame map that Sages's debugger relies on.
`;

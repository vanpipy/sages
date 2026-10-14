/**
 * commit-conventions.ts — Canonical Conventional Commits + Author Rules section
 * (port of GC-2026-prompt-consistency's section to main pi-subagents).
 *
 * SINGLE SOURCE OF TRUTH for the Conventional Commits prose that lives inside
 * DEVELOPER_PROMPT and REVIEWER_PROMPT. Both default agents import
 * `COMMIT_CONVENTIONS_SECTION` and concatenate it byte-identically into their
 * runtime `systemPrompt`. The byte-identity is verified by
 * `test/commit-conventions-section.test.ts`.
 *
 * Why a single source: prior to this commit the author rule lived only in
 * `pi-orchestrator/templates/SYSTEM.md` as a 2-line summary
 * ("Author is `git config user.{name,email}`. Never `--author`, never
 * `GIT_AUTHOR_*` env overrides."). The subagent inherited that summary
 * verbatim through the parent's system prompt, but had no fallback strategy
 * when `git config user.{name,email}` returned empty — exactly the case the
 * orchestrator hits when it spawns the subagent in an isolated worktree
 * whose `.git/config` was not seeded with author identity, and the subagent's
 * detached pi session does not inherit `~/.gitconfig`. Fabricating an author
 * is an audit failure (corrupts `git blame`, breaks changelog generators that
 * parse the `<type>` prefix, destroys provenance). The strategy below makes
 * the fallback chain explicit and stops on the failure case instead of
 * inventing one.
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

- Description is **lowercase, imperative mood, no trailing period**. \`feat: add plugin loader\` not \`feat: Added plugin loader.\`.
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

### Forbidden paths — never commit \`.pi/\` files

**Never \`git add\` paths under \`.pi/\`.** The orchestrator's state files (\`.pi/orchestrator/goal-{id}.yaml\`, \`.pi/orchestrator/workflow-{id}.yaml\`, \`.pi/orchestrator/audit-state-{id}.yaml\`) are orchestrator-owned. The subagent layer's per-task files (\`.pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md\`, \`.pi/orchestrator/verdict-{task_id}.md\`, \`.pi/orchestrator/last-review-{goal_id}.md\`, \`.pi/orchestrator/merge-recommendation.md\`) are also off-limits to other agents.

The main agent verifies \`git diff origin/main..HEAD --name-only\` excludes \`.pi/\` before merge. A passing audit cannot include a \`.pi/\`-path change from a developer/fix/merger task. The Sages orchestrator's failure-mode catalog (entry \`pi-orchestrator-leak\`) catches this at audit time — but the rule is here so the agent knows the constraint upfront, not after committing.

### Why this matters

- **Downstream tooling** parses the \`<type>\` prefix. A free-form commit breaks the pipeline and silently loses the change from changelogs.
- **Audit traceability** — the auditor's \`git log\` and \`git show\` show the author. Fabricated authors destroy the provenance trail and fail the orchestrator's evidence gate.
- **\`git blame\` accuracy** — fake authors corrupt the blame map that Sages's debugger relies on.
`;
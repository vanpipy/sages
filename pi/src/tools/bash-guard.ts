/**
 * Bash Guard — bash command classifier for the soft-mode auto-steer reminder
 * (GC-2026-031).
 *
 * `classifyBashCommand` is the only production consumer of this module
 * — the bash tool_call handler in `extension.ts` calls it on every
 * invocation to decide whether the first write-intent bash call should
 * fire `softModeReminder(profile)`. The historical four-layer gate
 * (L1 read / L2 git-meta / L3 meta-file-write / L4 production-code-write),
 * the destructive-verb short-circuit, the target-extraction helpers, and
 * the chained-command splitter have all been removed — main-agent bash
 * commands are not gated. The path-policy module that used to back the
 * gate (`src/tools/file-gate.ts`) was deleted in the same change.
 *
 * Result enum:
 *   - "read-only"   — first-word matches a known safe command, no write
 *                      redirect to a real file.
 *   - "write-intent"— the command can mutate files (rm, sed -i, tee,
 *                      redirects, find -delete, …).
 *   - "git-meta"    — git subcommand on the L2 whitelist (status,
 *                      log, diff, branch, etc.).
 *   - "unknown"     — anything else.
 *
 * Hot-path memoization: `classifyCache` (LRU, cap 256, move-to-end)
 * short-circuits the entire pipeline on repeat keys. `__shellTokensCallCount`
 * is a test-only instrumentation counter — production code never reads it.
 */

const READ_ONLY_FIRST_WORDS = new Set([
	"ls", "cat", "head", "tail", "grep", "wc", "file", "stat",
	"tree", "which", "jq", "env",
	"cd", "pwd", "printenv",
]);

const WRITE_INTENT_FIRST_WORDS = new Set([
	"rm", "mv", "cp", "sed", "perl", "tee", "truncate", "mkdir",
	"chmod", "chown", "tar", "unzip",
]);

const READ_ONLY_PREFIX_PATTERNS: RegExp[] = [
	/^npm\s+(test|lint|typecheck)\b/,
	/^bun\s+test\b/,
	/^pytest\b/,
	/^cargo\s+test\b/,
	/^make\b/,
];

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch"]);

/**
 * Matches any file-redirect (`>`, `>>`, `N>`, `N>>`, `&>`, `&>>`)
 * but excludes fd duplications (`>&`, `2>&1`) where `>` is immediately
 * followed by `&`. Required by both `hasWriteRedirect` (boolean) and
 * the classifier's "first redirect target" walk.
 */
const WRITE_REDIRECT_PREFIX = /\d*&?(?:>>|>(?!&))/;

export type BashClassification = "read-only" | "write-intent" | "git-meta" | "unknown";

/**
 * GC-2026-033 phase-2 — LRU memoization for the per-tool_call hot path.
 *
 * `classifyBashCommand` is invoked on every LLM bash call (the bash
 * handler in `extension.ts` calls it on every invocation). In a
 * multi-turn LLM session the same commands repeat frequently
 * (`git status`, `ls -la`, `cat <file>`, `bun test`, …) and each call
 * otherwise pays full tokenize + regex + git-meta verdict cost.
 *
 * Map capacity 256 is the same knob the worktree profile counters
 * use (GC-2026-032 phase-1) — large enough to cover any realistic
 * single-session working set while bounding memory at a few KB.
 */
const CLASSIFY_CACHE_MAX = 256;
const classifyCache = new Map<string, BashClassification>();

/** Move-to-end + cap-evict for a one-shot cache insertion. */
function touchCache(
	cache: Map<string, BashClassification>,
	key: string,
	value: BashClassification,
	cap: number,
): void {
	if (cache.has(key)) cache.delete(key);
	cache.set(key, value);
	while (cache.size > cap) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/** Tokenize a shell command with full quote/escape/paren awareness. */
function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		if (escape) {
			current += c;
			escape = false;
			i++;
			continue;
		}
		if (c === "\\") {
			escape = true;
			current += c;
			i++;
			continue;
		}
		if (!inSingle && c === '"') {
			inDouble = !inDouble;
			current += c;
			i++;
			continue;
		}
		if (!inDouble && c === "'") {
			inSingle = !inSingle;
			current += c;
			i++;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(c)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			i++;
			continue;
		}
		current += c;
		i++;
	}
	if (current) tokens.push(current);
	return tokens;
}

function gitTokens(command: string): string[] | undefined {
	const tokens = shellTokens(command);
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
	while (index < tokens.length && tokens[index].startsWith("-") && tokens[index] !== "--") index++;
	return tokens[index] === "git" ? tokens.slice(index) : undefined;
}

/** Detect a write-targeting redirect (`>`, `>>`, `N>`, `N>>`, `&>`, `&>>`). */
function hasWriteRedirect(cmd: string): boolean {
	return WRITE_REDIRECT_PREFIX.test(cmd);
}

/**
 * Classify a git command against the positive L2 whitelist. Operates on a
 * pre-tokenized array (the shape `gitTokens` produces) so callers that
 * have already tokenized a command can reuse the result without a second
 * `shellTokens` pass.
 *
 * `undefined` (i.e. `gitTokens` returned undefined because the command
 * isn't a git command) yields `{ allow: false, reason: "not a git command" }`.
 */
function evaluateGitMetaVerdict(tokens: string[] | undefined): {
	allow: true; subcommand: string;
} | { allow: false; reason: string } {
	if (!tokens) return { allow: false, reason: "not a git command" };
	const sub = tokens[1];
	const args = tokens.slice(2);
	const rendered = `git ${sub ?? ""}`.trim();
	const destructive =
		(sub === "checkout" && args.includes("--")) ||
		sub === "restore" ||
		sub === "rm" ||
		sub === "mv" ||
		(sub === "reset" && args.includes("--hard")) ||
		(sub === "clean" && args.some(a => /^-[a-z]+$/i.test(a) && a.includes("f") && a.includes("d"))) ||
		(sub === "stash" && args[0] === "drop") ||
		(sub === "tag" && args.includes("-d")) ||
		(sub === "branch" && args.some(a => a === "-D" || a === "-d")) ||
		(sub === "push" && args.some(a =>
			a === "--force" || a === "-f" ||
			a === "--force-with-lease" || a === "--force-if-includes"
		)) ||
		(sub === "switch" && args.includes("--discard-changes")) ||
		(sub === "worktree" && args[0] === "remove" && args.includes("--force"));
	if (destructive) {
		return { allow: false, reason: `destructive: ${rendered}${args.length ? ` ${args.join(" ")}` : ""}` };
	}
	if (!sub) return { allow: false, reason: "unsupported: git command has no subcommand" };

	const direct = new Set([
		"status", "log", "diff", "show", "blame", "shortlog", "reflog",
		"rev-parse", "rev-list", "add", "commit", "merge", "cherry-pick",
		"rebase", "stash", "fetch", "pull", "push", "init", "clone",
	]);
	let allow = direct.has(sub);
	if (sub === "tag" || sub === "branch") allow = !args.some(a => a.startsWith("-") && a !== "-l" && a !== "--list");
	if (sub === "worktree") allow = ["list", "add", "remove"].includes(args[0] ?? "");
	if (sub === "remote") allow = args[0] === "-v" || args[0] === "add";
	if (sub === "submodule") allow = args[0] === "status";
	if (sub === "config") allow = args[0] === "--get" || args[0] === "--list";
	if (sub === "checkout") {
		// `git checkout <ref>` / `-b <new>` / `-B <new>` / `--orphan <new>`
		// / `--detach <commit>` / `-` (previous branch). The destructive
		// filter above already catches the file-overwrite forms
		// (`git checkout -- <paths>` / `git checkout <ref> -- <paths>`)
		// via `args.includes("--")`. When we reach here, `--` is NOT
		// in args, so it's a pure ref operation.
		allow = true;
	}
	if (sub === "switch") {
		// `git switch <ref>` / `-c <new>` / `-C <new>` / `--orphan <new>`
		// / `--detach <commit>`. The destructive filter above catches
		// `--discard-changes` (forced switch with local-change loss).
		allow = true;
	}
	return allow
		? { allow: true, subcommand: sub }
		: { allow: false, reason: `unsupported: ${rendered}` };
}

/**
 * Classify a bash command by its first word (with a few exceptions for
 * redirect, `find` flags, and `echo`).
 *
 * The result is memoized in `classifyCache` (Map-based LRU, cap 256).
 * Repeated commands on subsequent LLM turns short-circuit the entire
 * classification pipeline (no `shellTokens`, no redirect regex, no
 * git-meta verdict). The signature is unchanged — callers see a plain
 * classifier; the cache is purely internal.
 */
export function classifyBashCommand(command: string): BashClassification {
	const cached = classifyCache.get(command);
	if (cached !== undefined) {
		// Move-to-end refresh: `Map#set` on an existing key does NOT
		// advance its iteration position, so delete + re-set is the
		// canonical LRU trick in plain JS Maps.
		classifyCache.delete(command);
		classifyCache.set(command, cached);
		return cached;
	}
	const result = classifyUncached(command);
	touchCache(classifyCache, command, result, CLASSIFY_CACHE_MAX);
	return result;
}

/**
 * Pure (cache-free) classifier logic. Extracted so the cache wrapper
 * above has a single exit point and so the inner logic can be unit-
 * tested directly (e.g. by asserting that `classifyBashCommand`'s
 * `__shellTokensCallCount` delta matches the expected tokenize count).
 */
function classifyUncached(command: string): BashClassification {
	const trimmed = command.trimStart();
	if (!trimmed) return "unknown";

	const firstWordMatch = trimmed.match(/^\S+/);
	const firstWord = firstWordMatch ? firstWordMatch[0] : "";
	if (!firstWord) return "unknown";

	const hasRedirect = hasWriteRedirect(trimmed);

	// 1. Write-intent first-words always classify as write-intent.
	if (WRITE_INTENT_FIRST_WORDS.has(firstWord)) {
		return "write-intent";
	}

	// 2. find: write-intent if -delete / -exec, else read-only.
	if (firstWord === "find") {
		const hasDeleteOrExec =
			/(^|\s)-delete(\s|$)/.test(trimmed) ||
			/(^|\s)-exec(\s|$)/.test(trimmed);
		return hasDeleteOrExec ? "write-intent" : "read-only";
	}

	// 3. Write-targeting redirect (`>`, `>>`) → write-intent
	//    regardless of the first word (so `ls > listing.txt`,
	//    `cat src/x > src/y` etc. are correctly classified). The
	//    spec carves `echo` out of the read-only list *because of*
	//    this rule; we apply it uniformly to keep the precedence
	//    simple.
	if (hasRedirect) {
		return "write-intent";
	}

	// 4. Read-only first-words (cat, ls, head, grep, …).
	if (READ_ONLY_FIRST_WORDS.has(firstWord)) {
		return "read-only";
	}

	// 5. echo without redirect → read-only (already covered above
	//    by the redirect check, but explicit for clarity).
	if (firstWord === "echo") {
		return "read-only";
	}

	// 6. Existing read-only git commands remain L1 for API compatibility.
	//    `shellTokens(trimmed)` is called exactly once here; the git-meta
	//    verdict reuses the same `tokens` array via `evaluateGitMetaVerdict`.
	const tokens = shellTokens(trimmed);
	const gitIndex = tokens.findIndex(t => t === "git");
	if (gitIndex >= 0) {
		const sub = tokens[gitIndex + 1];
		if (sub && READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return "read-only";
		if (sub === "worktree" && tokens[gitIndex + 2] === "list") return "read-only";
	}

	// Other whitelisted git-meta subcommands are L2.
	const gitTokensSlice = gitIndex >= 0 ? tokens.slice(gitIndex) : undefined;
	const gitVerdict = evaluateGitMetaVerdict(gitTokensSlice);
	if (gitVerdict.allow) return "git-meta";

	// 7. npm/bun/pytest/cargo/make prefix patterns.
	for (const re of READ_ONLY_PREFIX_PATTERNS) {
		if (re.test(trimmed)) return "read-only";
	}

	return "unknown";
}

/** Test-only — read the current LRU size. Throws if the helper is missing (the helper not exported). */
export function _getClassifyCacheSize(): number {
	return classifyCache.size;
}

/** Test-only — clear the LRU. */
export function _clearClassifyCache(): void {
	classifyCache.clear();
}
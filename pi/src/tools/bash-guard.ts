/**
 * Bash Guard — four-layer command gate, evaluated L1 → L2 → L3 → L4:
 * L1 read allows commands classified read-only; L2 git-meta applies a
 * positive git-subcommand whitelist and rejects destructive variants; L3
 * meta-file-write allows extracted targets in `META_FILE_ALLOWLIST` via
 * `canMainAgentWriteMeta()`; L4 production-code-write denies everything
 * targeting production paths or otherwise unknown. Upper layers allow
 * known-safe operations; L4 requires a developer subagent.
 *
 * The main orchestrator agent must not be able to bypass the
 * `developer` / `auditor` audit gate by issuing
 * raw `bash` commands (`rm`, `mv`, `cp`, `sed -i`, `find -delete`,
 * `git checkout --`, `tar -xf`, redirects, …). The `Agent` tool is
 * the only legitimate path for production-code changes.
 *
 * This module is a pure classifier + policy helper. The wiring into
 * the `bash` tool's `tool_call` event layer is P2's job; here we
 * expose three functions used by both the wiring and the tests:
 *
 *   classifyBashCommand(cmd)  → "read-only" | "write-intent" | "git-meta" | "unknown"
 *   isGitMetaCommand(cmd)     → positive-whitelist `GitMetaVerdict`
 *   extractBashTargets(cmd)   → string[] of paths the command will write
 *   shouldBlockBashCommand(cmd, ctx) → { block, reason? }
 *
 * Path policy is delegated to `file-gate.canMainAgentWrite` — this
 * module is the SINGLE consumer of that function for bash. Production
 * code patterns (user `src/`, `test/`, `*.ts`, …) live there. Any
 * change to allow/deny rules happens in one place.
 *
 * Absolute paths (`/tmp/...`, `/var/...`) are treated as
 * outside-the-project and never blocked by this guard — they are
 * governed by the OS layer instead. This is the only place this
 * convention is encoded; `canMainAgentWrite` itself returns false
 * for absolute paths defensively.
 *
 * Chained-command handling (added 2026-07-25): `shouldBlockBashCommand`
 * splits the input on top-level `&&` / `||` / `;` (respecting quotes
 * and paren/brace nesting) via `splitChainedCommands` and walks each
 * segment independently. This defeats the original first-word bypass
 * (`echo done && rm src/foo.ts` no longer slips through because the
 * first word is `echo`). Test coverage: T16–T22 + T23b + T24 in
 * `pi/test/tools/bash-guard.test.ts`.
 */

import { isAbsolute, relative, resolve } from "node:path";
// SC7 single-source-of-truth: import the path policy + the
// LLM-facing reason from `file-gate`. `policyMessage` is re-exported
// for callers that want to surface the meta-file denial verbatim;
// the bash-guard composes its own reason because the bash denial
// is command-shaped, not path-shaped.
import { canMainAgentWrite, canMainAgentWriteMeta, policyMessage } from "./file-gate.js";

/** Unconditional read-only first-words. */
const READ_ONLY_FIRST_WORDS = new Set([
	"ls", "cat", "head", "tail", "grep", "wc", "file", "stat",
	"tree", "which", "jq", "env",
	"cd", "pwd", "printenv",
]);

/** Write-intent first-words (always win over read-only). */
const WRITE_INTENT_FIRST_WORDS = new Set([
	"rm", "mv", "cp", "sed", "perl", "tee", "truncate", "mkdir",
	"chmod", "chown", "tar", "unzip",
]);

/**
 * Unconditionally destructive first-words — ALWAYS denied, regardless
 * of target path. This restores the pre-GC-2026-015 invariant that
 * the four-layer refactor's L3 meta-file allowlist would otherwise
 * relax (a path like `.pi/orchestrator/foo.md` makes both
 * `canMainAgentWrite` AND `canMainAgentWriteMeta` return true, so
 * `isProductionTarget` returns false and `rm` slips through).
 *
 * Subset of `WRITE_INTENT_FIRST_WORDS`. Non-destructive
 * write-intent commands (`mkdir`, `tee`, `sed`, `perl`, `tar`,
 * `chmod`, …) remain L3-controlled: they're allowed on meta-file
 * paths and denied on production paths via `isProductionTarget`.
 *
 * Anti-goal contract (GC-2026-015): "Do NOT change the existing
 * destructives (`rm`, `mv`, `cp`, `unlink`, `rmdir`) — they stay
 * denied regardless of which layer."
 */
const DESTRUCTIVE_FIRST_WORDS = new Set([
	"rm", "mv", "cp", "unlink", "rmdir",
]);

/**
 * Chain / pipe / redirect / fd operators that terminate a command's
 * arg list. Used by `extractBashTargets` to stop at the first
 * non-target token so e.g. `rm pi/src/foo.ts 2>&1 | head -5` extracts
 * only `pi/src/foo.ts` (not `2>&1`, `|`, `head`).
 *
 * Kept narrow on purpose — these are SHELL-level separators, not
 * data the user might be passing as a filename. Quoted operators
 * (`"&&"`) never reach here because the helper is called on
 * already-shell-tokenized args.
 */
function isShellOperator(token: string): boolean {
	if (token === "|" || token === ";" || token === "&") return true;
	if (token === "&&" || token === "||") return true;
	if (token.startsWith(">") || token.startsWith("<")) return true;
	if (token === "2>&1" || token.startsWith("&>")) return true;
	return false;
}

/** Read-only prefix patterns. */
const READ_ONLY_PREFIX_PATTERNS: RegExp[] = [
	/^npm\s+(test|lint|typecheck)\b/,
	/^bun\s+test\b/,
	/^pytest\b/,
	/^cargo\s+test\b/,
	/^make\b/,
];


/** Git commands retained as L1 read-only for classifier compatibility. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch"]);

/**
 * Shared redirect-detector prefix. Matches any file-redirect:
 *   `>`, `>>`, `N>`, `N>>`, `&>`, `&>>`
 * Excludes fd duplications (`N>&M`, `>&M`) by requiring `>` to
 * NOT be followed by `&`. Used by both `hasWriteRedirect` (boolean
 * classification) and the target-extraction regex below. Keeping
 * them as a shared prefix prevents the two sites from drifting
 * (F4-2 hardening — `2>file` is a stderr-to-file redirect).
 */
const WRITE_REDIRECT_PREFIX = /\d*&?(?:>>|>(?!&))/;

export type BashClassification = "read-only" | "write-intent" | "git-meta" | "unknown";

export type GitMetaVerdict =
	| { allow: true; subcommand: string }
	| { allow: false; reason: string };

export interface BashGuardDecision {
	block: boolean;
	reason?: string;
}

/** Tokenize the command prefix while preserving spaces inside shell quotes. */
function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of command.trim()) {
		if (escaped) {
			token += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
		} else token += char;
	}
	if (token) tokens.push(token);
	return tokens;
}

function gitTokens(command: string): string[] | undefined {
	const tokens = shellTokens(command);
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
	while (index < tokens.length && tokens[index].startsWith("-") && tokens[index] !== "--") index++;
	return tokens[index] === "git" ? tokens.slice(index) : undefined;
}

/** Classify a git command against the positive L2 whitelist. */
export function isGitMetaCommand(command: string): GitMetaVerdict {
	const tokens = gitTokens(command);
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
		(sub === "stash" && args[0] === "drop") || (sub === "tag" && args.includes("-d")) ||
		(sub === "branch" && args.some(a => a === "-D" || a === "-d")) ||
		(sub === "push" && args.some(a =>
			a === "--force" || a === "-f" ||
			a === "--force-with-lease" || a === "--force-if-includes"
		)) ||
		(sub === "switch" && args.includes("--discard-changes")) ||
		(sub === "worktree" && args[0] === "remove" && args.includes("--force"));
	if (destructive) return { allow: false, reason: `destructive: ${rendered}${args.length ? ` ${args.join(" ")}` : ""}` };
	if (!sub) return { allow: false, reason: "unsupported: git command has no subcommand" };

	const direct = new Set(["status", "log", "diff", "show", "blame", "shortlog", "reflog", "rev-parse", "rev-list", "add", "commit", "merge", "cherry-pick", "rebase", "stash", "fetch", "pull", "push", "init", "clone"]);
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
	return allow ? { allow: true, subcommand: sub } : { allow: false, reason: `unsupported: ${rendered}` };
}


/**
 * Classify a bash command by its first word (with a few exceptions
 * for redirect, `find` flags, and `echo`).
 *
 * Returns one of:
 *   - "read-only"   — first-word matches a known safe command, no
 *                      redirect targets production code.
 *   - "write-intent"— the command can mutate files (rm, sed -i,
 *                      tee, redirects, find -delete, …).
 *   - "unknown"     — anything else (python3 -c, ruby -e, bash -c,
 *                      git checkout/restore/clean/rm, …).
 */
export function classifyBashCommand(command: string): BashClassification {
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
	//    (find with redirect is handled by step 3.)
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
	const tokens = shellTokens(trimmed);
	const gitIndex = tokens.findIndex(t => t === "git");
	if (gitIndex >= 0) {
		const sub = tokens[gitIndex + 1];
		if (sub && READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return "read-only";
		if (sub === "worktree" && tokens[gitIndex + 2] === "list") return "read-only";
	}

	// Other whitelisted git-meta subcommands are L2.
	const gitVerdict = isGitMetaCommand(trimmed);
	if (gitVerdict.allow) return "git-meta";

	// 7. npm/bun/pytest/cargo/make prefix patterns.
	for (const re of READ_ONLY_PREFIX_PATTERNS) {
		if (re.test(trimmed)) return "read-only";
	}

	return "unknown";
}

/**
 * Return paths a write-intent command will touch. Empty array means
 * no write-target was identifiable (e.g. `git status`).
 *
 * Patterns handled (per design):
 *   rm [-flags]* <path> [<path>...]
 *   mv <src> <dst>
 *   cp <src> <dst>               → only <dst>
 *   tee <path> [<path>...]
 *   > <path> / >> <path>         (anywhere)
 *   sed -i<SUFFIX>? '<expr>' <path>
 *   find <dir> -delete           → <dir>
 *   git checkout [--] <paths...>
 *   git checkout <ref> -- <paths...>
 *   git restore [--source=<ref>] <paths...>
 *   git clean -fd [<paths...>]   → <paths...> or cwd
 *   git rm <paths...>
 *   tar -xf|-xjf|-xzf <arc> [-C <dir>] → <dir> or cwd
 */
export function extractBashTargets(command: string): string[] {
	const trimmed = command.trimStart();
	if (!trimmed) return [];

	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const firstWord = tokens[0] || "";
	const targets: string[] = [];

	switch (firstWord) {
		case "rm": {
			// rm [-rf|-r|-f|...]* <path> [<path>...]
			// Stop at the first shell operator (chain parser
			// hardening — `rm foo 2>&1 | head` previously
			// extracted `2>&1`, `|`, `head` as targets).
			for (const t of tokens.slice(1)) {
				if (t.startsWith("-")) continue;
				if (isShellOperator(t)) break;
				targets.push(t);
			}
			break;
		}
		case "mv": {
			// mv <src> <dst>   (take first non-flag and last non-flag).
			// Walk forward, skip flags, stop at the first shell
			// operator. The path pair is the first and last
			// collected path before the operator.
			const pathArgs: string[] = [];
			for (const t of tokens.slice(1)) {
				if (t.startsWith("-")) continue;
				if (isShellOperator(t)) break;
				pathArgs.push(t);
			}
			if (pathArgs.length >= 2) {
				targets.push(pathArgs[0], pathArgs[pathArgs.length - 1]);
			} else if (pathArgs.length === 1) {
				targets.push(pathArgs[0]);
			}
			break;
		}
		case "cp": {
			// cp <src> <dst>   → only <dst>.
			// Walk forward, skip flags, stop at the first shell
			// operator. Capture the last path arg before the
			// operator (= destination). A single arg is treated as
			// the destination too (e.g. `cp a` → [a]).
			let last: string | undefined;
			for (const t of tokens.slice(1)) {
				if (t.startsWith("-")) continue;
				if (isShellOperator(t)) break;
				last = t;
			}
			if (last !== undefined) targets.push(last);
			break;
		}
		case "mkdir": {
			// mkdir [-p] <dir> [<dir>...] — stop at first operator.
			for (const t of tokens.slice(1)) {
				if (t.startsWith("-")) continue;
				if (isShellOperator(t)) break;
				targets.push(t);
			}
			break;
		}
		case "tee": {
			// tee <path> [<path>...] — stop at first operator.
			for (const t of tokens.slice(1)) {
				if (t === "<" || t.startsWith("<")) break;
				if (isShellOperator(t)) break;
				if (!t.startsWith("-")) targets.push(t);
			}
			break;
		}
		case "perl": {
			// F4-1 hardening: perl [-pi] [-e 'code'] [file...] was a
			// write-intent bypass because the switch fell through to
			// default, returning no targets. Without parsing perl, we
			// extract paths using a two-pronged heuristic:
			//
			//   1. Plain non-flag, non-quoted args (e.g., `perl -pi -e
			//      's/a/b/' x.ts` → `x.ts`). Stop at the first
			//      shell operator.
			//   2. Quoted strings that look like file paths (have `/`
			//      and a basename with `.`, or start with `./`, `../`,
			//      `/`). We match single-quoted strings before
			//      double-quoted ones so a path literal inside the
			//      perl code (e.g., `unlink 'src/foo.ts'` inside
			//      `"..."`) is captured independently of the wrapping
			//      double quotes. Double-quoted strings that contain
			//      inner single quotes are skipped (likely code wrapping
			//      a path literal; the path is captured by the
			//      single-quote pass).
			for (const t of tokens.slice(1)) {
				if (t.startsWith("-") || t.startsWith("'") || t.startsWith('"')) continue;
				if (isShellOperator(t)) break;
				targets.push(t);
			}
			const isPathLike = (s: string): boolean => {
				if (!s.includes("/")) return false;
				if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) return true;
				const lastSlash = s.lastIndexOf("/");
				const basename = s.slice(lastSlash + 1);
				return basename.includes(".");
			};
			const singleQ = /'([^']+)'/g;
			let sm: RegExpExecArray | null;
			while ((sm = singleQ.exec(trimmed)) !== null) {
				const c = sm[1];
				if (c && !c.includes('"') && isPathLike(c)) targets.push(c);
			}
			const doubleQ = /"([^"]+)"/g;
			let dm: RegExpExecArray | null;
			while ((dm = doubleQ.exec(trimmed)) !== null) {
				const c = dm[1];
				if (c && !c.includes("'") && isPathLike(c)) targets.push(c);
			}
			break;
		}
		case "sed": {
			// sed -i<SUFFIX>? '<expr>' <path> [<path>...]
			// Walk forward, capture the LAST non-flag, non-operator
			// token (i.e., the path closest to the script). The
			// forward walk replaces the previous reverse scan so
			// chain operators terminate the path hunt
			// (`sed -i 's/a/b/' x.ts && rm y` → only [x.ts]).
			let lastPath: string | undefined;
			for (const a of tokens.slice(1)) {
				if (a.startsWith("-")) continue;
				if (isShellOperator(a)) break;
				lastPath = a;
			}
			if (lastPath) targets.push(lastPath);
			break;
		}
		case "find": {
			// find <dir> -delete  → <dir>
			// The directory is the first non-flag, non-operator
			// argument (skip `|`, `;`, etc. defensively even though
			// find + redirect is unusual).
			if (/(^|\s)-delete(\s|$)/.test(trimmed)) {
				const args = tokens.slice(1);
				const dir = args.find(a => !a.startsWith("-") && !isShellOperator(a));
				if (dir) targets.push(dir);
			}
			break;
		}
		case "tar": {
			// tar -xf|-xjf|-xzf <arc> [-C <dir>] → <dir> or cwd
			// Reject operator tokens after `-C` (e.g.,
			// `tar -xzf a.tar.gz -C && rm x` falls back to cwd).
			const cIdx = tokens.indexOf("-C");
			if (cIdx >= 0 && tokens[cIdx + 1] && !isShellOperator(tokens[cIdx + 1])) {
				targets.push(tokens[cIdx + 1]);
			} else {
				targets.push(".");
			}
			break;
		}
		case "git": {
			const sub = tokens[1];
			if (sub === "checkout") {
				// git checkout [--] <paths...>
				// git checkout <ref> [--] <paths...>
				// Find `--` separator; everything after is paths.
				const dashIdx = tokens.indexOf("--");
				if (dashIdx >= 0) {
					for (const t of tokens.slice(dashIdx + 1)) {
						if (t) targets.push(t);
					}
				}
				// If no `--`, it's a ref-only checkout (branch switch),
				// no file targets — leave empty.
			} else if (sub === "restore") {
				// git restore [--source=<ref>] <paths...>
				// `git restore` doesn't use a `--` separator; paths
				// follow directly (optionally after `--source=<ref>`).
				// Take everything after `restore` that isn't a flag.
				for (const t of tokens.slice(2)) {
					if (!t || t.startsWith("--")) continue;
					targets.push(t);
				}
			} else if (sub === "clean") {
				const args = tokens.slice(2).filter(t => !t.startsWith("-"));
				if (args.length > 0) {
					for (const t of args) targets.push(t);
				} else {
					targets.push(".");
				}
			} else if (sub === "rm") {
				for (const t of tokens.slice(2)) {
					if (t) targets.push(t);
				}
			}
			break;
		}
		default:
			break;
	}

	// Redirect patterns: `> <path>` and `>> <path>` anywhere in the
	// command. We also accept `N>` and `&>` fd-prefixed forms (F4-2
	// hardening — `2>file` is a stderr-to-file redirect, NOT an fd
	// duplication). Only `>&` (i.e. `>` immediately followed by `&`)
	// indicates fd duplication (`2>&1`) and is excluded. Optional
	// `\d*` / `&?` prefix allows `2>`, `&>`, `2>>`, `&>>`.
	const redirectRegex = new RegExp(WRITE_REDIRECT_PREFIX.source + "\\s*(\\S+)", "g");
	let match: RegExpExecArray | null;
	while ((match = redirectRegex.exec(trimmed)) !== null) {
		targets.push(match[1]);
	}

	// Deduplicate while preserving insertion order.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of targets) {
		if (!seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

/**
 * Decide whether to block a bash command.
 *
 * Rules (in order):
 *   1. Split into chained segments on top-level `&&` / `||` / `;`.
 *      Walk each segment independently: a write-intent command chained
 *      after a read-only command (e.g. `echo done && rm src/foo.ts`)
 *      still trips the gate. See `splitChainedCommands` for the
 *      segmenter and T16–T22 in `bash-guard.test.ts` for coverage.
 *   2. If ANY segment is write-intent with a denied target → block
 *      with the long reason naming the union of denied targets.
 *   3. If ANY segment is `unknown` with no extractable targets → block
 *      with the short "Unknown bash command; dispatch a subagent or
 *      rephrase with known-safe commands" reason.
 *   4. Otherwise → allow (all segments read-only OR write-intent to
 *      non-production paths).
 *
 * There is no escape hatch. The main agent cannot bypass this gate via
 * `bash`. All file writes (meta-file or production) must go through
 * `Agent` dispatch (`developer` with `tdd: none` for meta-file / design-doc writes; `developer` with managed-worktree isolation for production code). DAG-2026-011 Phase C removed the `general-purpose` helper that previously handled meta-file edits.
 * managed worktree for production code).
 *
 * The `ctx` parameter is accepted for symmetry with the file-gate
 * `execute*` signatures and to give the wiring a future place to
 * hang absolute-path resolution (e.g. resolving against `ctx.cwd`).
 */
export function shouldBlockBashCommand(
	command: string,
	_ctx: { cwd: string },
): BashGuardDecision {
	const trimmed = command.trimStart();

	// Fail closed on shell grammar that changes execution topology or performs
	// hidden evaluation. Safe reads remain available as a single command.
	if (/\r|\n/.test(trimmed)) {
		return { block: true, reason: "Multiline bash commands are denied; use one documented safe command per call" };
	}
	if (/(^|[^|])\|([^|]|$)/.test(trimmed)) {
		return { block: true, reason: "Shell pipelines are denied because downstream mutation targets cannot be proven" };
	}
	if (/\$\(|`/.test(trimmed)) {
		return { block: true, reason: "Shell command substitution is denied" };
	}
	const initialTokens = shellTokens(trimmed);
	if (initialTokens[0] === "env" && initialTokens.length > 1) {
		return { block: true, reason: "env command wrappers are denied; invoke a documented safe command directly" };
	}
	if (initialTokens[0] === "find" && initialTokens.includes("-exec")) {
		return { block: true, reason: "find -exec is denied because the executed command can mutate arbitrary targets" };
	}

	// 1. Split into top-level chained segments (handles &&, ||, ;
	//    respecting quotes + paren/brace nesting).
	const segments = splitChainedCommands(trimmed);

	const deniedTargets: string[] = [];
	const seenDenied = new Set<string>();
	let sawUnknown = false;
	let sawWriteWithoutTarget = false;

	for (const seg of segments) {
		const trimmedSeg = seg.trimStart();
		if (!trimmedSeg) continue;

		// L2 git-meta: positive-whitelist. Catches git's own
		// destructive subcommands (git rm / git mv / git checkout -- /
		// git reset --hard / etc.) BEFORE the destructive
		// short-circuit below — git's own destructives use the L2
		// "destructive:" prefix and are explicitly listed in
		// `isGitMetaCommand`.
		if (gitTokens(seg)) {
			const verdict = isGitMetaCommand(seg);
			if (verdict.allow) continue;
			return { block: true, reason: verdict.reason };
		}

		// Destructive-command short-circuit
		// (GC-2026-015 follow-up — restores pre-existing
		// invariant). rm/mv/cp/unlink/rmdir are ALWAYS denied
		// regardless of target path, including L3 meta-file
		// allowlist hits. The four-layer refactor accidentally
		// relaxed this: `rm .pi/orchestrator/foo.md` had both
		// `canMainAgentWrite` AND `canMainAgentWriteMeta` returning
		// true, so `isProductionTarget` returned false and `rm`
		// slipped through (anti-goal: "destructives stay denied
		// regardless of which layer").
		{
			const segFirst = trimmedSeg.split(/\s+/, 1)[0]?.toLowerCase();
			if (segFirst && DESTRUCTIVE_FIRST_WORDS.has(segFirst)) {
				const preview = trimmedSeg.split(/\s+/).slice(0, 2).join(" ");
				return {
					block: true,
					reason: `destructive: ${preview} (rm/mv/cp/unlink/rmdir are always denied — use Agent to dispatch a developer subagent if meta-file cleanup is needed)`,
				};
			}
		}

		const classification = classifyBashCommand(seg);

		// L1 read-only segment is unconditionally safe.
		if (classification === "read-only") continue;
		if (classification === "git-meta") continue;

		// Write-intent segment — check its extracted targets.
		if (classification === "write-intent") {
			const targets = extractBashTargets(seg);
			if (targets.length === 0) {
				sawWriteWithoutTarget = true;
				continue;
			}
			for (const t of targets) {
				if (isProductionTarget(t, _ctx.cwd) && !seenDenied.has(t)) {
					seenDenied.add(t);
					deniedTargets.push(t);
				}
			}
			continue;
		}

		// Unknown segment — extract targets and check; also flag
		// sawUnknown so we can force opt-in below if no denied
		// targets surface from any segment.
		const segTargets = extractBashTargets(seg);
		if (segTargets.length === 0) {
			sawUnknown = true;
			continue;
		}
		for (const t of segTargets) {
			if (isProductionTarget(t, _ctx.cwd) && !seenDenied.has(t)) {
				seenDenied.add(t);
				deniedTargets.push(t);
			}
		}
	}

	// 2. Any denied target → block with the long reason.
	if (deniedTargets.length > 0) {
		return { block: true, reason: formatBlockReason(deniedTargets) };
	}

	// 3. Write-intent without a proven target is never safe.
	if (sawWriteWithoutTarget) {
		return {
			block: true,
			reason: "Write-intent bash command has no verifiable target; dispatch a developer subagent",
		};
	}

	// 4. Any unknown-no-target segment → block (no escape hatch; main agent must dispatch a subagent or rephrase).
	if (sawUnknown) {
		return {
			block: true,
			reason: "Unknown bash command; dispatch a subagent via Agent or rephrase with known-safe commands",
		};
	}

	// 4. All segments either read-only or write-intent to non-production
	//    paths (e.g. `/tmp/...`) → allow.
	return { block: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * Split a shell command into top-level segments separated by `&&`,
 * `||`, or `;`. Respects single quotes, double quotes, backslash
 * escapes, and paren / brace nesting. Empty segments are dropped.
 *
 * Used by `shouldBlockBashCommand` to defeat the chaining bypass where
 * a write-intent command (`rm src/foo.ts`) follows a read-only prefix
 * (`echo done`) and the first-word classifier alone would have let it
 * through.
 *
 * Behaviour:
 *   - `echo a && rm b`             → `["echo a", "rm b"]`
 *   - `rm a || echo b`             → `["rm a", "echo b"]`
 *   - `rm a; echo b`               → `["rm a", "echo b"]`
 *   - `echo "a && b" && c`         → `["echo \"a && b\"", "c"]`
 *     (the `&&` inside double quotes is data, not a separator)
 *   - `(echo done) && rm b`        → `["(echo done)", "rm b"]`
 *     (paren group counts as one segment)
 *   - `rm a\nrm b`                 → `["rm a\\nrm b"]`
 *     (newlines are NOT separators here — bash treats them as such but
 *      it's rare in tool calls; add if needed)
 *
 * Exported for unit testing; the gate calls it via
 * `shouldBlockBashCommand`.
 */
export function splitChainedCommands(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	let parenDepth = 0;
	let braceDepth = 0;

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
		// Quotes toggle; content is appended verbatim.
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

		// Outside quotes: track paren/brace depth + detect separators.
		if (!inSingle && !inDouble) {
			if (c === "(") parenDepth++;
			else if (c === ")") parenDepth--;
			else if (c === "{") braceDepth++;
			else if (c === "}") braceDepth--;

			// Top-level separators only — depth must be 0.
			if (parenDepth === 0 && braceDepth === 0) {
				if (c === ";") {
					if (current.trim()) segments.push(current.trim());
					current = "";
					i++;
					continue;
				}
				if (
					(c === "&" && command[i + 1] === "&") ||
					(c === "|" && command[i + 1] === "|")
				) {
					if (current.trim()) segments.push(current.trim());
					current = "";
					i += 2; // skip the second char of `&&` or `||`
					continue;
				}
			}
		}

		current += c;
		i++;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

/**
 * True iff `target` is a path the main agent should not write to.
 * Absolute paths (`/tmp/...`, `/var/...`) are treated as outside the
 * project and therefore NOT production targets — OS-level guards
 * apply separately. Relative paths are evaluated by `canMainAgentWrite`.
 */
function isProductionTarget(target: string, cwd: string): boolean {
	if (!target) return false;
	let policyTarget = target;
	if (isAbsolute(target)) {
		const root = resolve(cwd);
		const absolute = resolve(target);
		const fromRoot = relative(root, absolute).replaceAll("\\", "/");
		if (fromRoot === "" || fromRoot === ".") return true;
		if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) return false;
		policyTarget = fromRoot;
	}
	// `canMainAgentWrite` historically allows all Sages package files. L4 is
	// intentionally narrower: runtime source and tests still require developer.
	if (/^pi\/(?:src|test)\//.test(policyTarget)) return true;
	return !canMainAgentWrite(policyTarget) && !canMainAgentWriteMeta(policyTarget);
}

/**
 * Detect a write-targeting redirect: `> <path>`, `>> <path>`, and
 * the fd-prefixed forms `N>file`, `N>>file`, `&>file`, `&>>file`.
 *
 * Excludes fd duplications (`N>&M`, `>&M`) where `>` is immediately
 * followed by `&` — those are fd-redirects between file descriptors,
 * not writes to files.
 */
function hasWriteRedirect(cmd: string): boolean {
	// Use the shared prefix constant — keeps the two redirect sites
	// (classification + extraction) in lockstep.
	return WRITE_REDIRECT_PREFIX.test(cmd);
}

/** Long-form reason for production-target blocks. */
function formatBlockReason(targets: string[]): string {
	const listed = targets.join(", ");
	const lines: string[] = [
		`bash command targets production code: ${listed}`,
		"",
		"Main agent cannot directly modify production code.",
		"Use the Agent tool to dispatch a developer subagent (with an explicit managed-worktree isolation object):",
		"  Agent({",
		'    subagent_type: "developer",',
		'    prompt: "Implement <change> in <files>. <context>...",',
		"    run_in_background: true,",
		"  })",
		"",
		"There is no escape hatch. If this command is genuinely safe",
		"(e.g. writing to /tmp), rephrase the command or dispatch a",
		"subagent via Agent.",
	];
	return lines.join("\n");
}

// Re-export `policyMessage` from file-gate as a convenience for
// callers wiring the bash tool's `tool_call` event layer: they can
// import both the classifier and the canonical reason text from a
// single module without reaching into file-gate directly.
export { policyMessage };
/**
 * Bash Guard — classify bash commands and block write-intent
 * operations that target production code paths.
 *
 * The main orchestrator agent must not be able to bypass the
 * `developer` / `software-auditor` audit gate by issuing
 * raw `bash` commands (`rm`, `mv`, `cp`, `sed -i`, `find -delete`,
 * `git checkout --`, `tar -xf`, redirects, …). The `Agent` tool is
 * the only legitimate path for production-code changes.
 *
 * This module is a pure classifier + policy helper. The wiring into
 * the `bash` tool's `tool_call` event layer is P2's job; here we
 * expose three functions used by both the wiring and the tests:
 *
 *   classifyBashCommand(cmd)  → "read-only" | "write-intent" | "unknown"
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

import { isAbsolute } from "node:path";
// SC7 single-source-of-truth: import the path policy + the
// LLM-facing reason from `file-gate`. `policyMessage` is re-exported
// for callers that want to surface the meta-file denial verbatim;
// the bash-guard composes its own reason because the bash denial
// is command-shaped, not path-shaped.
import { canMainAgentWrite, policyMessage } from "./file-gate.js";

/** Unconditional read-only first-words. */
const READ_ONLY_FIRST_WORDS = new Set([
	"ls", "cat", "head", "tail", "grep", "wc", "file", "stat",
	"tree", "which", "jq", "env",
]);

/** Write-intent first-words (always win over read-only). */
const WRITE_INTENT_FIRST_WORDS = new Set([
	"rm", "mv", "cp", "sed", "perl", "tee", "truncate",
	"chmod", "chown", "tar", "unzip",
]);

/** Read-only prefix patterns. */
const READ_ONLY_PREFIX_PATTERNS: RegExp[] = [
	/^npm\s+(test|lint|typecheck)\b/,
	/^bun\s+test\b/,
	/^pytest\b/,
	/^cargo\s+test\b/,
	/^make\b/,
];

/** Read-only git subcommands. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch",
]);

/** Escape hatch prefix; the entire command bypasses the guard. */
const ESCAPE_HATCH = "# sages:safe";

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

export type BashClassification = "read-only" | "write-intent" | "unknown";

export interface BashGuardDecision {
	block: boolean;
	reason?: string;
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

	// 6. git read-only subcommands.
	if (firstWord === "git") {
		const tokens = trimmed.split(/\s+/);
		const sub = tokens[1];
		if (sub && READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return "read-only";
		if (sub === "worktree" && tokens[2] === "list") return "read-only";
		return "unknown";
	}

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
			for (const t of tokens.slice(1)) {
				if (!t.startsWith("-")) targets.push(t);
			}
			break;
		}
		case "mv": {
			// mv <src> <dst>   (take first non-flag and last non-flag)
			const args = tokens.slice(1).filter(t => !t.startsWith("-"));
			if (args.length >= 2) {
				targets.push(args[0], args[args.length - 1]);
			} else if (args.length === 1) {
				targets.push(args[0]);
			}
			break;
		}
		case "cp": {
			// cp <src> <dst>   → only <dst>
			const args = tokens.slice(1).filter(t => !t.startsWith("-"));
			if (args.length >= 2) targets.push(args[args.length - 1]);
			else if (args.length === 1) targets.push(args[0]);
			break;
		}
		case "tee": {
			for (const t of tokens.slice(1)) {
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
			//      's/a/b/' x.ts` → `x.ts`).
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
			// Path is the last non-flag token after the expression.
			const args = tokens.slice(1);
			for (let i = args.length - 1; i >= 0; i--) {
				if (!args[i].startsWith("-")) {
					targets.push(args[i]);
					break;
				}
			}
			break;
		}
		case "find": {
			// find <dir> -delete  → <dir>
			// The directory is the first non-flag argument.
			if (/(^|\s)-delete(\s|$)/.test(trimmed)) {
				const args = tokens.slice(1);
				const dir = args.find(a => !a.startsWith("-"));
				if (dir) targets.push(dir);
			}
			break;
		}
		case "tar": {
			// tar -xf|-xjf|-xzf <arc> [-C <dir>] → <dir> or cwd
			const cIdx = tokens.indexOf("-C");
			if (cIdx >= 0 && tokens[cIdx + 1]) {
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
 *   1. `# sages:safe` prefix (after trim) → never block (escape hatch).
 *   2. Split into chained segments on top-level `&&` / `||` / `;`.
 *      Walk each segment independently: a write-intent command chained
 *      after a read-only command (e.g. `echo done && rm src/foo.ts`)
 *      still trips the gate. See `splitChainedCommands` for the
 *      segmenter and T16–T22 in `bash-guard.test.ts` for coverage.
 *   3. If ANY segment is write-intent with a denied target → block
 *      with the long reason naming the union of denied targets.
 *   4. If ANY segment is `unknown` with no extractable targets → block
 *      with the short "Unknown bash command; prefix with '# sages:safe'"
 *      reason (forces the LLM to opt in explicitly).
 *   5. Otherwise → allow (all segments read-only OR write-intent to
 *      non-production paths).
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

	// 1. Escape hatch — opt-in bypass for genuinely safe commands.
	if (trimmed.startsWith(ESCAPE_HATCH)) {
		return { block: false };
	}

	// 2. Split into top-level chained segments (handles &&, ||, ;
	//    respecting quotes + paren/brace nesting).
	const segments = splitChainedCommands(trimmed);

	const deniedTargets: string[] = [];
	const seenDenied = new Set<string>();
	let sawUnknown = false;

	for (const seg of segments) {
		const trimmedSeg = seg.trimStart();
		if (!trimmedSeg) continue;

		const classification = classifyBashCommand(seg);

		// Read-only segment is unconditionally safe — skip.
		if (classification === "read-only") continue;

		// Write-intent segment — check its extracted targets.
		if (classification === "write-intent") {
			for (const t of extractBashTargets(seg)) {
				if (isProductionTarget(t) && !seenDenied.has(t)) {
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
			if (isProductionTarget(t) && !seenDenied.has(t)) {
				seenDenied.add(t);
				deniedTargets.push(t);
			}
		}
	}

	// 3. Any denied target → block with the long reason.
	if (deniedTargets.length > 0) {
		return { block: true, reason: formatBlockReason(deniedTargets) };
	}

	// 4. Any unknown-no-target segment → force opt-in via escape hatch.
	if (sawUnknown) {
		return {
			block: true,
			reason: "Unknown bash command; prefix with '# sages:safe' to bypass",
		};
	}

	// 5. All segments either read-only or write-intent to non-production
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
function isProductionTarget(target: string): boolean {
	if (!target) return false;
	if (isAbsolute(target)) return false;
	return !canMainAgentWrite(target);
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
		"Or, if this command is genuinely safe (e.g. writing to /tmp),",
		"prefix the command with:  # sages:safe",
	];
	return lines.join("\n");
}

// Re-export `policyMessage` from file-gate as a convenience for
// callers wiring the bash tool's `tool_call` event layer: they can
// import both the classifier and the canonical reason text from a
// single module without reaching into file-gate directly.
export { policyMessage };
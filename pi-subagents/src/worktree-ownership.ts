import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Raised when a worktree's git bookkeeping belongs to another clone. */
export class WorktreeOwnershipMismatch extends Error {
	readonly detail: {
		worktreePath: string;
		expectedCommondir: string;
		actualCommondir: string;
		expectedGitdir: string;
		actualGitdir: string;
	};

	constructor(detail: {
		worktreePath: string;
		expectedCommondir: string;
		actualCommondir: string;
		expectedGitdir: string;
		actualGitdir: string;
	}) {
		super(
			`worktree-ownership: ${detail.worktreePath} points to a foreign gitdir ` +
				`(expected commondir ${detail.expectedCommondir}, got ${detail.actualCommondir}; ` +
				`expected gitdir under ${detail.expectedGitdir}, got ${detail.actualGitdir}). ` +
				"Refusing to operate.",
		);
		this.name = "WorktreeOwnershipMismatch";
		this.detail = detail;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Raised when the target is a normal repository rather than a worktree. */
export class WorktreeGitPointerIsDirectory extends Error {
	constructor(readonly worktreePath: string) {
		super(
			`worktree-ownership: ${worktreePath}/.git is a directory, not a worktree pointer file`,
		);
		this.name = "WorktreeGitPointerIsDirectory";
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Raised when the target has no `.git` pointer. */
export class WorktreeGitPointerMissing extends Error {
	constructor(readonly worktreePath: string) {
		super(`worktree-ownership: ${worktreePath}/.git is missing`);
		this.name = "WorktreeGitPointerMissing";
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Raised when a `.git` pointer does not contain a usable `gitdir:` line. */
export class WorktreeGitPointerMalformed extends Error {
	constructor(readonly worktreePath: string) {
		super(
			`worktree-ownership: ${worktreePath}/.git has no usable gitdir pointer`,
		);
		this.name = "WorktreeGitPointerMalformed";
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

function canonicalPath(path: string): string {
	return realpathSync(path);
}

function parsePointer(worktreePath: string): {
	gitdir: string;
	commondir?: string;
} {
	const pointerPath = join(worktreePath, ".git");
	let kind: ReturnType<typeof lstatSync>;
	try {
		kind = lstatSync(pointerPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new WorktreeGitPointerMissing(worktreePath);
		}
		throw error;
	}
	if (kind.isDirectory()) throw new WorktreeGitPointerIsDirectory(worktreePath);
	if (!kind.isFile()) throw new WorktreeGitPointerMalformed(worktreePath);

	const contents = readFileSync(pointerPath, "utf8");
	const gitdirMatch = contents.match(/^gitdir:\s*(.+?)\s*$/m);
	if (!gitdirMatch) throw new WorktreeGitPointerMalformed(worktreePath);
	const commondirMatch = contents.match(/^commondir:\s*(.+?)\s*$/m);
	return {
		gitdir: gitdirMatch[1],
		commondir: commondirMatch?.[1],
	};
}

function resolvePointerPath(value: string, base: string): string {
	return canonicalPath(isAbsolute(value) ? value : resolve(base, value));
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${requireSeparator()}`) &&
		!isAbsolute(rel)
	);
}

function requireSeparator(): string {
	return process.platform === "win32" ? "\\" : "/";
}

/**
 * Verify that a worktree's `.git` pointer belongs to `expectedRepoRoot`.
 *
 * Git normally stores the commondir in `<gitdir>/commondir`, while the design
 * also permits a `commondir:` line in the pointer file. Both forms are read;
 * the final comparison is always made on realpaths so repository symlinks do
 * not create a false mismatch.
 */
export function verifyWorktreeOwnership(
	worktreePath: string,
	expectedRepoRoot: string,
): { gitdir: string; commondir: string } {
	const canonicalWorktreePath = canonicalPath(worktreePath);
	const pointer = parsePointer(canonicalWorktreePath);
	const gitdir = resolvePointerPath(pointer.gitdir, canonicalWorktreePath);
	const expectedCommondir = canonicalPath(
		join(canonicalPath(expectedRepoRoot), ".git"),
	);

	let commondir: string;
	if (pointer.commondir !== undefined) {
		commondir = resolvePointerPath(pointer.commondir, canonicalWorktreePath);
	} else {
		const commondirFile = join(gitdir, "commondir");
		try {
			if (statSync(commondirFile).isFile()) {
				const value = readFileSync(commondirFile, "utf8").trim();
				commondir = resolvePointerPath(value, gitdir);
			} else {
				commondir = canonicalPath(dirname(gitdir));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				commondir = canonicalPath(dirname(gitdir));
			} else {
				throw error;
			}
		}
	}

	if (commondir !== expectedCommondir || !isWithin(expectedCommondir, gitdir)) {
		throw new WorktreeOwnershipMismatch({
			worktreePath: canonicalWorktreePath,
			expectedCommondir,
			actualCommondir: commondir,
			expectedGitdir: expectedCommondir,
			actualGitdir: gitdir,
		});
	}

	return { gitdir, commondir };
}

/** Read and verify the pointer's canonical paths without ownership context. */
export function readWorktreeGitdir(worktreePath: string): {
	gitdir: string;
	commondir: string;
} {
	const canonicalWorktreePath = canonicalPath(worktreePath);
	const pointer = parsePointer(canonicalWorktreePath);
	const gitdir = resolvePointerPath(pointer.gitdir, canonicalWorktreePath);
	let commondir: string;
	if (pointer.commondir !== undefined) {
		commondir = resolvePointerPath(pointer.commondir, canonicalWorktreePath);
	} else {
		const commondirFile = join(gitdir, "commondir");
		try {
			const value = readFileSync(commondirFile, "utf8").trim();
			commondir = resolvePointerPath(value, gitdir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			commondir = canonicalPath(dirname(gitdir));
		}
	}
	return { gitdir, commondir };
}

/**
 * worktree-path-release.test.ts — `deleteManagedWorktreeByPath` containment.
 *
 * GC-2026-028 F1: the path-shaped release helper must accept paths that
 * truly live under `<repoRoot>/.pi/worktree/` and reject anything that
 * escapes — including via symlinks pointing outside the containment root.
 *
 * Pinned surfaces:
 *
 *   - contained path → release succeeds (returns `removed: true` after the
 *     worktree was provisioned through the identity helper, or `removed:
 *     false` when the path simply does not exist on disk yet).
 *   - escape path (sibling directory of `<repoRoot>`) → throws with the
 *     containment root in the message; no worktree state is touched.
 *   - symlink under `.pi/worktree` pointing outside the repo → throws with
 *     the containment root in the message.
 *
 * The regression we are pinning: GC-2026-028 discovered that the prior
 * check combined `relative()` with `isAbsolute(got.replace(expected, ""))`,
 * which is `true` for every contained path (the `replace` leaves a leading
 * `/`). The new check uses `relative(expected, realpathSync(got))` and only
 * flags `..` / absolute / empty escapes.
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createManagedWorktree,
	deleteManagedWorktreeByPath,
} from "../src/worktree.js";
import { makeRepoFixture, type RepoFixture } from "./_fixture.js";

describe("worktree-path-release: containment", () => {
	let fx: RepoFixture;
	beforeEach(() => {
		fx = makeRepoFixture("path-release");
	});
	afterEach(() => {
		fx.dispose();
	});

	it("releases a contained path under <repoRoot>/.pi/worktree/<dag>/<worktree>", () => {
		// Provision through the identity helper so a real worktree exists.
		createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-028",
			worktree: "P1",
		});
		const contained = join(fx.root, ".pi", "worktree", "GC-2026-028", "P1");

		const result = deleteManagedWorktreeByPath({
			repoRoot: fx.root,
			path: contained,
		});

		expect(result.removed).toBe(true);
		expect(result.reason).toBe("no-changes");
		expect(result.branch).toBe("sages/GC-2026-028/P1");
	});

	it("throws when the path escapes the repo root (sibling directory)", () => {
		// Build a sibling directory of fx.root that should be rejected outright.
		const sibling = join(fx.root, "..", "sibling-escape");
		mkdirSync(sibling, { recursive: true });
		// Write a marker file inside the sibling — proving we do not touch it.
		const marker = join(sibling, "untouched.txt");
		writeFileSync(marker, "must not be deleted or inspected");

		expect(() =>
			deleteManagedWorktreeByPath({ repoRoot: fx.root, path: sibling }),
		).toThrow(/is not contained under/);

		// The sibling file must still exist — containment refusal must not have
		// any side effect on the offending path.
		expect(() => {
			// Re-read to prove no deletion; import lazily to keep this self-contained.
			const { existsSync } = require("node:fs") as typeof import("node:fs");
			if (!existsSync(marker)) throw new Error("marker disappeared");
		}).not.toThrow();
	});

	it("throws when a symlink under .pi/worktree points outside the repo", () => {
		// Place a real directory outside the repo and symlink it from inside the
		// containment root. `realpathSync` will resolve the symlink, exposing the
		// escape; the helper must refuse before any destructive op.
		const external = join(fx.root, "..", "external-target");
		mkdirSync(external, { recursive: true });
		writeFileSync(join(external, "victim.txt"), "do not touch");

		const linkDir = join(fx.root, ".pi", "worktree", "GC-2026-028");
		mkdirSync(linkDir, { recursive: true });
		const linkPath = join(linkDir, "evil-link");
		symlinkSync(external, linkPath, "dir");

		expect(() =>
			deleteManagedWorktreeByPath({
				repoRoot: fx.root,
				path: linkPath,
			}),
		).toThrow(/is not contained under/);

		// External victim must still be present.
		expect(() => {
			const { existsSync } = require("node:fs") as typeof import("node:fs");
			if (!existsSync(join(external, "victim.txt"))) {
				throw new Error("symlinked victim was deleted");
			}
		}).not.toThrow();
	});

	it("refuses absolute paths that look contained but escape via '..'", () => {
		// `<repoRoot>/.pi/worktree/../foo` normalizes to `<repoRoot>/.pi/foo`,
		// which is outside the containment root even though the prefix matches.
		const sneaky = join(fx.root, ".pi", "worktree", "..", "foo");

		expect(() =>
			deleteManagedWorktreeByPath({ repoRoot: fx.root, path: sneaky }),
		).toThrow(/is not contained under/);
	});
});

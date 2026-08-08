/**
 * bucket-detector.test.ts — GC-2026-040 T2
 *
 * Tests for detectBucket(): maps a bash command string to a BucketKey
 * so the bash wrapper can enforce per-tool-call timeouts via
 * signalForTool(bucket) per design-timeout-architecture.md.
 *
 * Detection order: network → fullTest → test → read → search → other.
 */

import { describe, expect, it } from "vitest";
import { detectBucket } from "../src/tools/bucket-detector.js";

type Case = readonly [string, "read" | "search" | "test" | "fullTest" | "network" | "other"];

const CASES: ReadonlyArray<Case> = [
	// read
	["cat foo.txt", "read"],
	["cat /etc/passwd | head", "read"],
	["head -n 5 large.log", "read"],
	["tail -f", "read"],
	["less huge.json", "read"],
	["more file", "read"],

	// search
	["grep -r foo .", "search"],
	["rg pattern", "search"],
	["awk '{print $1}'", "search"],
	["sed -i s/foo/bar/g", "search"],
	["find . -name '*.ts'", "search"],

	// fullTest (bare suite run)
	["bun test", "fullTest"],
	["npm test", "fullTest"],
	["pnpm test", "fullTest"],
	["yarn test", "fullTest"],
	["npx jest", "fullTest"],
	["npx vitest", "fullTest"],
	["bun vitest", "fullTest"],
	["bunx vitest", "fullTest"],
	["bunx jest", "fullTest"],
	["jest", "fullTest"],
	["vitest", "fullTest"],

	// test (scoped — specific file or flag)
	["bun test src/foo.test.ts", "test"],
	["bun test --watch", "test"],
	["bun vitest run src/foo.test.ts", "test"],
	["bun vitest --watch", "test"],
	["bunx vitest run src/foo.test.ts", "test"],
	["bunx jest test/foo.test.ts", "test"],

	// network (git network ops)
	["git fetch", "network"],
	["git pull", "network"],
	["git clone https://example.com/repo.git", "network"],
	["git ls-remote", "network"],

	// network (http fetch)
	["curl https://example.com", "network"],
	["wget https://example.com", "network"],

	// network (package install)
	["npm install", "network"],
	["npm i", "network"],
	["bun install", "network"],
	["bun add foo", "network"],
	["yarn install", "network"],
	["yarn add foo", "network"],
	["pnpm install", "network"],
	["pnpm i", "network"],
	["pnpm add foo", "network"],

	// other (build, run, miscellaneous)
	["make", "other"],
	["make build", "other"],
	["cmake --build .", "other"],
	["cargo build", "other"],
	["cargo run", "other"],
	["npm run build", "other"],
	["python script.py", "other"],
	["node server.js", "other"],
	["ruby foo.rb", "other"],
	["bash -c 'echo hi'", "other"],
	["randomcommand arg1 arg2", "other"],
	["   ", "other"],

	// env-var prefixed commands (very common in CI / dev workflows)
	["NODE_ENV=test bun test", "fullTest"],
	["NODE_ENV=test bun vitest run", "test"],
	["FOO=bar npm test", "fullTest"],
	["FOO=bar A=1 npx vitest run src/foo.test.ts", "test"],
	["SOMETHING=1 git fetch origin", "network"],
	["FOO=bar make", "other"],
	["A=1 B=2 C=3 echo hello", "other"],

	// path-prefixed binaries
	["/usr/bin/cat /etc/passwd", "read"],
	["/usr/local/bin/git fetch", "network"],
	["./node_modules/.bin/vitest run src/foo.test.ts", "test"],
	["./node_modules/.bin/jest test/foo.test.ts", "test"],
	["../scripts/build.sh", "other"],
	["/bin/echo hello", "other"],
	["~/bin/my-tool --flag", "other"],
];

describe("detectBucket (GC-2026-040 T2)", () => {
	for (const [cmd, expected] of CASES) {
		it(`detects ${JSON.stringify(cmd)} as ${JSON.stringify(expected)}`, () => {
			expect(detectBucket(cmd)).toBe(expected);
		});
	}
});
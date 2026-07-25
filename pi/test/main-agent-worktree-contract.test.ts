import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = (file: string) =>
	readFileSync(join(root, "pi-subagents", "src", file), "utf8");

const index = source("index.ts");
const manager = source("agent-manager.ts");
const worktree = source("worktree.ts");
const types = source("types.ts");

describe("main-agent managed-worktree contract", () => {
	it("declares the explicit Agent JSON schema", () => {
		for (const field of ["dag_id", "task_id", "worktree_id", "mode"]) {
			expect(index).toContain(`${field}:`);
		}
		expect(index).toContain('Type.Literal("create")');
		expect(index).toContain('Type.Literal("reuse")');
	});

	it("provisions or reuses before child startup without managed /tmp fallback", () => {
		const provision = manager.indexOf("createManagedWorktree({");
		const childStart = manager.indexOf("const promise = runAgent(");
		expect(provision).toBeGreaterThan(-1);
		expect(provision).toBeLessThan(childStart);
		const managedBlock = manager.slice(
			manager.indexOf("if (options.managedWorktree)"),
			manager.indexOf("// Worktree isolation: try to create"),
		);
		expect(managedBlock).not.toContain("createWorktree(");
		expect(managedBlock).not.toContain("tmpdir");
	});

	it("surfaces the complete result handoff", () => {
		for (const field of ["path", "branch", "baseSha", "baseRef", "head", "dirty", "leaseToken"]) {
			expect(types).toContain(`${field}:`);
		}
		expect(index).toContain("worktree: record.managedWorktree");
	});

	it("leases explicit reuse and rejects concurrent reuse", () => {
		expect(manager.indexOf("acquireManagedWorktreeLease(")).toBeLessThan(
			manager.indexOf("createManagedWorktree({"),
		);
		expect(manager).toContain('reuse: req.mode === "reuse"');
		expect(worktree).toContain("lease already held");
	});

	it("exposes explicit release with optional branch deletion", () => {
		expect(manager).toContain("releaseManagedWorktree(");
		expect(manager).toContain("deleteManagedWorktreeByPath({");
		expect(manager).toContain("deleteManagedWorktree({");
		expect(manager).toContain("deleteBranch: args.deleteBranch");
	});

	it("does not append a legacy merge instruction for managed dispatch", () => {
		const managedCompletion = manager.slice(
			manager.indexOf("Managed-worktree agents do not auto-release"),
			manager.indexOf("Fire onComplete for foreground agents too"),
		);
		expect(managedCompletion).not.toContain("git merge");
	});

	it("instructs subagents not to write orchestrator state", () => {
		const prompts = source("prompts.ts");
		expect(prompts).toContain(".pi/orchestrator/");
		expect(prompts).toMatch(/must not write|do not write|never write/i);
	});
});

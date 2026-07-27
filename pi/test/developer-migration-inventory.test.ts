/**
 * Phase A inventory guard for the deprecated developer-agent name.
 *
 * Phase B helper note: this allowlist is provisional. The Phase B removal PR
 * will tighten it as compatibility aliases and migration documentation leave
 * the repository.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const LEGACY_DEVELOPER_NAME = "software-" + "developer";

const ALLOWED_PATHS = [
	/^AGENTS\.md$/,
	/^README\.md$/,
	/^pi\/README\.md$/,
	/^pi\/scripts\/install\.(?:sh|ps1|bat)$/,
	/^pi\/test\/install\.test\.sh$/,
	/^pi\/skills\/orchestrator\/SKILL\.md$/,
	/^pi\/skills\/orchestrator\/templates\/prompts\/subagent-developer\.md$/,
	/^pi\/templates\/(?:SYSTEM|SUBAGENTS|agent-tool-description)\.md$/,
	/^pi\/templates\/agents\/software-auditor\.md$/,
	/^pi-subagents\/src\/(?:agent-types|default-agents|invocation-config|index)\.ts$/,
	/^pi\/src\/tools\/orchestrator\/(?:dag-synthesizer|task-dispatcher|template-loader)\.ts$/,
	/^pi\/test\/tools\/orchestrator\/developer-migration\.test\.ts$/,
	/^pi-subagents\/src\/agent-prompts\/developer\.ts$/,
	/^pi-subagents\/test\/developer-[^/]+\.test\.ts$/,
	/^pi-subagents\/test\/default-agents\.test\.ts$/,
	/^pi-evaluator\/fixtures\/workflow-good\/\.pi\/orchestrator\//,
];

function isAllowed(path: string, text: string): boolean {
	// A scan may be broadened later to the software-agent family. Keep the
	// auditor template from becoming a false positive unless the same line
	// really names the deprecated developer alias.
	if (text.includes("software-auditor") && !text.includes(LEGACY_DEVELOPER_NAME)) {
		return true;
	}
	return ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

describe("Phase A developer migration inventory", () => {
	it("keeps deprecated-name references inside the provisional migration allowlist", () => {
		const result = spawnSync(
			"git",
			["grep", "--untracked", "-n", "--", LEGACY_DEVELOPER_NAME],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);

		expect([0, 1]).toContain(result.status);
		expect(result.stderr).toBe("");

		const unexpected = result.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const match = line.match(/^([^:]+):(\d+):(.*)$/);
				if (!match) throw new Error(`Unparseable git grep output: ${line}`);
				return { path: match[1], line: Number(match[2]), text: match[3] };
			})
			.filter(({ path, text }) => !isAllowed(path, text))
			.map(({ path, line, text }) => `${path}:${line}:${text}`);

		expect(unexpected).toEqual([]);
	});
});

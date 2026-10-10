import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..");
const PI_TASKS_DIR = join(REPO_ROOT, "pi-tasks");

describe("@sages/pi-tasks package exports", () => {
	let sandbox: string | undefined;

	afterEach(() => {
		if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	});

	it("resolves event-channels without TypeScript path aliases", async () => {
		sandbox = mkdtempSync(join(tmpdir(), "sages-pi-tasks-exports-"));
		const consumerDir = join(sandbox, "consumer");
		const scopeDir = join(consumerDir, "node_modules", "@sages");
		mkdirSync(scopeDir, { recursive: true });
		symlinkSync(PI_TASKS_DIR, join(scopeDir, "pi-tasks"), "dir");

		const importerPath = join(consumerDir, "extension.mjs");
		const jiti = createJiti(pathToFileURL(importerPath).href, {
			moduleCache: false,
		});
		const channels = await jiti.import<Record<string, unknown>>(
			"@sages/pi-tasks/event-channels",
		);

		expect(channels.TASKS_RPC_DECOMPOSE_MATERIALIZE).toBe("tasks:rpc:decompose-materialize");
		// GC-2026-remove-workflow-run-prod: WORKFLOW_START and
		// WORKFLOW_PHASE_COMPLETE channels are gone; only the
		// decompose-materialize RPC channel remains.
	});
});

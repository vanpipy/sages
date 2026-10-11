/**
 * catalog.test.ts — placeholder.
 *
 * The catalog files (subagent.json / event.json / namespace.json) and
 * their generator/verifier chain were removed in the script-slim commit
 * along with `verify-catalog.ts`, `gen-catalog.ts`, the recording layer
 * (`verify-recorder.ts`), the namespace-ownership scan, the
 * task-source-invariant check, and the subagent-usage aggregator. None
 * of these are wired into the orchestrator anymore; their tests had
 * no remaining target to assert against.
 *
 * The file is retained (rather than deleted) so the test path stays
 * reserved if catalogs are reintroduced later.
 */

import { describe, it, expect } from "bun:test";

describe("catalog files (removed)", () => {
	it("catalog generator/verifier chain was removed; placeholder keeps the path reserved", () => {
		expect(true).toBe(true);
	});
});
/**
 * failure-catalog.test.ts — GC-2026-044 T2 / mechanism 1.3.
 *
 * Covers design §5.7 (the seven RED cases) plus the boot-validation
 * guarantee SC3 asks for: the SHIPPED default catalog must schema-validate
 * or the sub-agent fails closed.
 *
 * The catalog is YAML, and pi-subagents has no YAML dependency (js-yaml is
 * a `pi/` dep and is not resolvable from here — see the T2 report). The
 * loader therefore carries its own strict subset parser; the last describe
 * block pins that parser's behaviour directly, because a homegrown parser
 * that silently mis-reads a regex is the one failure this mechanism cannot
 * afford.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	FailureCatalog,
	FailureCatalogInvalid,
	KNOWN_TEMPLATE_VARS,
	parseCatalogYaml,
	renderFeedbackTemplate,
	SHIPPED_CATALOG_PATH,
	templateVariables,
} from "../src/failure-catalog.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "failure-catalog-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write an override file into the scratch dir and return its path. */
function override(body: string): string {
	const p = join(dir, "failure-modes.yaml");
	writeFileSync(p, body, "utf-8");
	return p;
}

describe("FailureCatalog boot validation (design §5.4, SC3)", () => {
	it("T-CAT-00: the SHIPPED default catalog loads and schema-validates", () => {
		const cat = FailureCatalog.load();
		// The seven modes locked by the goal contract (design §5.3 + Q-F).
		expect(cat.allIds().sort()).toEqual(
			[
				"author-fabricated",
				"commit-message-non-conformant",
				"infra-unhandled",
				"pi-orchestrator-leak",
				"subagent-timeout",
				"verification-failed",
				"worktree-ownership-mismatch",
			].sort(),
		);
	});

	it("T-CAT-00b: the shipped catalog sits at SHIPPED_CATALOG_PATH", () => {
		// Guards the packaging assumption: `tsc` does not copy src/data/*.yaml
		// into dist/, so the extension is loaded from source and this path must
		// keep resolving next to the module.
		expect(existsSync(SHIPPED_CATALOG_PATH)).toBe(true);
		expect(SHIPPED_CATALOG_PATH.endsWith("failure-modes.v1.yaml")).toBe(true);
		expect(
			FailureCatalog.load({ shippedPath: SHIPPED_CATALOG_PATH }).allIds(),
		).toEqual(FailureCatalog.load().allIds());
	});

	it("T-CAT-01: a mode missing the required `detection` field fails boot", () => {
		// design §5.7.1 — RED case.
		const p = override(`schemaVersion: "v1"
modes:
  - id: "broken-mode"
    name: "Broken"
    description: "No detection block."
    kind: "spec"
    appliesTo: ["implement"]
    handler:
      kind: "noop"
      note: "nothing"
    retryBudget: 0
`);
		expect(() => FailureCatalog.load({ overridePath: p })).toThrow(
			FailureCatalogInvalid,
		);
	});

	it("T-CAT-01b: an unknown handler kind fails boot", () => {
		const p = override(`schemaVersion: "v1"
modes:
  - id: "bad-handler"
    name: "Bad handler"
    description: "Handler kind is not in the union."
    kind: "spec"
    appliesTo: ["implement"]
    detection:
      kind: "structured"
      matches: ["SomeError"]
    handler:
      kind: "teleport"
      note: "not a real handler"
    retryBudget: 0
`);
		expect(() => FailureCatalog.load({ overridePath: p })).toThrow(
			FailureCatalogInvalid,
		);
	});

	it("T-CAT-01c: a duplicate id inside one file fails boot", () => {
		const p = override(`schemaVersion: "v1"
modes:
  - id: "dupe"
    name: "One"
    description: "First."
    kind: "spec"
    appliesTo: ["implement"]
    detection:
      kind: "structured"
      matches: ["A"]
    handler:
      kind: "noop"
      note: "n"
    retryBudget: 0
  - id: "dupe"
    name: "Two"
    description: "Second."
    kind: "spec"
    appliesTo: ["implement"]
    detection:
      kind: "structured"
      matches: ["B"]
    handler:
      kind: "noop"
      note: "n"
    retryBudget: 0
`);
		expect(() => FailureCatalog.load({ overridePath: p })).toThrow(
			/duplicate/i,
		);
	});

	it("T-CAT-01d: a `supersedes` pointing at an unknown id fails boot", () => {
		const p = override(`schemaVersion: "v1"
modes:
  - id: "ghost-superseder"
    name: "Ghost"
    description: "Supersedes a mode that does not exist."
    kind: "spec"
    appliesTo: ["implement"]
    detection:
      kind: "structured"
      matches: ["A"]
    handler:
      kind: "noop"
      note: "n"
    retryBudget: 0
    supersedes: ["no-such-mode"]
`);
		expect(() => FailureCatalog.load({ overridePath: p })).toThrow(
			/supersedes/i,
		);
	});

	it("T-CAT-01e: a feedbackTemplate using an unknown variable fails boot", () => {
		const p = override(`schemaVersion: "v1"
modes:
  - id: "bad-template"
    name: "Bad template"
    description: "References a variable the renderer cannot supply."
    kind: "spec"
    appliesTo: ["implement"]
    detection:
      kind: "structured"
      matches: ["A"]
    handler:
      kind: "retry-subagent"
      retryBudget: 1
      feedbackTemplate: "Broken {not_a_real_variable} here."
    retryBudget: 1
`);
		expect(() => FailureCatalog.load({ overridePath: p })).toThrow(
			/not_a_real_variable/,
		);
	});
});

describe("FailureCatalog lookup / matching (design §5.7)", () => {
	it("T-CAT-02: lookup of an unknown id returns undefined and does not throw", () => {
		const cat = FailureCatalog.load();
		expect(cat.lookup("unknown")).toBeUndefined();
	});

	it("T-CAT-03: matches() on a verifier FAIL line resolves verification-failed", () => {
		const cat = FailureCatalog.load();
		const hit = cat.matches({ stderr: "FAIL test/foo.test.ts" });
		expect(hit?.id).toBe("verification-failed");
	});

	it("T-CAT-04: matches() on a structured class name resolves the same-named mode", () => {
		const cat = FailureCatalog.load();
		const hit = cat.matches({ structuredClass: "WorktreeOwnershipMismatch" });
		expect(hit?.id).toBe("worktree-ownership-mismatch");
		expect(cat.matchesByClass("WorktreeOwnershipMismatch")?.id).toBe(
			"worktree-ownership-mismatch",
		);
	});

	it("T-CAT-04b: structured detection takes precedence over a regex hit", () => {
		// A payload that would ALSO satisfy verification-failed's regex must
		// still resolve to the structured mode — the structured signal is the
		// stronger evidence.
		const cat = FailureCatalog.load();
		const hit = cat.matches({
			structuredClass: "WorktreeOwnershipMismatch",
			stderr: "FAIL something else",
		});
		expect(hit?.id).toBe("worktree-ownership-mismatch");
	});

	it("T-CAT-04c: matches() returns undefined when nothing matches", () => {
		const cat = FailureCatalog.load();
		expect(cat.matches({ stderr: "everything is fine" })).toBeUndefined();
		expect(cat.matchesByClass("NoSuchError")).toBeUndefined();
	});

	it("T-CAT-04d: a commit subject without a Conventional Commits type matches", () => {
		const cat = FailureCatalog.load();
		expect(cat.matches({ freeText: "updated some files" })?.id).toBe(
			"commit-message-non-conformant",
		);
		// ...and a conformant subject does not.
		expect(cat.matches({ freeText: "feat(pi): add thing" })?.id).not.toBe(
			"commit-message-non-conformant",
		);
	});
});

describe("FailureCatalog project override (design §2.6, §5.7)", () => {
	it("T-CAT-05: an override with the same id wins on retryBudget", () => {
		const cat = FailureCatalog.load({
			overridePath: override(`schemaVersion: "v1"
modes:
  - id: "verification-failed"
    retryBudget: 7
`),
		});
		const mode = cat.lookup("verification-failed");
		expect(mode?.retryBudget).toBe(7);
		// Deep-merge: untouched shipped fields survive.
		expect(mode?.kind).toBe("spec");
		expect(mode?.detection.kind).toBe("regex");
	});

	it("T-CAT-06: an override with enabled:false hides the mode from lookup", () => {
		const cat = FailureCatalog.load({
			overridePath: override(`schemaVersion: "v1"
modes:
  - id: "verification-failed"
    enabled: false
`),
		});
		expect(cat.lookup("verification-failed")).toBeUndefined();
		expect(cat.allIds()).not.toContain("verification-failed");
		// A disabled mode must not match either.
		expect(cat.matches({ stderr: "FAIL test/foo.test.ts" })?.id).not.toBe(
			"verification-failed",
		);
	});

	it("T-CAT-06b: an override may append a brand-new id", () => {
		const cat = FailureCatalog.load({
			overridePath: override(`schemaVersion: "v1"
modes:
  - id: "project-specific-thing"
    name: "Project specific"
    description: "Only this project cares."
    kind: "error"
    appliesTo: ["merge"]
    detection:
      kind: "structured"
      matches: ["ProjectSpecificError"]
    handler:
      kind: "escalate-to-l3"
      note: "ask the operator"
    retryBudget: 0
`),
		});
		expect(cat.allIds()).toContain("project-specific-thing");
		expect(cat.matchesByClass("ProjectSpecificError")?.id).toBe(
			"project-specific-thing",
		);
		// Shipped modes are still there.
		expect(cat.lookup("verification-failed")).toBeDefined();
	});

	it("T-CAT-06c: a missing override path is not an error", () => {
		const cat = FailureCatalog.load({
			overridePath: join(dir, "does-not-exist.yaml"),
		});
		expect(cat.allIds()).toHaveLength(7);
	});
});

describe("feedback templates (design §5.7.7, Q-E)", () => {
	it("T-CAT-07: every shipped feedbackTemplate renders with no missing variables", () => {
		const cat = FailureCatalog.load();
		const vars: Record<string, string> = {};
		for (const name of KNOWN_TEMPLATE_VARS) vars[name] = `<${name}>`;

		for (const id of cat.allIds()) {
			const mode = cat.lookup(id);
			if (mode?.handler.kind !== "retry-subagent") continue;
			const rendered = renderFeedbackTemplate(
				mode.handler.feedbackTemplate,
				vars,
			);
			expect(rendered).not.toMatch(/\{[a-z_]+\}/);
		}
	});

	it("T-CAT-07b: rendering with a missing variable throws rather than emitting {var}", () => {
		expect(() => renderFeedbackTemplate("Stderr: {stderr_digest}", {})).toThrow(
			/stderr_digest/,
		);
	});

	it("T-CAT-07c: templateVariables extracts the placeholder names", () => {
		expect(templateVariables("a {sha} b {stderr_digest} c")).toEqual([
			"sha",
			"stderr_digest",
		]);
	});
});

describe("catalog YAML subset parser", () => {
	it("T-CAT-08: parses nested maps, lists, and inline arrays", () => {
		const parsed = parseCatalogYaml(`schemaVersion: "v1"
modes:
  - id: "a"
    appliesTo: ["implement", "verify"]
    detection:
      kind: "structured"
      matches: ["X", "Y"]
    retryBudget: 2
    enabled: true
`) as { schemaVersion: string; modes: Array<Record<string, unknown>> };

		expect(parsed.schemaVersion).toBe("v1");
		expect(parsed.modes).toHaveLength(1);
		expect(parsed.modes[0].id).toBe("a");
		expect(parsed.modes[0].appliesTo).toEqual(["implement", "verify"]);
		expect(parsed.modes[0].detection).toEqual({
			kind: "structured",
			matches: ["X", "Y"],
		});
		expect(parsed.modes[0].retryBudget).toBe(2);
		expect(parsed.modes[0].enabled).toBe(true);
	});

	it("T-CAT-09: preserves regex metacharacters inside double-quoted scalars", () => {
		// The whole point of a hand-rolled parser is that THIS does not rot.
		const parsed = parseCatalogYaml(
			'pattern: "^(FAIL|ERROR)\\\\s+#\\\\d+: .*$"\n',
		) as { pattern: string };
		expect(parsed.pattern).toBe("^(FAIL|ERROR)\\s+#\\d+: .*$");
		// A `#` inside quotes is NOT a comment.
		expect(parsed.pattern).toContain("#");
	});

	it("T-CAT-10: strips whole-line and trailing comments outside quotes", () => {
		const parsed = parseCatalogYaml(`# leading comment
a: 1   # trailing comment
b: "has # inside"
`) as { a: number; b: string };
		expect(parsed.a).toBe(1);
		expect(parsed.b).toBe("has # inside");
	});

	it("T-CAT-11: supports block scalars for multi-line feedback templates", () => {
		const parsed = parseCatalogYaml(`tpl: |
  line one
  line two
next: "x"
`) as { tpl: string; next: string };
		expect(parsed.tpl).toBe("line one\nline two\n");
		expect(parsed.next).toBe("x");
	});

	it("T-CAT-11b: `|-` strips the trailing newline", () => {
		const parsed = parseCatalogYaml(`tpl: |-
  only line
`) as { tpl: string };
		expect(parsed.tpl).toBe("only line");
	});

	it("T-CAT-12: rejects tab indentation rather than mis-parsing it", () => {
		expect(() => parseCatalogYaml("a:\n\tb: 1\n")).toThrow(/tab/i);
	});
});

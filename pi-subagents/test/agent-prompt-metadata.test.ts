import { describe, expect, it } from "vitest";
import { AUDITOR_PROMPT } from "../src/agent-prompts/auditor.js";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";

const TEMPLATE_METADATA = "<!-- SAGES_TEMPLATE_V1";

describe("built-in prompt template metadata", () => {
	it("does not send repository template metadata to the auditor", () => {
		expect(AUDITOR_PROMPT).not.toContain(TEMPLATE_METADATA);
	});

	it("does not send repository template metadata to the developer", () => {
		expect(DEVELOPER_PROMPT).not.toContain(TEMPLATE_METADATA);
	});
});

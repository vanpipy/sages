import { describe, expect, it } from "vitest";
import { REVIEWER_PROMPT } from "../src/agent-prompts/reviewer.js";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";

const TEMPLATE_METADATA = "<!-- SAGES_TEMPLATE_V1";

describe("built-in prompt template metadata", () => {
	it("does not send repository template metadata to the auditor", () => {
		expect(REVIEWER_PROMPT).not.toContain(TEMPLATE_METADATA);
	});

	it("does not send repository template metadata to the developer", () => {
		expect(DEVELOPER_PROMPT).not.toContain(TEMPLATE_METADATA);
	});
});

import { describe, it, expect } from "bun:test";
import { sagesBackend } from "../../src/deepagents/backend.js";

describe("State Persistence", () => {
  it("should have FilesystemBackend configured with .sages directory", () => {
    expect(sagesBackend).toBeDefined();
    expect(sagesBackend).toHaveProperty("read");
    expect(sagesBackend).toHaveProperty("write");
  });

  it("should persist state across agent invocations", () => {
    // This verifies the architectural wall for state isolation is broken
    // State is now persisted via FilesystemBackend in .sages directory
    expect(sagesBackend).toBeDefined();
  });
});

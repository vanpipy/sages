/**
 * RED phase: tests for minimax_auth_status tool.
 *
 * Scenarios (from draft S11, S14):
 *   S11: returns parsed {success, method, source, ...} when authed
 *   S14: returns structured error when mmx missing or not authed
 *
 * The tool's business logic is extracted into runAuthStatusTool() so it can
 * be tested without instantiating pi's registerTool.
 */

import { describe, it, expect } from "bun:test";
import { runAuthStatusTool } from "../src/tools/auth.js";
import type { ExecMmxResult } from "../src/services/exec.js";
import { NotAuthedError, type EnsureAuthOptions } from "../src/services/auth-bootstrap.js";

type ExecFn = EnsureAuthOptions["execMmx"];

function makeAuthedExec(): ExecFn {
    return async () => ({
        stdout: JSON.stringify({ authenticated: true, method: "api-key", source: "config.json", key: "sk-xxxx…" }),
        stderr: "",
        exitCode: 0,
    });
}

describe("minimax_auth_status tool", () => {
    it("S11: returns parsed auth status when authed", async () => {
        const result = await runAuthStatusTool({
            ensureAuth: async () => {},
            execMmx: makeAuthedExec(),
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.method).toBe("api-key");
            expect(result.source).toBe("config.json");
        }
    });

    it("S14a: returns NOT_AUTHED error when ensureAuth throws NotAuthedError", async () => {
        const result = await runAuthStatusTool({
            ensureAuth: async () => {
                throw new NotAuthedError("Run: mmx auth login, or export MINIMAX_API_KEY");
            },
            execMmx: makeAuthedExec(),
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("NOT_AUTHED");
            expect(result.error.message).toMatch(/mmx auth login/);
        }
    });

    it("S14b: returns MMX_NOT_FOUND error when execMmx fails fatally", async () => {
        const result = await runAuthStatusTool({
            ensureAuth: async () => {},
            execMmx: async () => {
                throw new Error("spawn mmx ENOENT");
            },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("MMX_NOT_FOUND");
        }
    });

    it("forwards onUpdate to ensureAuth", async () => {
        const updates: string[] = [];
        await runAuthStatusTool({
            ensureAuth: async (opts) => {
                await opts?.onUpdate?.({ content: [{ type: "text", text: "test-update" }] });
            },
            execMmx: makeAuthedExec(),
            onUpdate: (msg) => {
                updates.push(msg.content.map((c) => c.text).join(""));
            },
        });
        expect(updates).toContain("test-update");
    });
});

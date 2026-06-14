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
import { NotAuthedError, type EnsureAuthOptions } from "../src/services/auth-bootstrap.js";
import { AUTHED_APIKEY_RESPONSE } from "./_helpers/mockExec.js";

type ExecFn = EnsureAuthOptions["execMmx"];

function makeAuthedExec(): ExecFn {
    return async () => AUTHED_APIKEY_RESPONSE();
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

    it("returns TIMEOUT error when execMmx returns timedOut: true", async () => {
        const result = await runAuthStatusTool({
            ensureAuth: async () => {},
            execMmx: async () => ({ stdout: "", stderr: "killed", exitCode: 124, timedOut: true }),
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe("TIMEOUT");
            expect(result.error.message).toMatch(/timed out/);
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

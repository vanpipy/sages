/**
 * RED phase: tests for auth-status parser.
 *
 * The `mmx auth status --output json` output has two shapes:
 *   Unauthenticated: {authenticated: false, message, hint}
 *   Authenticated:   {method, source, key?, token_expires?, account?}
 *                    (the `authenticated: true` field may be omitted)
 */

import { describe, it, expect } from "bun:test";
import { parseAuthStatus, isAuthed, type AuthStatus } from "../src/services/auth-status.js";

describe("auth-status parser", () => {
    it("parses unauthenticated status", () => {
        const stdout = JSON.stringify({
            authenticated: false,
            message: "Not authenticated.",
            hint: "Run: mmx auth login\nOr set $MINIMAX_API_KEY",
        });
        const status = parseAuthStatus(stdout);
        expect(status.authenticated).toBe(false);
        expect(isAuthed(status)).toBe(false);
        if (!isAuthed(status)) {
            expect(status.message).toBe("Not authenticated.");
            expect(status.hint).toMatch(/mmx auth login/);
        }
    });

    it("parses authenticated status with api-key method", () => {
        const stdout = JSON.stringify({
            authenticated: true,
            method: "api-key",
            source: "config.json",
            key: "sk-xxxx…",
        });
        const status = parseAuthStatus(stdout);
        expect(isAuthed(status)).toBe(true);
        if (isAuthed(status)) {
            expect(status.method).toBe("api-key");
            expect(status.source).toBe("config.json");
            expect(status.key).toBe("sk-xxxx…");
        }
    });

    it("parses authenticated status with oauth method", () => {
        const stdout = JSON.stringify({
            authenticated: true,
            method: "oauth",
            source: "config.json",
            account: "user@example.com",
            token_expires: "2026-06-14T20:00:00.000Z",
        });
        const status = parseAuthStatus(stdout);
        expect(isAuthed(status)).toBe(true);
        if (isAuthed(status)) {
            expect(status.method).toBe("oauth");
            expect(status.account).toBe("user@example.com");
            expect(status.token_expires).toBe("2026-06-14T20:00:00.000Z");
        }
    });

    it("treats missing `authenticated` field as authed (when method is present)", () => {
        // mmx-cli sometimes omits `authenticated: true` when reporting authed status
        const stdout = JSON.stringify({
            method: "api-key",
            source: "config.json",
            key: "sk-yyyy…",
        });
        const status = parseAuthStatus(stdout);
        expect(isAuthed(status)).toBe(true);
    });

    it("throws on invalid JSON", () => {
        expect(() => parseAuthStatus("not json")).toThrow(/Invalid auth status JSON/);
    });

    it("returns trimmed stdout if leading/trailing whitespace", () => {
        const stdout = "  \n" + JSON.stringify({ authenticated: false, message: "x", hint: "y" }) + "\n  ";
        const status = parseAuthStatus(stdout);
        expect(status.authenticated).toBe(false);
    });
});

import { describe, it, expect } from "bun:test";
import { ResponseParser } from "../src/services/response-parser.js";

describe("ResponseParser", () => {
  const parser = new ResponseParser();

  describe("parseRpcResponse (success)", () => {
    it("parses valid JSON-RPC result", () => {
      const raw = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "branch created" }] },
      });
      const result = parser.parseRpcResponse(raw);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ content: [{ type: "text", text: "branch created" }] });
    });

    it("accepts object input directly", () => {
      const obj = {
        jsonrpc: "2.0",
        id: 1,
        result: { foo: "bar" },
      };
      const result = parser.parseRpcResponse(obj);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ foo: "bar" });
    });
  });

  describe("parseRpcResponse (errors)", () => {
    it("returns error for JSON-RPC error response", () => {
      const raw = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid Request" },
      });
      const result = parser.parseRpcResponse(raw);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("RPC_ERROR");
      expect(result.error?.message).toContain("Invalid Request");
    });

    it("returns error for malformed JSON", () => {
      const result = parser.parseRpcResponse("not json{");
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("PARSE_ERROR");
    });
  });

  describe("extractError (yunxiao error code mapping)", () => {
    it("maps AuthFail to TOKEN_EXPIRED", () => {
      const e = parser.extractError({
        errorCode: "AuthFail",
        errorMessage: "Token invalid",
      });
      expect(e.code).toBe("TOKEN_EXPIRED");
      expect(e.suggestion).toContain("token");
    });

    it("maps NotFound to REPO_NOT_FOUND", () => {
      const e = parser.extractError({
        errorCode: "NotFound",
        errorMessage: "Repo missing",
      });
      expect(e.code).toBe("REPO_NOT_FOUND");
    });

    it("maps MissingParameter to VALIDATION", () => {
      const e = parser.extractError({
        errorCode: "MissingParameter",
        errorMessage: "branch required",
      });
      expect(e.code).toBe("VALIDATION");
    });

    it("maps RateLimit to RATE_LIMITED with retry suggestion", () => {
      const e = parser.extractError({
        errorCode: "RateLimit",
        errorMessage: "Too many requests",
      });
      expect(e.code).toBe("RATE_LIMITED");
      expect(e.suggestion).toContain("等待");
    });

    it("maps 5xx to UPSTREAM_ERROR", () => {
      const e = parser.extractError({ status: 502, message: "Bad Gateway" });
      expect(e.code).toBe("UPSTREAM_ERROR");
    });

    it("passes through unknown errorCode as UNKNOWN", () => {
      const e = parser.extractError({
        errorCode: "WeirdError",
        errorMessage: "Something",
      });
      expect(e.code).toBe("UNKNOWN");
    });
  });
});

/**
 * MiniMax Errors Unit Tests
 * Validates error hierarchy and parsing
 */

import { describe, it, expect } from "bun:test";
import {
  MiniMaxError,
  AuthenticationError,
  RateLimitError,
  ValidationError,
  APIError,
  NetworkError,
  parseAPIError,
} from "../../src/tools/minimax/errors.js";

describe("MiniMax Error Hierarchy", () => {
  describe("MiniMaxError", () => {
    it("should create error with message", () => {
      const error = new MiniMaxError("Something went wrong");
      expect(error.message).toBe("Something went wrong");
      expect(error.name).toBe("MiniMaxError");
    });

    it("should create error with code", () => {
      const error = new MiniMaxError("Timeout", "timeout");
      expect(error.message).toBe("Timeout");
      expect(error.code).toBe("timeout");
    });

    it("should create error with status code", () => {
      const error = new MiniMaxError("Bad Request", "bad_request", 400);
      expect(error.message).toBe("Bad Request");
      expect(error.code).toBe("bad_request");
      expect(error.statusCode).toBe(400);
    });

    it("should be instance of Error", () => {
      const error = new MiniMaxError("Test");
      expect(error instanceof Error).toBe(true);
    });
  });

  describe("AuthenticationError", () => {
    it("should create with default message", () => {
      const error = new AuthenticationError();
      expect(error.message).toBe("Authentication failed");
      expect(error.name).toBe("AuthenticationError");
      expect(error.code).toBe("AUTH_ERROR");
      expect(error.statusCode).toBe(401);
    });

    it("should create with custom message", () => {
      const error = new AuthenticationError("Invalid API key");
      expect(error.message).toBe("Invalid API key");
    });

    it("should be instance of MiniMaxError", () => {
      const error = new AuthenticationError();
      expect(error instanceof MiniMaxError).toBe(true);
    });
  });

  describe("RateLimitError", () => {
    it("should create with default message", () => {
      const error = new RateLimitError();
      expect(error.message).toBe("Rate limit exceeded");
      expect(error.name).toBe("RateLimitError");
      expect(error.code).toBe("RATE_LIMIT");
      expect(error.statusCode).toBe(429);
    });

    it("should create with custom message", () => {
      const error = new RateLimitError("Quota exceeded");
      expect(error.message).toBe("Quota exceeded");
    });

    it("should be instance of MiniMaxError", () => {
      const error = new RateLimitError();
      expect(error instanceof MiniMaxError).toBe(true);
    });
  });

  describe("ValidationError", () => {
    it("should create with message", () => {
      const error = new ValidationError("Invalid parameter");
      expect(error.message).toBe("Invalid parameter");
      expect(error.name).toBe("ValidationError");
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.statusCode).toBe(400);
    });

    it("should be instance of MiniMaxError", () => {
      const error = new ValidationError("Test");
      expect(error instanceof MiniMaxError).toBe(true);
    });
  });

  describe("APIError", () => {
    it("should create with message", () => {
      const error = new APIError("Server error");
      expect(error.message).toBe("Server error");
      expect(error.name).toBe("APIError");
    });

    it("should create with status code", () => {
      const error = new APIError("Internal error", 500);
      expect(error.statusCode).toBe(500);
    });

    it("should create with code", () => {
      const error = new APIError("Server error", 500, "INTERNAL_ERROR");
      expect(error.code).toBe("INTERNAL_ERROR");
    });

    it("should be instance of MiniMaxError", () => {
      const error = new APIError("Test");
      expect(error instanceof MiniMaxError).toBe(true);
    });
  });

  describe("NetworkError", () => {
    it("should create with default message", () => {
      const error = new NetworkError();
      expect(error.message).toBe("Network request failed");
      expect(error.name).toBe("NetworkError");
      expect(error.code).toBe("NETWORK_ERROR");
    });

    it("should create with custom message", () => {
      const error = new NetworkError("Connection refused");
      expect(error.message).toBe("Connection refused");
    });

    it("should be instance of MiniMaxError", () => {
      const error = new NetworkError();
      expect(error instanceof MiniMaxError).toBe(true);
    });
  });
});

describe("parseAPIError", () => {
  it("should parse 401 as AuthenticationError", () => {
    const response = { status_code: 401, msg: "Invalid token" };
    const error = parseAPIError(response);
    expect(error.name).toBe("AuthenticationError");
    expect(error.message).toBe("Invalid token");
  });

  it("should parse 429 as RateLimitError", () => {
    const response = { status_code: 429, msg: "Too many requests" };
    const error = parseAPIError(response);
    expect(error.name).toBe("RateLimitError");
    expect(error.message).toBe("Too many requests");
  });

  it("should parse 400 as ValidationError", () => {
    const response = { status_code: 400, msg: "Invalid parameter" };
    const error = parseAPIError(response);
    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("Invalid parameter");
  });

  it("should parse other status codes as APIError", () => {
    const response = { status_code: 500, msg: "Internal server error" };
    const error = parseAPIError(response);
    expect(error.name).toBe("APIError");
    expect(error.message).toBe("Internal server error");
  });

  it("should parse code field as status_code", () => {
    const response = { code: 403, msg: "Forbidden" };
    const error = parseAPIError(response);
    expect(error.name).toBe("APIError");
    expect(error.message).toBe("Forbidden");
  });

  it("should default to Unknown API error", () => {
    const response = {};
    const error = parseAPIError(response);
    // Without status_code, defaults to APIError
    expect(error.name).toBe("APIError");
    expect(error.message).toBe("Unknown API error");
  });
});

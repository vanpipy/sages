/**
 * response-parser.ts - Parse JSON-RPC responses and map errors to friendly codes.
 */

import type { ParseResult, ToolError } from "../state/types.js";

export class ResponseParser {
  /**
   * Parse a JSON-RPC response. Accepts string (will JSON.parse) or object.
   */
  parseRpcResponse(raw: string | object): ParseResult {
    let obj: any;
    if (typeof raw === "string") {
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        return {
          success: false,
          error: { code: "PARSE_ERROR", message: `Failed to parse JSON-RPC response: ${(e as Error).message}` },
        };
      }
    } else {
      obj = raw;
    }

    if (obj && obj.error) {
      const err = obj.error;
      // If no yunxiao errorCode, this is a raw JSON-RPC protocol error
      if (!err.data?.errorCode && !err.errorCode) {
        return {
          success: false,
          error: {
            code: "RPC_ERROR",
            message: err.message || "JSON-RPC error",
            suggestion: `JSON-RPC 错误码: ${err.code}`,
          },
        };
      }
      const friendly = this.extractError({
        errorCode: err.data?.errorCode || err.errorCode,
        errorMessage: err.message,
        status: err.status,
      });
      return { success: false, error: friendly };
    }

    if (obj && obj.result !== undefined) {
      return { success: true, data: obj.result };
    }

    return {
      success: false,
      error: { code: "EMPTY_RESPONSE", message: "JSON-RPC response has no result or error" },
    };
  }

  /**
   * Map a Yunxiao API error to a friendly code + suggestion.
   */
  extractError(raw: { errorCode?: string; errorMessage?: string; message?: string; status?: number }): ToolError {
    const code = raw.errorCode || "";
    const message = raw.errorMessage || raw.message || "Unknown error";

    if (code === "AuthFail" || raw.status === 401) {
      return {
        code: "TOKEN_EXPIRED",
        message: "Yunxiao access token is invalid or expired",
        suggestion: "请轮换 token: https://codeup.aliyun.com → User Settings → Personal Access Tokens",
      };
    }
    if (code === "NotFound" || raw.status === 404) {
      return {
        code: "REPO_NOT_FOUND",
        message: `Resource not found: ${message}`,
        suggestion: "检查 git remote URL 是否正确；确认资源存在于当前组织",
      };
    }
    if (code === "MissingParameter" || code === "InvalidParameter") {
      return {
        code: "VALIDATION",
        message: `参数错误: ${message}`,
        suggestion: "重读 tool schema；检查必填字段",
      };
    }
    if (code === "RateLimit" || raw.status === 429) {
      return {
        code: "RATE_LIMITED",
        message: "请求过于频繁",
        suggestion: "等待 1-2 分钟后重试；考虑降低并发",
      };
    }
    if (raw.status && raw.status >= 500) {
      return {
        code: "UPSTREAM_ERROR",
        message: `Yunxiao API 错误 (${raw.status}): ${message}`,
        suggestion: "云效服务端问题，稍后重试",
      };
    }
    return {
      code: "UNKNOWN",
      message: `${code ? `[${code}] ` : ""}${message}`,
    };
  }
}

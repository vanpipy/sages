/**
 * MiniMax Error Hierarchy
 */

export class MiniMaxError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "MiniMaxError";
  }
}

export class AuthenticationError extends MiniMaxError {
  constructor(message = "Authentication failed") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends MiniMaxError {
  constructor(message = "Rate limit exceeded") {
    super(message, "RATE_LIMIT", 429);
    this.name = "RateLimitError";
  }
}

export class ValidationError extends MiniMaxError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

export class APIError extends MiniMaxError {
  constructor(
    message: string,
    statusCode?: number,
    code?: string
  ) {
    super(message, code, statusCode);
    this.name = "APIError";
  }
}

export class NetworkError extends MiniMaxError {
  constructor(message = "Network request failed") {
    super(message, "NETWORK_ERROR");
    this.name = "NetworkError";
  }
}

/**
 * Parse error from API response
 */
export function parseAPIError(response: {
  msg?: string;
  code?: number;
  status_code?: number;
}): MiniMaxError {
  const message = response.msg || "Unknown API error";
  const statusCode = response.status_code || response.code;

  if (statusCode === 401) {
    return new AuthenticationError(message);
  }
  if (statusCode === 429) {
    return new RateLimitError(message);
  }
  if (statusCode === 400) {
    return new ValidationError(message);
  }

  return new APIError(message, statusCode);
}

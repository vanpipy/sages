/**
 * auth-status.ts — Parser for `mmx auth status --output json`.
 *
 * Two output shapes:
 *   Unauthenticated: {authenticated: false, message, hint}
 *   Authenticated:   {method, source, key?, token_expires?, account?}
 *                    (`authenticated: true` may be omitted)
 */

export interface AuthStatusUnauthed {
    authenticated: false;
    message: string;
    hint: string;
}

export interface AuthStatusAuthed {
    /** May be omitted by mmx-cli's JSON output when method is present */
    authenticated?: true;
    method: "api-key" | "oauth";
    source: string;
    key?: string;
    token_expires?: string;
    account?: string;
}

export type AuthStatus = AuthStatusAuthed | AuthStatusUnauthed;

export class InvalidAuthStatusError extends Error {
    constructor(message: string, readonly raw: string) {
        super(message);
        this.name = "InvalidAuthStatusError";
    }
}

/**
 * Parse the stdout of `mmx auth status --output json` into a structured AuthStatus.
 * Throws InvalidAuthStatusError if the input is not valid JSON.
 */
export function parseAuthStatus(stdout: string): AuthStatus {
    const trimmed = stdout.trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new InvalidAuthStatusError(`Invalid auth status JSON: ${trimmed.slice(0, 80)}`, trimmed);
    }

    if (!parsed || typeof parsed !== "object") {
        throw new InvalidAuthStatusError("Auth status JSON is not an object", trimmed);
    }

    const obj = parsed as Record<string, unknown>;

    // Unauthenticated: explicit authenticated: false
    if (obj.authenticated === false) {
        return {
            authenticated: false,
            message: String(obj.message ?? ""),
            hint: String(obj.hint ?? ""),
        };
    }

    // Authenticated: has method field
    const method = obj.method;
    if (method === "api-key" || method === "oauth") {
        return {
            authenticated: true,
            method,
            source: String(obj.source ?? ""),
            key: typeof obj.key === "string" ? obj.key : undefined,
            token_expires: typeof obj.token_expires === "string" ? obj.token_expires : undefined,
            account: typeof obj.account === "string" ? obj.account : undefined,
        };
    }

    // Ambiguous: neither explicit unauthed nor has method
    throw new InvalidAuthStatusError(
        `Auth status JSON has no method or authenticated:false: ${trimmed.slice(0, 80)}`,
        trimmed,
    );
}

/**
 * Type guard: is this an authenticated status (with method)?
 */
export function isAuthed(status: AuthStatus): status is AuthStatusAuthed {
    return (status as AuthStatusAuthed).method !== undefined;
}

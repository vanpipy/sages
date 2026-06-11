/**
 * env-detect.ts - Environment variable utilities
 */

/**
 * Expand ~ to $HOME in a path string.
 */
export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return (process.env.HOME || "") + p.slice(1);
  }
  return p;
}

/**
 * Get env var with fallback default.
 */
export function getEnv(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Get env var as integer. Returns fallback on missing or unparseable.
 */
export function getEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Get env var as boolean. Recognizes: 1/true/yes/on (case-insensitive) as true.
 */
export function getEnvBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/**
 * Resolve Yunxiao access token from env or credentials file.
 * Priority: env > file. Returns null if neither is available.
 */
export async function resolveToken(credentialsFile: string): Promise<string | null> {
  if (process.env.YUNXIAO_ACCESS_TOKEN) {
    return process.env.YUNXIAO_ACCESS_TOKEN;
  }
  try {
    const file = Bun.file(credentialsFile);
    if (await file.exists()) {
      const text = (await file.text()).trim();
      return text || null;
    }
  } catch {
    // File unreadable; fall through to null
  }
  return null;
}

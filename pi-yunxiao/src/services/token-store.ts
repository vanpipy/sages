/**
 * token-store.ts - Resolves Yunxiao access token from env or credentials file.
 *
 * Priority: YUNXIAO_ACCESS_TOKEN env > ~/.config/yunxiao/credentials file.
 * set() writes with chmod 600 for security.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class TokenStore {
  private credentialsFile: string;

  constructor(credentialsFile: string) {
    this.credentialsFile = credentialsFile;
  }

  /** Returns true if token is available from any source. */
  async has(): Promise<boolean> {
    return (await this.get()) !== null;
  }

  /** Returns the token, or null if not configured. */
  async get(): Promise<string | null> {
    if (process.env.YUNXIAO_ACCESS_TOKEN) {
      return process.env.YUNXIAO_ACCESS_TOKEN;
    }
    try {
      const file = Bun.file(this.credentialsFile);
      if (await file.exists()) {
        const text = (await file.text()).trim();
        return text || null;
      }
    } catch {
      // File unreadable
    }
    return null;
  }

  /** Writes token to file with chmod 600. */
  async set(token: string): Promise<void> {
    await mkdir(dirname(this.credentialsFile), { recursive: true });
    await writeFile(this.credentialsFile, token + "\n", { mode: 0o600 });
  }

  /** Returns actionable hint when token is not configured. */
  notConfiguredHint(): string {
    return (
      `YUNXIAO_ACCESS_TOKEN not set. Either:\n` +
      `  1. export YUNXIAO_ACCESS_TOKEN=pt-xxxxx\n` +
      `  2. echo 'pt-xxxxx' > ${this.credentialsFile} && chmod 600 ${this.credentialsFile}\n` +
      `Get a token at https://codeup.aliyun.com (User Settings → Personal Access Tokens).`
    );
  }
}

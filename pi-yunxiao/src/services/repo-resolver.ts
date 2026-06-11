/**
 * repo-resolver.ts - Parse git remote URL and extract work item IDs.
 *
 * Yunxiao Codeup URL formats:
 *   - SSH: git@codeup.aliyun.com:{orgId}/{path}/{repoName}.git
 *   - HTTPS: https://codeup.aliyun.com/{orgId}/{path}/{repoName}.git
 *
 * repositoryId for API calls: URL-encode the path:
 *   "{orgId}%2F{path}%2F{repoName}"
 */

export interface RepoContext {
  orgId: string;
  repositoryId: string;
  repoName: string;
}

export class RepoResolver {
  /**
   * Extract work item ID from branch name (e.g., fix/WBGA-4215 → WBGA-4215).
   * Returns null if no match.
   */
  extractWorkItemId(branchName: string): string | null {
    const m = /^(?:fix|feat|chore)\/([A-Z]+-\d+)/.exec(branchName);
    return m ? m[1] : null;
  }

  /**
   * Parse a git remote URL into RepoContext.
   * Returns null if not a codeup.aliyun.com URL.
   */
  parseRemoteUrl(url: string): RepoContext | null {
    // Strip .git suffix
    const cleanUrl = url.replace(/\.git$/, "");

    // SSH: git@codeup.aliyun.com:org/path/repo
    let m = /^git@codeup\.aliyun\.com:([^/]+)\/(.+)$/.exec(cleanUrl);
    // HTTPS: https://codeup.aliyun.com/org/path/repo
    if (!m) m = /^https?:\/\/codeup\.aliyun\.com\/([^/]+)\/(.+)$/.exec(cleanUrl);
    if (!m) return null;

    const orgId = m[1];
    const fullPath = m[2]; // e.g., "pos/qipda" or "myrepo"
    const pathParts = fullPath.split("/");
    const repoName = pathParts[pathParts.length - 1];

    return {
      orgId,
      repositoryId: `${orgId}%2F${pathParts.join("%2F")}`,
      repoName,
    };
  }
}

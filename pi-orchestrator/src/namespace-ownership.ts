export type OrchestratorNamespaceOwner = "l3" | "developer" | "auditor";

const SAFE_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const L3_PATTERNS = [
  new RegExp(`^goal-${SAFE_SEGMENT}\\.yaml$`),
  new RegExp(`^dag-${SAFE_SEGMENT}\\.yaml$`),
  new RegExp(`^audit-state-${SAFE_SEGMENT}\\.yaml$`),
  /^audit-workflow\.md$/,
  new RegExp(`^audit-rollup-(?:task|batch)-${SAFE_SEGMENT}\\.md$`),
];
const DEVELOPER_PATTERNS = [
  new RegExp(`^task-${SAFE_SEGMENT}-report\\.md$`),
  new RegExp(`^handoff/${SAFE_SEGMENT}/${SAFE_SEGMENT}-handoff\\.md$`),
];
const AUDITOR_PATTERNS = [new RegExp(`^audit-${SAFE_SEGMENT}\\.md$`)];

function normalizeOwnedPath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.endsWith("/")) {
    throw new Error(`Invalid orchestrator namespace path: ${path}`);
  }
  const normalized = path.replace(/^\.pi\/orchestrator\//, "");
  if (normalized === "." || normalized === ".." || normalized.includes("/../") || normalized.startsWith("../")) {
    throw new Error(`Orchestrator path must be contained: ${path}`);
  }
  return normalized;
}

/** Return the sole role allowed to create or replace an orchestrator artifact. */
export function classifyOrchestratorNamespace(path: string): OrchestratorNamespaceOwner | null {
  const normalized = normalizeOwnedPath(path);
  if (L3_PATTERNS.some((pattern) => pattern.test(normalized))) return "l3";
  if (DEVELOPER_PATTERNS.some((pattern) => pattern.test(normalized))) return "developer";
  if (AUDITOR_PATTERNS.some((pattern) => pattern.test(normalized))) return "auditor";
  return null;
}

/** Fail closed for unowned names and cross-namespace overwrite attempts. */
export function assertOrchestratorNamespaceOwner(
  path: string,
  owner: OrchestratorNamespaceOwner,
): void {
  const actual = classifyOrchestratorNamespace(path);
  if (actual === null) throw new Error(`Unowned .pi/orchestrator namespace path: ${path}`);
  if (actual !== owner) {
    throw new Error(`Cross-namespace write rejected: ${path} is owned by ${actual}, not ${owner}`);
  }
}

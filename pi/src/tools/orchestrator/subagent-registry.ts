import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

export type SubagentKind = "read-only" | "write-isolated" | "write-meta";
export type IsolationMode = "none" | "current-workspace" | "worktree";

export interface SubagentEntry {
  id: string;
  kind: SubagentKind;
  isolation: IsolationMode[];
  run_in_background: boolean;
  gather: boolean;
  artifact_schema: string[];
}

export interface Registry {
  subagents: SubagentEntry[];
}

const SUBAGENT_KINDS = new Set<SubagentKind>(["read-only", "write-isolated", "write-meta"]);
const ISOLATION_MODES = new Set<IsolationMode>(["none", "current-workspace", "worktree"]);

let cached: Registry | undefined;

function registryPath(): string {
  if (process.env.SUBAGENT_REGISTRY_PATH) return process.env.SUBAGENT_REGISTRY_PATH;

  // The daemon runs from the repository root, while package scripts run from pi/.
  const repositoryPath = resolve("pi/subagents/registry.yaml");
  return existsSync(repositoryPath) ? repositoryPath : resolve("subagents/registry.yaml");
}

function validateRegistry(value: unknown): asserts value is Registry {
  if (typeof value !== "object" || value === null || !Array.isArray((value as Registry).subagents)) {
    throw new Error("subagent registry: required 'subagents' array is missing");
  }

  const subagents = (value as Registry).subagents;
  if (subagents.length === 0) {
    throw new Error("subagent registry: 'subagents' must contain at least one entry");
  }

  const ids = new Set<string>();
  for (const [index, candidate] of subagents.entries()) {
    const prefix = `subagent registry: entry ${index}`;
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error(`${prefix} must be an object`);
    }

    const entry = candidate as SubagentEntry;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`${prefix} requires a non-empty string 'id'`);
    }
    if (ids.has(entry.id)) {
      throw new Error(`subagent registry: duplicate id '${entry.id}'`);
    }
    ids.add(entry.id);

    if (!SUBAGENT_KINDS.has(entry.kind)) {
      throw new Error(`${prefix} '${entry.id}' has invalid 'kind'`);
    }
    if (
      !Array.isArray(entry.isolation)
      || entry.isolation.length === 0
      || entry.isolation.some((mode) => !ISOLATION_MODES.has(mode))
    ) {
      throw new Error(`${prefix} '${entry.id}' requires non-empty valid 'isolation' modes`);
    }
    if (typeof entry.run_in_background !== "boolean") {
      throw new Error(`${prefix} '${entry.id}' requires boolean 'run_in_background'`);
    }
    if (typeof entry.gather !== "boolean") {
      throw new Error(`${prefix} '${entry.id}' requires boolean 'gather'`);
    }
    if (
      !Array.isArray(entry.artifact_schema)
      || entry.artifact_schema.length === 0
      || entry.artifact_schema.some((field) => typeof field !== "string" || field.length === 0)
    ) {
      throw new Error(`${prefix} '${entry.id}' requires a non-empty string 'artifact_schema' array`);
    }
  }
}

export function loadRegistry(): Registry {
  if (cached) return cached;
  const raw = readFileSync(registryPath(), "utf-8");
  const parsed: unknown = yaml.load(raw);
  validateRegistry(parsed);
  cached = parsed;
  return parsed;
}

export function lookupSubagent(id: string): SubagentEntry | undefined {
  return loadRegistry().subagents.find((subagent) => subagent.id === id);
}

export function knownSubagentIds(): Set<string> {
  return new Set(loadRegistry().subagents.map((subagent) => subagent.id));
}

export function clearRegistryCache(): void {
  cached = undefined;
}

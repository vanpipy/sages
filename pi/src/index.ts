/**
 * Sages - pi Package (orchestrator + subagents)
 *
 * Provides the orchestrator workflow (goal → decompose → dispatch → audit)
 * that drives multi-task agent pipelines. Subagent execution itself
 * (`software-developer`, `software-auditor`) is delegated to the Agent
 * tool — those agents are installed as user-level agents by
 * `pi/scripts/install.sh`, see `pi/templates/SUBAGENTS.md`.
 *
 *   - Orchestrator: `goal_contract_create`, `dag_synthesize`,
 *     `task_dispatch`, `orchestrator_audit`
 *   - Subagents (delegated to Agent tool): `Explore`, `Plan`,
 *     `software-developer`, `software-auditor`, `general-purpose`
 *
 * File operations (read/write/edit/grep/bash) are not provided here —
 * they come from pi's built-ins (optionally AFT-backed via
 * `@cortexkit/aft-pi`, installed separately by install.sh).
 *
 * Workflow outputs are persisted to `.pi/orchestrator/`
 * (goal-{id}.yaml, dag-{id}.yaml, {task_id}-audit.md) and consumed by
 * the user-level subagent sessions.
 */

// Re-export the package extension entrypoint so other pi packages can
// compose it (e.g. for tests, or for downstream packages that want to
// mount the orchestrator surface).
export { default as default, default as registerSagesExtension } from "./extension.js";

// Orchestrator tool registrar — the only public API for in-process tools.
// Subagent personas (Explore / Plan / software-developer / software-auditor /
// general-purpose) are reached via the Agent tool, not through this index.
export { registerOrchestratorTools } from "./tools/orchestrator/index.js";

// Per-orchestrator runtime support — file I/O with security validation.
// FileService is the only cross-tool utility.
export { FileService } from "./services/file-service.js";
export { createFileService } from "./services/file-service.js";
/**
 * Sages - pi Package (orchestrator + subagents)
 *
 * Provides the orchestrator workflow (goal → decompose → dispatch → audit)
 * that drives multi-task agent pipelines. Subagent execution itself
 * (`developer`, `auditor`) is delegated to the Agent
 * tool — those agents are built-in to `pi-subagents`, see
 * `pi/templates/SUBAGENTS.md`.
 *
 *   - Orchestrator: `goal_contract_create`, `dag_synthesize`,
 *     `task_dispatch`, `orchestrator_audit`
 *   - Subagents (delegated to Agent tool): `Explore`, `Plan` (Planning Brief
 *     compiler), `developer`, `auditor`. The main agent owns decisions.
 *     `general-purpose` helper was removed; meta-file work now uses
 *     `developer` with `tdd: none`)
 *
 * File operations (read/write/edit/grep/bash) are not provided here —
 * they come from pi's built-ins (optionally AFT-backed via
 * `@cortexkit/aft-pi`, installed separately by install.sh).
 *
 * Workflow outputs are persisted to `.pi/orchestrator/`
 * (goal-{id}.yaml, dag-{id}.yaml, audit-{task_id}.md) and consumed by
 * the user-level subagent sessions.
 */

// Re-export the package extension entrypoint so other pi packages can
// compose it (e.g. for tests, or for downstream packages that want to
// mount the orchestrator surface).
export { default as default, default as registerSagesExtension } from "./extension.js";

// Orchestrator tool registrar — the only public API for in-process tools.
// Subagent personas (Explore / Plan / developer / auditor)
// are reached via the Agent tool, not through this index.
export { registerOrchestratorTools } from "./tools/orchestrator/index.js";

// Per-orchestrator runtime support — file I/O with security validation.
// FileService is the only cross-tool utility.
export { FileService } from "./services/file-service.js";
export { createFileService } from "./services/file-service.js";
/**
 * LuBan Tools - TDD Task Execution
 *
 * Part of: src/tools/luban/
 *
 * Simplified surface (per the simplify-actions principle):
 *   - luban_execute_task: single task, observe cycle (RED → GREEN → REFACTOR → complete)
 *   - luban_run_batch: planner — reads execution.yaml, returns ordered plan + first contract
 *
 * Removed:
 *   - luban_get_status (status returned in every execute_task response)
 *   - luban_execute_all (already removed)
 *   - luban_execute_batch (renamed to luban_run_batch; old name kept as deprecated stub)
 *
 * The LLM does the actual implementation via semantic tools
 * (serena_replace_symbol_body, serena_create_text_file, etc.).
 * LuBan validates test outcomes and auto-advances phases.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FileService } from "../../services/file-service.js";
import { parseExecutionYaml } from "./plan-parser.js";
import { detectFileConflicts, deriveTestFiles } from "./conflict-detector.js";
import { runTests, validateScope, TDD_GUIDE } from "./task-runner.js";
import type { LubanTask, TDDPhase } from "./types.js";

const WORKSPACE_DIR = ".sages/workspace";
const TASK_STATE_FILE = ".luban-task-state.json";

interface ToolContext {
  cwd: string;
  fileService: FileService;
}

// ============================================================================
// TaskStateManager — per-task state in .sages/workspace/.luban-task-state.json
// ============================================================================

type PhaseName = TDDPhase | "COMPLETE";

interface TaskState {
  task_id: string;
  task_description: string;
  files: string[];
  test_files: string[];
  test_command: string;
  current_phase: PhaseName;
  history: Array<{
    phase: PhaseName;
    test_outcome: "pass" | "fail";
    observed_at: string;
  }>;
  created_at: string;
  updated_at: string;
}

class TaskStateManager {
  private readonly cwd: string;
  private readonly fileService: FileService;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.fileService = new FileService(cwd, WORKSPACE_DIR);
  }

  private statePath(): string {
    return join(this.cwd, WORKSPACE_DIR, TASK_STATE_FILE);
  }

  private readAll(): Record<string, TaskState> {
    const content = this.fileService.read(TASK_STATE_FILE);
    if (!content) return {};
    try {
      return JSON.parse(content) as Record<string, TaskState>;
    } catch {
      return {};
    }
  }

  private writeAll(states: Record<string, TaskState>): void {
    const path = this.statePath();
    if (!existsSync(path)) {
      mkdirSync(join(path, ".."), { recursive: true });
    }
    writeFileSync(path, JSON.stringify(states, null, 2), "utf-8");
  }

  load(task_id: string): TaskState | null {
    const all = this.readAll();
    return all[task_id] ?? null;
  }

  save(state: TaskState): void {
    const all = this.readAll();
    state.updated_at = new Date().toISOString();
    all[state.task_id] = state;
    this.writeAll(all);
  }

  delete(task_id: string): void {
    const all = this.readAll();
    delete all[task_id];
    this.writeAll(all);
  }
}

// ============================================================================
// Phase progression
// ============================================================================

const PHASE_ORDER: PhaseName[] = ["RED", "GREEN", "REFACTOR", "COMPLETE"];

function nextPhase(current: PhaseName): PhaseName {
  const idx = PHASE_ORDER.indexOf(current);
  return PHASE_ORDER[idx + 1] ?? "COMPLETE";
}

function buildIntent(phase: PhaseName, task_description: string, files: string[], test_files: string[]): string {
  if (phase === "RED") {
    return `Write a failing test that exercises: "${task_description}". Use semantic tools (serena_create_text_file or serena_replace_symbol_body) to write the test file at ${test_files.join(", ")}. Run the test command and confirm it fails before re-calling.`;
  }
  if (phase === "GREEN") {
    return `Make the test pass with a minimal implementation. Use semantic tools (serena_find_symbol, serena_replace_symbol_body, serena_insert_after_symbol) to implement in ${files.join(", ")}. Run the test command and confirm it passes before re-calling.`;
  }
  if (phase === "REFACTOR") {
    return `Improve the code in ${files.join(", ")} without breaking the test. Use semantic tools to check for impact (serena_find_referencing_symbols, graphify_get_neighbors). Run the test command and confirm it still passes before re-calling.`;
  }
  return `Task complete.`;
}

function buildValidation(phase: PhaseName, state: TaskState): Record<string, unknown> {
  return {
    test_command: state.test_command,
    expected_outcome: phase === "RED" ? "fail" : "pass",
    files_required: phase === "RED" ? state.test_files : state.files,
    current_phase: phase,
  };
}

// ============================================================================
// luban_execute_task — observe cycle
// ============================================================================

async function executeTask(params: {
  task_id: string;
  task_description?: string;
  files?: string[];
  test_files?: string[];
  test_command?: string;
  deny_files?: string[];
  observation?: {
    phase: "RED" | "GREEN" | "REFACTOR";
    test_outcome: "pass" | "fail";
    files_changed?: string[];
  };
}, ctx: ToolContext): Promise<{ content: any[]; details?: unknown; isError?: boolean }> {
  const {
    task_id,
    task_description,
    files = [],
    test_files,
    test_command,
    deny_files = [],
    observation,
  } = params;

  const stateManager = new TaskStateManager(ctx.cwd);
  const effectiveTestFiles = test_files ?? deriveTestFiles(files);

  // ── Scope guard (only on init, before any state is created) ───────────
  if (!observation) {
    const scope = validateScope({
      sourceFiles: files,
      testFiles: effectiveTestFiles,
      denyFiles: deny_files,
    });
    if (!scope.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: scope.message,
          violations: scope.violations,
        }) }],
        isError: true,
        details: { violations: scope.violations },
      };
    }
  }

  // ── Observation path: validate, advance ────────────────────────────────
  if (observation) {
    const state = stateManager.load(task_id);
    if (!state) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: `Task '${task_id}' is not initialized. Call luban_execute_task without observation first.`,
        }) }],
        isError: true,
        details: { task_id },
      };
    }

    if (observation.phase !== state.current_phase) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: `Phase mismatch: task '${task_id}' is in '${state.current_phase}', got observation for '${observation.phase}'.`,
          current_phase: state.current_phase,
          observation_phase: observation.phase,
        }) }],
        isError: true,
        details: { expected: state.current_phase, got: observation.phase },
      };
    }

    // Re-run test command to verify the LLM's claim.
    const result = runTests({ testCommand: state.test_command, cwd: ctx.cwd });

    const observedPass = observation.test_outcome === "pass";
    const observedFail = observation.test_outcome === "fail";

    if (state.current_phase === "RED") {
      if (!observedFail) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: TDD_GUIDE.formatError("RED", "RED phase requires the test to FAIL. Write a test that exercises the missing behavior."),
          }) }],
          isError: true,
          details: { exitCode: result.exitCode, passed: result.passed, failed: result.failed },
        };
      }
      // Sanity-check via actual test run.
      if (result.exitCode === 0 && result.passed > 0 && result.failed === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: TDD_GUIDE.formatError("RED", "Test passed without implementation. Write a test that fails first."),
          }) }],
          isError: true,
          details: { exitCode: result.exitCode, passed: result.passed, failed: result.failed },
        };
      }
    } else if (state.current_phase === "GREEN") {
      if (!observedPass) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: TDD_GUIDE.formatError("GREEN", "GREEN phase requires the test to PASS. Implement the missing behavior."),
          }) }],
          isError: true,
          details: { exitCode: result.exitCode, passed: result.passed, failed: result.failed },
        };
      }
      if (result.failed > 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: TDD_GUIDE.formatError("GREEN", `${result.failed} tests still failing`),
            exit_code: result.exitCode,
            failed_count: result.failed,
          }) }],
          isError: true,
          details: { exitCode: result.exitCode, passed: result.passed, failed: result.failed },
        };
      }
    } else if (state.current_phase === "REFACTOR") {
      if (!observedPass) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: TDD_GUIDE.formatError("REFACTOR", "REFACTOR phase requires the test to STILL PASS. Behavior must not change."),
          }) }],
          isError: true,
          details: { exitCode: result.exitCode, passed: result.passed, failed: result.failed },
        };
      }
      if (result.failed > 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: TDD_GUIDE.formatError("REFACTOR", `Refactoring broke ${result.failed} tests`),
            exit_code: result.exitCode,
            failed_count: result.failed,
          }) }],
          isError: true,
          details: { exitCode: result.exitCode, passed: result.passed, failed: result.failed },
        };
      }
    }

    // Advance phase.
    state.history.push({
      phase: state.current_phase,
      test_outcome: observation.test_outcome,
      observed_at: new Date().toISOString(),
    });
    const next = nextPhase(state.current_phase);
    state.current_phase = next;

    if (next === "COMPLETE") {
      const completed: TaskState = { ...state, current_phase: "COMPLETE" };
      stateManager.delete(task_id);
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "complete",
          task_id: completed.task_id,
          phases: ["RED", "GREEN", "REFACTOR"],
          history: completed.history,
          summary: `Task '${completed.task_id}' complete: ${completed.task_description}`,
        }) }],
        details: { task: completed },
      };
    }

    stateManager.save(state);
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "in_progress",
        task_id: state.task_id,
        phase: state.current_phase,
        intent: buildIntent(state.current_phase, state.task_description, state.files, state.test_files),
        validation: buildValidation(state.current_phase, state),
        auto_advanced: true,
        last_observation: observation,
      }) }],
      details: { state, last_observation: observation },
    };
  }

  // ── Init path: create or continue ──────────────────────────────────────
  let state = stateManager.load(task_id);
  if (!state) {
    if (!task_description || !files || !test_command) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: "First call requires: task_id, task_description, files, test_command (test_files optional, defaults to derive from files).",
        }) }],
        isError: true,
        details: { task_id },
      };
    }

    state = {
      task_id,
      task_description,
      files,
      test_files: effectiveTestFiles,
      test_command,
      current_phase: "RED",
      history: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    stateManager.save(state);
  }

  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "in_progress",
      task_id: state.task_id,
      phase: state.current_phase,
      intent: buildIntent(state.current_phase, state.task_description, state.files, state.test_files),
      validation: buildValidation(state.current_phase, state),
      auto_advanced: false,
      history: state.history,
    }) }],
    details: { state },
  };
}

// ============================================================================
// luban_run_batch — planner
// ============================================================================

async function runBatchPlanner(params: {
  execution_yaml?: string;
}, ctx: ToolContext): Promise<{ content: any[]; details?: unknown; isError?: boolean }> {
  const path = params.execution_yaml || join(ctx.cwd, WORKSPACE_DIR, "execution.yaml");

  if (!existsSync(path)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        error: `execution.yaml not found at: ${path}`,
      }) }],
      isError: true,
      details: { path },
    };
  }

  try {
    const content = readFileSync(path, "utf-8");
    const plan = parseExecutionYaml(content);
    if (!plan) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: "Failed to parse execution.yaml",
        }) }],
        isError: true,
        details: { path },
      };
    }

    const conflictReport = detectFileConflicts(plan.tasks);
    const executionOrder = plan.tasks.map((t) => t.id); // plan-parser already sorts topologically
    const layers: string[][] = [];
    const remaining = new Set(plan.tasks.map((t) => t.id));
    const completed = new Set<string>();
    while (remaining.size > 0) {
      const layer: string[] = [];
      for (const task of plan.tasks) {
        if (!remaining.has(task.id)) continue;
        if (task.dependsOn.every((d) => completed.has(d))) {
          layer.push(task.id);
        }
      }
      if (layer.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: "Circular dependency detected in execution.yaml",
            remaining: [...remaining],
          }) }],
          isError: true,
          details: { remaining: [...remaining] },
        };
      }
      for (const id of layer) {
        remaining.delete(id);
        completed.add(id);
      }
      layers.push(layer);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "in_progress",
        plan: {
          name: plan.name,
          task_ids: plan.tasks.map((t) => t.id),
          execution_order: executionOrder,
          layers,
          conflicts: conflictReport.conflicts,
          max_parallel: plan.settings.maxParallel,
        },
        next_action: "Iterate: call luban_execute_task for each task in execution_order, advancing through RED → GREEN → REFACTOR → complete.",
      }) }],
      details: { plan, conflicts: conflictReport },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        error: `Failed to read execution.yaml: ${msg}`,
      }) }],
      isError: true,
      details: { error: msg },
    };
  }
}

// ============================================================================
// Tool registration
// ============================================================================

export function registerLubanTools(pi: ExtensionAPI): void {

  // ─── luban_execute_task ────────────────────────────────────────────────
  pi.registerTool({
    name: "luban_execute_task",
    label: "Execute Task (TDD)",
    description: "Execute a single task with TDD methodology (RED → GREEN → REFACTOR). The LLM does the actual implementation via semantic tools (serena_replace_symbol_body, etc.); this tool validates test outcomes and auto-advances phases. First call: returns contract for current phase. Subsequent calls with `observation`: validate and advance.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID (e.g., T1, T2)" }),
      task_description: Type.Optional(Type.String({ description: "Task description (required on first call)" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Source files the task will touch (required on first call)" })),
      test_files: Type.Optional(Type.Array(Type.String(), { description: "Test files (optional, defaults to files with .test.ts suffix)" })),
      test_command: Type.Optional(Type.String({ description: "Test command to run (default: bun test)" })),
      deny_files: Type.Optional(Type.Array(Type.String(), { description: "Files that must NOT be touched (scope guard)" })),
      observation: Type.Optional(Type.Object({
        phase: Type.Union([
          Type.Literal("RED"),
          Type.Literal("GREEN"),
          Type.Literal("REFACTOR"),
        ], { description: "Phase being observed" }),
        test_outcome: Type.Union([
          Type.Literal("pass"),
          Type.Literal("fail"),
        ], { description: "Observed test outcome" }),
        files_changed: Type.Optional(Type.Array(Type.String(), { description: "Files changed since last call" })),
      }, { description: "Observation of work done (drives auto-advance)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const fileService = new FileService(ctx.cwd, WORKSPACE_DIR);
      const toolCtx: ToolContext = { cwd: ctx.cwd, fileService };

      const result = await executeTask({
        task_id: params.task_id,
        task_description: params.task_description,
        files: params.files,
        test_files: params.test_files,
        test_command: params.test_command,
        deny_files: params.deny_files,
        observation: params.observation,
      }, toolCtx);

      return {
        content: result.content,
        details: result.details,
        isError: result.isError,
      };
    },
  });

  // ─── luban_run_batch ───────────────────────────────────────────────────
  pi.registerTool({
    name: "luban_run_batch",
    label: "Plan Batch (TDD)",
    description: "Planner: reads execution.yaml and returns an ordered plan with file conflicts and topological layers. The LLM then iterates: call luban_execute_task for each task in execution_order, advancing through RED → GREEN → REFACTOR → complete.",
    parameters: Type.Object({
      execution_yaml: Type.Optional(Type.String({ description: "Path to execution.yaml (default: .sages/workspace/execution.yaml)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const fileService = new FileService(ctx.cwd, WORKSPACE_DIR);
      const toolCtx: ToolContext = { cwd: ctx.cwd, fileService };

      const result = await runBatchPlanner(params, toolCtx);

      return {
        content: result.content,
        details: result.details,
        isError: result.isError,
      };
    },
  });

  // ─── Deprecated stubs (keep old names alive with redirect hints) ──────
  const stubs: Array<{ name: string; hint: string; deprecationNote: string }> = [
    {
      name: "luban_execute_all",
      hint: "Use luban_run_batch to plan, then iterate with luban_execute_task.",
      deprecationNote: "removed in v1 — replaced by planner + observe cycle",
    },
    {
      name: "luban_execute_batch",
      hint: "Use luban_run_batch instead.",
      deprecationNote: "renamed to luban_run_batch",
    },
    {
      name: "luban_get_status",
      hint: "Status is included in every luban_execute_task response.",
      deprecationNote: "merged into luban_execute_task response",
    },
  ];

  for (const stub of stubs) {
    pi.registerTool({
      name: stub.name,
      label: `[Deprecated] ${stub.name}`,
      description: `DEPRECATED (${stub.deprecationNote}): ${stub.hint}`,
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: `${stub.name} is deprecated. ${stub.hint}`,
            hint: stub.hint,
            deprecated: true,
            replacement: stub.hint.match(/Use (\w+)/)?.[1] ?? null,
          }) }],
          isError: true,
          details: { deprecated: true, replacement: stub.hint },
        };
      },
    });
  }
}
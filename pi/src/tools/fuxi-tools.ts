/**
 * Fuxi Tools (伏羲) - Architect
 *
 * Simplified 3-tool surface (per the simplify-actions principle):
 *   - fuxi_start:   initialize workflow
 *   - fuxi_design:  observe cycle (design → review → plan)
 *   - fuxi_end:     verdict-driven end (PASS / NEEDS_CHANGES / REJECTED)
 *
 * Each tool returns the contract shape: {status, intent, validation}.
 * Status included in every response — no separate status tool.
 *
 * Deprecated stubs (6): fuxi_request, fuxi_plan, fuxi_recover,
 * fuxi_get_status, fuxi_update_score, fuxi_brainstorm_recovery.
 * All return isError with redirect hint to the new 3-tool surface.
 *
 * The LLM does the actual design / drafting work via semantic tools
 * (serena_replace_symbol_body, graphify_god_nodes, etc.). Fuxi only
 * validates state and advances phases.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileService } from "../services/file-service.js";
import { WorkflowStateManager } from "../services/workflow-state-manager.js";
import {
  MIN_DRAFT_BYTES_BY_TIER,
  type DesignTier,
  type DraftScope,
} from "./qiaochui/types.js";
import { parseScopeSection, validateTierVsScope } from "../utils/scope-parser.js";

const WORKSPACE_DIR = ".sages/workspace";
const DESIGN_STATE_FILE = ".fuxi-design-state.json";
/**
 * Legacy / fallback min draft size — used when the draft has NO Scope section
 * (i.e., the agent didn't opt into tier-aware design).
 */
const LEGACY_MIN_DRAFT_BYTES = MIN_DRAFT_BYTES_BY_TIER.standard;

type DesignPhase = "design" | "review" | "plan";

interface DesignState {
  workflow_id: string;
  current_phase: DesignPhase;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// DesignStateManager — per-workflow design sub-phase
// ---------------------------------------------------------------------------

class DesignStateManager {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private path(): string {
    return join(this.cwd, WORKSPACE_DIR, DESIGN_STATE_FILE);
  }

  private ensureDir(): void {
    const dir = join(this.cwd, WORKSPACE_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  load(): DesignState | null {
    this.ensureDir();
    const path = this.path();
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as DesignState;
    } catch {
      return null;
    }
  }

  save(state: DesignState): void {
    this.ensureDir();
    state.updated_at = new Date().toISOString();
    writeFileSync(this.path(), JSON.stringify(state, null, 2), "utf-8");
  }

  delete(): void {
    const path = this.path();
    if (existsSync(path)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(path);
    }
  }
}

function buildDesignIntent(phase: DesignPhase, score?: number, scope?: DraftScope | null): string {
  if (phase === "design") {
    if (scope) {
      const minBytes = MIN_DRAFT_BYTES_BY_TIER[scope.tier];
      const inScopeList = scope.inScope.length > 0 ? scope.inScope.join(", ") : "(none declared)";
      return `Tier '${scope.tier}' detected. Write draft.md covering ONLY these in-scope MDD planes: ${inScopeList}. Use semantic tools (serena_read_file, graphify_query) to understand project context first. The draft must be at least ${minBytes} bytes for this tier. Out-of-scope planes will not be scored. Write to .sages/workspace/draft.md and call fuxi_design with observation when done.`;
    }
    return `Create draft.md. RECOMMENDED: include a ## Scope section declaring Tier (trivial|simple|standard) + In scope + Out of scope (justified). Tier drives the minimum byte size: trivial=100, simple=250, standard=500. Without a Scope section, the legacy rule applies: cover all 7 MDD planes (Business, Data, Control, Foundation, Observation, Security, Evolution) and reach ${LEGACY_MIN_DRAFT_BYTES} bytes. Use semantic tools (serena_read_file, graphify_query) to understand project context first.`;
  }
  if (phase === "review") {
    const scopeHint = scope
      ? ` Scope is '${scope.tier}' with in-scope planes: ${scope.inScope.join(", ") || "(none)"}. Reviewer should assess scope_justification as a dimension.`
      : ` No Scope section detected — legacy all-7-plane review applies.`
    return `Get a review score for draft.md. Run qiaochui_review (which auto-writes the score to state.json).${scopeHint} Then call fuxi_design with observation {phase: "review", score: N} where N >= 80.`;
  }
  if (phase === "plan") {
    return `Plan is approved. Run qiaochui_decompose to generate execution.yaml, then call luban_run_batch to start the batch. The /sages-plan slash command is the user-facing approval gate.`;
  }
  return `Design phase complete.`;
}

function buildDesignValidation(
  phase: DesignPhase,
  draftExists: boolean,
  draftSize: number,
  score?: number,
  scope?: DraftScope | null,
): Record<string, unknown> {
  const base = { current_phase: phase };
  if (phase === "design") {
    const minBytes = scope ? MIN_DRAFT_BYTES_BY_TIER[scope.tier] : LEGACY_MIN_DRAFT_BYTES;
    return {
      ...base,
      file: "draft.md",
      min_size: minBytes,
      legacy_min_size: LEGACY_MIN_DRAFT_BYTES,
      tier: scope?.tier ?? null,
      in_scope_planes: scope?.inScope ?? null,
      out_of_scope_planes: scope?.outOfScope.map(o => o.plane) ?? null,
      scope_justification_required: !!scope,
      draft_exists: draftExists,
      draft_size: draftSize,
    };
  }
  if (phase === "review") {
    return { ...base, score_required: ">= 80", current_score: score, scope_aware: !!scope };
  }
  if (phase === "plan") {
    return { ...base, next_step: "luban_run_batch" };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFuxiTools(pi: ExtensionAPI): void {

  // ─── fuxi_start ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "fuxi_start",
    label: "Start Workflow",
    description: "Initialize a new workflow: creates state.json and design sub-phase state. Returns the design contract.",
    parameters: Type.Object({
      plan_name: Type.String({ description: "Plan name (e.g., 'my-feature')" }),
      request: Type.String({ description: "User's feature request or description" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const fileService = new FileService(ctx.cwd);
      const stateManager = new WorkflowStateManager(ctx.cwd);
      const designManager = new DesignStateManager(ctx.cwd);

      const state = stateManager.create(params.plan_name, params.request);
      state.phase = "design";
      state.updatedAt = new Date().toISOString();
      stateManager.save(state);

      designManager.save({
        workflow_id: state.id,
        current_phase: "design",
        updated_at: new Date().toISOString(),
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "in_progress",
            phase: "design",
            workflow_id: state.id,
            plan_name: params.plan_name,
            intent: buildDesignIntent("design"),
            validation: buildDesignValidation("design", false, 0),
          }),
        }],
        details: { phase: "design", state, state_path: fileService.getFilePath("state.json") },
      };
    },
  });

  // ─── fuxi_design ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "fuxi_design",
    label: "Design (Observe)",
    description: "Observe cycle through design → review → plan. First call: returns contract for current phase. Subsequent calls with observation: validate work and auto-advance. Status returned in every response.",
    parameters: Type.Object({
      observation: Type.Optional(Type.Object({
        phase: Type.Union([
          Type.Literal("design"),
          Type.Literal("review"),
          Type.Literal("plan"),
        ], { description: "Phase being observed" }),
        draft_path: Type.Optional(Type.String({ description: "Path to draft.md (relative to workspace, e.g., 'draft.md')" })),
        score: Type.Optional(Type.Number({ description: "Review score (must be > 80 to advance review → plan)" })),
      }, { description: "Observation of design/review work done" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const fileService = new FileService(ctx.cwd);
      const stateManager = new WorkflowStateManager(ctx.cwd);
      const designManager = new DesignStateManager(ctx.cwd);

      // ── Init / status path ─────────────────────────────────────────
      if (!params.observation) {
        const design = designManager.load();
        if (!design) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "error",
              error: "No active workflow. Call fuxi_start first.",
            }) }],
            isError: true,
            details: { error: "no_workflow" },
          };
        }
        const state = stateManager.loadLatest();
        const draftInfo = checkDraft(fileService, "draft.md");
        const scope = draftInfo.exists ? parseScopeSection(draftInfo.content ?? "") : null;
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "in_progress",
            phase: design.current_phase,
            workflow_id: design.workflow_id,
            plan_name: state?.planName,
            intent: buildDesignIntent(design.current_phase, state?.score, scope),
            validation: buildDesignValidation(design.current_phase, draftInfo.exists, draftInfo.size, state?.score, scope),
            auto_advanced: false,
          }) }],
          details: { design, draft: draftInfo, state },
        };
      }

      const design = designManager.load();
      if (!design) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: "No active workflow. Call fuxi_start first.",
          }) }],
          isError: true,
          details: { error: "no_workflow" },
        };
      }

      const obs = params.observation;

      // Phase mismatch check.
      if (obs.phase !== design.current_phase) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: `Phase mismatch: design is at '${design.current_phase}', got observation for '${obs.phase}'.`,
            current_phase: design.current_phase,
            observation_phase: obs.phase,
          }) }],
          isError: true,
          details: { expected: design.current_phase, got: obs.phase },
        };
      }

      // ── design → review ────────────────────────────────────────────
      if (obs.phase === "design") {
        const draftPath = obs.draft_path || "draft.md";
        const draftInfo = checkDraft(fileService, draftPath);
        if (!draftInfo.exists) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "error",
              error: `draft.md not found at: ${draftInfo.fullPath}`,
            }) }],
            isError: true,
            details: { draft_path: draftPath },
          };
        }

        // Tier-aware validation: parse Scope section if present.
        const scope = parseScopeSection(draftInfo.content ?? "");
        const minBytes = scope ? MIN_DRAFT_BYTES_BY_TIER[scope.tier] : LEGACY_MIN_DRAFT_BYTES;
        const tierLabel = scope ? `tier '${scope.tier}'` : "legacy (no Scope section)";

        if (draftInfo.size < minBytes) {
          const guidance = scope
            ? `Tier '${scope.tier}' requires ≥ ${minBytes} bytes. Your draft is ${draftInfo.size} bytes.`
            : `No ## Scope section found — falling back to legacy rule: cover all 7 MDD planes and reach ≥ ${LEGACY_MIN_DRAFT_BYTES} bytes. Your draft is ${draftInfo.size} bytes. Tip: add a Scope section (e.g. "## Scope\\n- Tier: trivial\\n- In scope: [Foundation, Business]") to lower the bar.`;
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "error",
              error: `draft.md is too small (${draftInfo.size} bytes, min ${minBytes} for ${tierLabel}). ${guidance}`,
            }) }],
            isError: true,
            details: {
              size: draftInfo.size,
              min_size: minBytes,
              tier: scope?.tier ?? null,
              scope_driven: !!scope,
            },
          };
        }

        // Soft warning if tier doesn't match plane count band
        const tierWarning = scope ? validateTierVsScope(scope) : null;

        design.current_phase = "review";
        designManager.save(design);
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "in_progress",
            phase: "review",
            workflow_id: design.workflow_id,
            intent: buildDesignIntent("review", undefined, scope),
            validation: buildDesignValidation("review", true, draftInfo.size, undefined, scope),
            auto_advanced: true,
            last_observation: obs,
            tier: scope?.tier ?? null,
            tier_warning: tierWarning,
            scope_aware: !!scope,
          }) }],
          details: { design, auto_advanced: true, draft: draftInfo, scope, tierWarning },
        };
      }

      // ── review → plan ──────────────────────────────────────────────
      if (obs.phase === "review") {
        if (typeof obs.score !== "number") {
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "error",
              error: "Review observation requires a numeric 'score' field.",
            }) }],
            isError: true,
            details: { phase: obs.phase },
          };
        }
        if (obs.score < 80) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "error",
              error: `Score ${obs.score} is below 80. Plan can only start when score >= 80.`,
            }) }],
            isError: true,
            details: { score: obs.score },
          };
        }

        // Persist score to main state.
        const state = stateManager.loadLatest();
        if (state) {
          state.score = obs.score;
          state.phase = "plan";
          state.updatedAt = new Date().toISOString();
          stateManager.save(state);
        }

        design.current_phase = "plan";
        designManager.save(design);
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "in_progress",
            phase: "plan",
            workflow_id: design.workflow_id,
            score: obs.score,
            intent: buildDesignIntent("plan", obs.score),
            validation: buildDesignValidation("plan", true, 0, obs.score),
            auto_advanced: true,
            last_observation: obs,
          }) }],
          details: { design, score: obs.score, auto_advanced: true },
        };
      }

      // ── plan → complete (design portion done) ─────────────────────
      if (obs.phase === "plan") {
        // Plan is already approved (via /sages-plan slash command or direct call).
        // No-op acknowledge. The next stage is execute, handled by luban_*.
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "complete",
            phase: "plan",
            workflow_id: design.workflow_id,
            summary: "Design phase complete. Run luban_run_batch to start the execute phase.",
          }) }],
          details: { design },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: `Unknown design phase: ${obs.phase}`,
        }) }],
        isError: true,
        details: { phase: obs.phase },
      };
    },
  });

  // ─── fuxi_end ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "fuxi_end",
    label: "End Workflow",
    description: "End workflow based on audit verdict. Observation {verdict: 'PASS'} archives the workflow and returns complete. NEEDS_CHANGES returns to implement (LuBan). REJECTED returns to design (Fuxi). Without observation, validates that audit.md exists.",
    parameters: Type.Object({
      observation: Type.Optional(Type.Object({
        verdict: Type.Union([
          Type.Literal("PASS"),
          Type.Literal("NEEDS_CHANGES"),
          Type.Literal("REJECTED"),
        ], { description: "Audit verdict" }),
        force: Type.Optional(Type.Boolean({ description: "Force archive even if verdict is not PASS" })),
      }, { description: "Verdict observation (drives routing)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const fileService = new FileService(ctx.cwd);
      const stateManager = new WorkflowStateManager(ctx.cwd);
      const designManager = new DesignStateManager(ctx.cwd);

      const state = stateManager.loadLatest();
      if (!state) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: "No active workflow to end.",
          }) }],
          isError: true,
          details: { error: "no_active_workflow" },
        };
      }

      // ── No observation: validate audit.md exists ──────────────────────
      if (!params.observation) {
        const auditInfo = fileService.readAuditVerdict();
        if (!auditInfo.verdict) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "error",
              error: "No audit verdict found. Run gaoyao_finalize first, then call fuxi_end with observation {verdict: 'PASS'}.",
            }) }],
            isError: true,
            details: { error: "no_audit_verdict", phase: state.phase },
          };
        }
        // Surface the verdict so the LLM knows what to pass.
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "in_progress",
            phase: state.phase,
            current_verdict: auditInfo.verdict,
            current_score: auditInfo.score,
            intent: `Call fuxi_end with observation {verdict: "${auditInfo.verdict}"} to route the workflow.`,
            validation: { verdict_observed: auditInfo.verdict },
          }) }],
          details: { state, audit: auditInfo },
        };
      }

      const verdict = params.observation.verdict;
      const force = params.observation.force === true;
      const auditInfo = fileService.readAuditVerdict();

      // Update state with audit info.
      state.auditVerdict = auditInfo.verdict ?? verdict;
      state.auditScore = auditInfo.score;
      state.auditAttempts = (state.auditAttempts || 0) + 1;
      state.updatedAt = new Date().toISOString();

      // ── PASS: archive ────────────────────────────────────────────────
      if (verdict === "PASS" || force) {
        state.phase = "complete";
        stateManager.save(state);
        const archivePath = stateManager.archive();
        designManager.delete();

        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "complete",
            phase: "complete",
            verdict,
            score: auditInfo.score,
            archive_path: archivePath,
            summary: `Workflow archived: ${state.planName}`,
          }) }],
          details: { verdict, score: auditInfo.score, archivePath, phase: "complete" },
        };
      }

      // ── NEEDS_CHANGES: route to implement ────────────────────────────
      if (verdict === "NEEDS_CHANGES") {
        if ((state.auditAttempts || 0) >= 3) {
          state.phase = "design";
          stateManager.save(state);
          designManager.delete();
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "in_progress",
              phase: "design",
              verdict,
              score: auditInfo.score,
              intent: `Too many iterations (${state.auditAttempts}). Returning to design phase — Fuxi must redesign the approach.`,
              validation: { max_attempts_reached: true },
            }) }],
            details: { verdict, phase: "design", attempts: state.auditAttempts },
          };
        }

        state.phase = "implement";
        stateManager.save(state);
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "in_progress",
            phase: "implement",
            verdict,
            score: auditInfo.score,
            intent: `LuBan must fix the issues identified in audit.md. Run luban_run_batch to plan the remediation, then iterate through tasks.`,
            validation: { audit_md_required: true },
            attempts: state.auditAttempts,
          }) }],
          details: { verdict, phase: "implement", attempts: state.auditAttempts },
        };
      }

      // ── REJECTED: route to design ───────────────────────────────────
      if (verdict === "REJECTED") {
        state.phase = "design";
        stateManager.save(state);
        designManager.delete();
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "in_progress",
            phase: "design",
            verdict,
            score: auditInfo.score,
            intent: `Critical issues detected. Returning to design phase — Fuxi must revisit the architecture. Call fuxi_design to start a new draft.`,
            validation: { re_design_required: true },
          }) }],
          details: { verdict, phase: "design" },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: `Unhandled verdict: ${verdict}`,
        }) }],
        isError: true,
        details: { verdict },
      };
    },
  });

  // ─── Deprecated stubs ─────────────────────────────────────────────────
  const stubs: Array<{ name: string; hint: string; deprecationNote: string }> = [
    { name: "fuxi_request", hint: "Use fuxi_design (write draft.md, then call fuxi_design with observation).", deprecationNote: "draft creation merged into fuxi_design observe cycle" },
    { name: "fuxi_plan", hint: "Use fuxi_design with observation {phase: 'review', score} instead.", deprecationNote: "score-driven phase advance merged into fuxi_design" },
    { name: "fuxi_recover", hint: "Use fuxi_design (without observation) to recover current state.", deprecationNote: "status query merged into fuxi_design" },
    { name: "fuxi_get_status", hint: "Status is included in every fuxi_design response.", deprecationNote: "merged into fuxi_design response" },
    { name: "fuxi_update_score", hint: "Use fuxi_design with observation {phase: 'review', score} instead.", deprecationNote: "score update merged into fuxi_design review phase" },
    { name: "fuxi_brainstorm_recovery", hint: "Call fuxi_end with observation {verdict: 'NEEDS_CHANGES'}; it routes to implement phase with the recovery intent.", deprecationNote: "merged into fuxi_end NEEDS_CHANGES routing" },
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function checkDraft(fileService: FileService, path: string): {
  exists: boolean;
  size: number;
  fullPath: string;
  content: string | null;
} {
  const exists = fileService.exists(path);
  const content = exists ? fileService.read(path) : null;
  return {
    exists,
    size: content ? content.length : 0,
    fullPath: fileService.getFilePath(path),
    content,
  };
}
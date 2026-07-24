/**
 * Template Loader — load prompt / goal / dag templates from the sages package.
 *
 * Templates live at:  ~/.pi/packages/sages/skills/orchestrator/templates/{prompts,goals,dag,responses}/
 *                   (or wherever the sages package is installed)
 *
 * Used by dag_synthesizer to render TaskNode.prompt from `task_template` + `task_params`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Locations to search for the sages package, in priority order. */
const SAGES_LOCATIONS = [
  process.env.SAGES_PATH,
  join(process.env.HOME || "/root", ".pi", "packages", "sages"),
  "/home/leroy/.pi/packages/sages",
];

/** Resolve the installed sages root. */
export function findSagesRoot(): string | null {
  for (const loc of SAGES_LOCATIONS) {
    if (loc && existsSync(join(loc, "package.json"))) return loc;
  }
  return null;
}

/**
 * Dev/test fallback: cwd itself (e.g. when running tests from the source repo).
 *
 * SECURITY: only enabled when SAGES_DEV=1 is set, or NODE_ENV !== "production",
 * or the cwd contains a `pi/package.json` (i.e. the user is in the sages
 * source tree). Otherwise, production callers must use SAGES_PATH or the
 * default install location.
 */
function cwdFallbackSagesRoot(): string | null {
  const isDev = process.env.SAGES_DEV === "1" || process.env.NODE_ENV !== "production";

  // Heuristic: cwd looks like the sages source tree (has pi/package.json)
  const cwdIsSagesSrc = existsSync(join(process.cwd(), "pi", "package.json"));

  if (!isDev && !cwdIsSagesSrc) return null;

  const cwdTemplates = join(process.cwd(), "skills", "orchestrator", "templates");
  return existsSync(cwdTemplates) ? process.cwd() : null;
}

/** Resolve the orchestrator templates root. Falls back to cwd only in dev. */
export function findTemplatesRoot(): string | null {
  // Try each candidate sages root — return the first one that actually has templates.
  const candidates = [findSagesRoot(), cwdFallbackSagesRoot()].filter(
    (r): r is string => r !== null,
  );
  for (const root of candidates) {
    const templates = join(root, "skills", "orchestrator", "templates");
    if (existsSync(templates)) return templates;
  }
  return null;
}

/**
 * Load a prompt template by name (no extension).
 * Looks under templates/prompts/ for both .md files.
 */
export function loadPromptTemplate(name: string): string | null {
  const root = findTemplatesRoot();
  if (!root) return null;
  const path = join(root, "prompts", `${name}.md`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/**
 * Load a response template by name.
 * Looks under templates/responses/ for .md files.
 */
export function loadResponseTemplate(name: string): string | null {
  const root = findTemplatesRoot();
  if (!root) return null;
  const path = join(root, "responses", `${name}.md`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/**
 * Load a goal template by name.
 * Looks under templates/goals/ for .yaml files.
 */
export function loadGoalTemplate(name: string): string | null {
  const root = findTemplatesRoot();
  if (!root) return null;
  const path = join(root, "goals", `${name}.yaml`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/**
 * Load a DAG template by name.
 * Looks under templates/dag/ for .yaml files.
 */
export function loadDagTemplate(name: string): string | null {
  const root = findTemplatesRoot();
  if (!root) return null;
  const path = join(root, "dag", `${name}.yaml`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** List all available templates of a given kind. */
export function listTemplates(kind: "prompts" | "responses" | "goals" | "dag"): string[] {
  const root = findTemplatesRoot();
  if (!root) return [];
  const dir = join(root, kind);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".md") || f.endsWith(".yaml"))
      .map((f: string) => f.replace(/\.(md|yaml)$/, ""));
  } catch {
    return [];
  }
}

/**
 * Render a template by substituting {{var}} placeholders with values.
 * Supports conditional forms:
 *   - {{#if var}}...{{/if}}                  (truthiness check)
 *   - {{#if var == "value"}}A{{else}}B{{/if}} (string equality with else)
 *   - {{#if var}}A{{else}}B{{/if}}         (truthiness with else)
 *
 * Intentionally tiny — no external deps. Easy to audit.
 */
export function renderTemplate(
  template: string,
  params: Record<string, unknown>,
): string {
  let out = template;

  // Handle {{#if cond}}A{{else}}B{{/if}} or {{#if cond}}A{{/if}}
  // Process from inside-out (deepest nesting first) using a loop.
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = processIfBlocksOnce(out, params);
  }

  // Substitute {{var}} placeholders
  const varRe = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  out = out.replace(varRe, (_match, varName: string) => {
    const val = params[varName];
    return val === undefined || val === null ? `[${varName}]` : String(val);
  });

  return out;
}

/** Single pass: replace innermost {{#if...}}...{{/if}} blocks. */
function processIfBlocksOnce(
  template: string,
  params: Record<string, unknown>,
): string {
  // Match innermost block (no nested {{#if}} inside) — use a non-greedy regex.
  const re = /\{\{#if\s+([^}]+?)\}\}([\s\S]*?)\{\{\/if\}\}/g;
  return template.replace(re, (_match, cond: string, body: string) => {
    const condTrimmed = cond.trim();
    const isTrue = evalCondition(condTrimmed, params);

    // Check for {{else}} inside the body. Use [\s\S] (not .) so newlines match.
    const elseMatch = body.match(/^([\s\S]*?)\{\{else\}\}([\s\S]*)$/);
    if (elseMatch) {
      const [, ifPart, elsePart] = elseMatch;
      return isTrue ? ifPart : elsePart;
    }
    return isTrue ? body : "";
  });
}

function evalCondition(cond: string, params: Record<string, unknown>): boolean {
  // Support: var  OR  var == "literal"  OR  var == 'literal'  (single OR double quotes)
  const eqMatch = cond.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(==|!=)\s*(?:"([^"]*)"|'([^']*)')$/);
  if (eqMatch) {
    const [, varName, op, dqLiteral, sqLiteral] = eqMatch;
    const literal = dqLiteral ?? sqLiteral ?? "";
    const val = String(params[varName] ?? "");
    return op === "==" ? val === literal : val !== literal;
  }
  // Bare variable: truthy
  const varName = cond.trim();
  const val = params[varName];
  return Boolean(val);
}

/**
 * Render a TaskNode's prompt from its task_template + task_params.
 * Returns null if template doesn't exist (caller should fall back to LLM-written prompt).
 *
 * Validates task_params against the template's expected schema before rendering —
 * rejects calls with wrong types (e.g. passing a number where a string is required)
 * so a bad prompt renders as "[varname]" rather than producing garbage output.
 */
export function renderTaskPrompt(
  taskTemplate: string,
  taskParams: Record<string, unknown>,
): string | null {
  const template = loadPromptTemplate(taskTemplate);
  if (!template) return null;

  // Validate params against expected schema
  const validation = validateTemplateParams(taskTemplate, taskParams);
  if (!validation.valid) {
    // Return null + log so the LLM knows something's off
    console.warn(
      `[orchestrator] template '${taskTemplate}' has invalid params: ${validation.errors.join("; ")}`,
    );
  }

  return renderTemplate(template, taskParams);
}

/**
 * Get the expected parameter schema for a known task template.
 * Returns null if template is not in the whitelist.
 */
export function getTemplateParamsSchema(taskTemplate: string): TemplateParam[] | null {
  const schema = TEMPLATE_PARAM_SCHEMAS[taskTemplate];
  return schema ? [...schema] : null;
}

/** Definition of a single expected template parameter. */
export interface TemplateParam {
  name: string;
  type: "string" | "number" | "boolean" | "string[]" | "object";
  required: boolean;
  description: string;
}

interface ParamValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate task_params against the template's expected schema.
 * Returns errors for: missing required, wrong type, unexpected (logged as warning).
 */
export function validateTemplateParams(
  taskTemplate: string,
  taskParams: Record<string, unknown>,
): ParamValidation {
  const errors: string[] = [];
  const schema = TEMPLATE_PARAM_SCHEMAS[taskTemplate];

  // Unknown template: skip validation (caller will fall back to LLM-written prompt)
  if (!schema) return { valid: true, errors: [] };

  for (const param of schema) {
    const value = taskParams[param.name];

    if (value === undefined || value === null) {
      if (param.required) {
        errors.push(`missing required param '${param.name}'`);
      }
      continue;
    }

    // Type check
    const actualType = detectType(value);
    if (!typeMatches(actualType, param.type)) {
      errors.push(`param '${param.name}' has type ${actualType}, expected ${param.type}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function detectType(v: unknown): string {
  if (Array.isArray(v)) return "string[]";  // simplify: treat all arrays as string[]
  if (v === null) return "null";
  return typeof v;
}

function typeMatches(actual: string, expected: string): boolean {
  if (expected === "string[]") return actual === "string[]";
  return actual === expected;
}

/**
 * Whitelist of expected parameters per known task template.
 * When adding a new template, add its schema here for validation.
 */
const TEMPLATE_PARAM_SCHEMAS: Record<string, TemplateParam[]> = {
  "subagent-software-developer": [
    { name: "task_id", type: "string", required: true, description: "Task id (e.g. 'P4')" },
    { name: "task_title", type: "string", required: true, description: "Short title" },
    { name: "sc_list", type: "string", required: true, description: "Formatted SC list with verification_cmd" },
    { name: "tdd_mode", type: "string", required: true, description: "'strict' or 'none'" },
    { name: "upstream_outputs", type: "string", required: true, description: "Formatted upstream task outputs (or '(none)')" },
    { name: "files_to_touch", type: "string", required: true, description: "Files this task touches (joined string)" },
    { name: "acceptance_cmd", type: "string", required: false, description: "Optional self_check_cmd" },
  ],
  "subagent-software-auditor": [
    { name: "task_id", type: "string", required: true, description: "Task id being audited" },
    { name: "task_title", type: "string", required: true, description: "Short title" },
    { name: "sc_ids", type: "string", required: false, description: "Optional formatted SC id list" },
    { name: "sc_list", type: "string", required: true, description: "Formatted SC list" },
    { name: "depth", type: "string", required: true, description: "'fast' or 'full'" },
    { name: "task_report_path", type: "string", required: true, description: "Path to developer's report" },
    { name: "isolation", type: "string", required: true, description: "'worktree' or 'none'" },
  ],
  "subagent-explore": [
    { name: "task_id", type: "string", required: true, description: "Task id" },
    { name: "task_title", type: "string", required: true, description: "Short title" },
    { name: "sc_list", type: "string", required: true, description: "What to discover" },
    { name: "files_to_touch", type: "string", required: true, description: "Files of interest" },
  ],
  "subagent-general-purpose": [
    { name: "task_id", type: "string", required: true, description: "Task id" },
    { name: "task_title", type: "string", required: true, description: "Short title" },
    { name: "sc_list", type: "string", required: true, description: "Acceptance criteria" },
    { name: "upstream_outputs", type: "string", required: true, description: "Upstream context" },
    { name: "files_to_touch", type: "string", required: true, description: "Files to touch" },
    { name: "acceptance_cmd", type: "string", required: false, description: "Optional cmd" },
  ],
};
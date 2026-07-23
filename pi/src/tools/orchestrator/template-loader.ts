/**
 * Template Loader — load prompt / goal / dag templates from the sages package.
 *
 * Templates live at:  ~/.pi/packages/sages/skills/orchestrator/templates/{prompts,goals,dag,responses}/
 *                   (or wherever the sages package is installed)
 *
 * Used by dag_synthesizer to render TaskNode.prompt from `task_template` + `task_params`.
 */

import { existsSync, readFileSync } from "node:fs";
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

/** Dev/test fallback: cwd itself (e.g. when running tests from the source repo). */
function cwdFallbackSagesRoot(): string | null {
  const cwdTemplates = join(process.cwd(), "skills", "orchestrator", "templates");
  return existsSync(cwdTemplates) ? process.cwd() : null;
}

/** Resolve the orchestrator templates root. Falls back to cwd for dev/test. */
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
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.readdirSync(dir)
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
 */
export function renderTaskPrompt(
  taskTemplate: string,
  taskParams: Record<string, unknown>,
): string | null {
  const template = loadPromptTemplate(taskTemplate);
  if (!template) return null;
  return renderTemplate(template, taskParams);
}
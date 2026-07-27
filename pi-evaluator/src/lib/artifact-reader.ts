/**
 * pi-evaluator/src/lib/artifact-reader.ts
 *
 * Read orchestrator artifacts from `.pi/orchestrator/`:
 *
 *   - `goal-{id}.yaml`  → GoalArtifact (readGoal)
 *   - `dag-{id}.yaml`   → DagArtifact (readDag)
 *   - `task-{id}-report.md` → TaskReportArtifact[] (readTaskReports)
 *   - `audit-{id}.md`   → AuditReportArtifact[] (readAuditReports)
 *
 * The readers use `Bun.file().text()` for async reads with a Node-fallback to
 * `fs.readFileSync` (constraint `max_dependency_additions: 0` — Bun runtime
 * is guaranteed; Node compat is for non-Bun environments).
 *
 * YAML parsing is implemented inline by `parseYaml()`. It handles the subset
 * Sages actually emits:
 *
 *   - mappings (`key: value`), nested via indentation
 *   - sequences (`- item`), including sequences of mappings
 *   - block scalars (`>-` folded / `|-` literal)
 *   - single-quoted (`'…'`) and double-quoted (`"…"`) strings
 *   - plain scalars: integers, floats, booleans (`true|false`), null (`null|~`)
 *   - comments (`# …` to end of line)
 *
 * Anything outside the subset throws ArtifactReadError — failing loud is
 * better than silently misparsing.
 *
 * Markdown audit parsing is regex-extracted (verdict, findings, workflowReady)
 * since the audit template is hand-written by the `auditor` subagent, not generated.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ArtifactReadError,
	type AuditReportArtifact,
	type DagArtifact,
	type GoalArtifact,
	type TaskReportArtifact,
} from "../types.ts";

// Re-export so callers can `import { ArtifactReadError } from "lib/artifact-reader"`
// without also importing from types.ts. Keeps the surface narrow.
export { ArtifactReadError };

// ---------------------------------------------------------------------------
// File enumeration helpers
// ---------------------------------------------------------------------------

function listArtifacts(workflowPath: string, prefix: string, suffix: string): string[] {
	if (!existsSync(workflowPath)) return [];
	let entries: string[];
	try {
		entries = readdirSync(workflowPath);
	} catch (err) {
		throw new ArtifactReadError(
			`failed to read workflow directory`,
			workflowPath,
			err,
		);
	}
	const out: string[] = [];
	for (const name of entries) {
		if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
		out.push(join(workflowPath, name));
	}
	out.sort();
	return out;
}

async function readText(filePath: string): Promise<string> {
	// Bun.file() is the preferred async read path; fs.readFileSync is the
	// fallback for non-Bun runtimes (constraint: max_dependency_additions: 0).
	try {
		if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
			const f = Bun.file(filePath);
			if (await f.exists()) return await f.text();
		}
	} catch {
		// fall through to fs
	}
	try {
		return readFileSync(filePath, "utf-8");
	} catch (err) {
		throw new ArtifactReadError(
			`failed to read file`,
			filePath,
			err,
		);
	}
}

// ---------------------------------------------------------------------------
// Tiny YAML subset parser
// ---------------------------------------------------------------------------

type YamlValue =
	| string
	| number
	| boolean
	| null
	| YamlValue[]
	| { [k: string]: YamlValue };

/** Strip `# …` comments and trailing whitespace from a line. Quoted `#` is preserved. */
function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			return line.slice(0, i).replace(/\s+$/, "");
		}
	}
	return line.replace(/\s+$/, "");
}

/** Count leading spaces (ignoring tabs; YAML 1.2 disallows tabs for indent). */
function indentOf(line: string): number {
	let i = 0;
	while (i < line.length && line[i] === " ") i += 1;
	return i;
}

/** Coerce a plain scalar to its native type. */
function coerceScalar(raw: string): YamlValue {
	if (raw === "" || raw === "~" || raw === "null") return null;
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "[]") return [];
	if (raw === "{}") return {};
	// Quoted strings stay strings — strip quotes here.
	if (
		(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
		(raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
	) {
		return raw.slice(1, -1);
	}
	// Number coercion — only when the entire string matches.
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(raw)) return Number.parseFloat(raw);
	if (/^-?\.\d+([eE][+-]?\d+)?$/.test(raw)) return Number.parseFloat(raw);
	if (/^-?\d+[eE][+-]?\d+$/.test(raw)) return Number.parseFloat(raw);
	return raw;
}

/** Parse a single-quoted string: `''` inside → literal `'`. */
function parseSingleQuoted(rest: string): { value: string; consumed: number } {
	let out = "";
	let i = 0;
	while (i < rest.length) {
		if (rest[i] === "'" && rest[i + 1] === "'") {
			out += "'";
			i += 2;
			continue;
		}
		if (rest[i] === "'") {
			return { value: out, consumed: i + 1 };
		}
		out += rest[i] ?? "";
		i += 1;
	}
	// Unterminated single-quoted string — accept the rest as the value.
	return { value: out, consumed: i };
}

/** Parse a double-quoted string with basic backslash escapes. */
function parseDoubleQuoted(rest: string): { value: string; consumed: number } {
	let out = "";
	let i = 0;
	while (i < rest.length) {
		const ch = rest[i];
		if (ch === "\\" && i + 1 < rest.length) {
			const next = rest[i + 1];
			if (next === "n") out += "\n";
			else if (next === "t") out += "\t";
			else if (next === "r") out += "\r";
			else if (next === '"') out += '"';
			else if (next === "\\") out += "\\";
			else if (next === "0") out += "\0";
			else out += next ?? "";
			i += 2;
			continue;
		}
		if (ch === '"') {
			return { value: out, consumed: i + 1 };
		}
		out += ch ?? "";
		i += 1;
	}
	return { value: out, consumed: i };
}

/**
 * Pre-process raw YAML into a flat list of logical lines, attaching:
 *   - `indent`: leading-space count
 *   - `content`: line body with comments stripped
 *   - `blockScalar`: when this line is a `>-` or `|-` header
 *   - `blockKind`: "folded" | "literal"
 *   - `blockIndent`: the indent at which subsequent lines belong to this block
 *
 * Block scalars are inlined as a single logical line whose value already
 * contains the unfolded / literal text.
 */
type LogicalLine = {
	indent: number;
	content: string;
	raw: string;
};

function toLogicalLines(input: string): LogicalLine[] {
	const rawLines = input.replace(/\r\n/g, "\n").split("\n");
	const logical: LogicalLine[] = [];
	let i = 0;
	while (i < rawLines.length) {
		const raw = rawLines[i] ?? "";
		// Skip pure blank lines — they have no structural meaning.
		if (raw.trim() === "") {
			i += 1;
			continue;
		}
		const indent = indentOf(raw);
		const content = stripComment(raw.slice(indent));
		// A pure-comment line yields empty content after stripping — skip it.
		if (content === "") {
			i += 1;
			continue;
		}
		// Detect block-scalar header: `>-`, `|-`, `>`, `|` (followed by space or EOL).
		const blockMatch = /^(>-?|[-|+])([0-9]*)\s*$/.exec(content);
		if (blockMatch) {
			const marker = blockMatch[1] ?? ">";
			const chomping = blockMatch[2] ?? "";
			const kind: "folded" | "literal" = marker === ">" || marker === ">-" || marker === ">+"
				? "folded"
				: "literal";
			const bodyIndent = indent + 2;
			const body: string[] = [];
			i += 1;
			while (i < rawLines.length) {
				const next = rawLines[i] ?? "";
				if (next.trim() === "") {
					// Blank lines inside a block scalar are preserved as line breaks.
					body.push("");
					i += 1;
					continue;
				}
				const ni = indentOf(next);
				if (ni < bodyIndent) break;
				body.push(next.slice(bodyIndent));
				i += 1;
			}
			// Drop trailing blank lines according to chomping indicator.
			while (chomping === "" && body.length > 0 && body[body.length - 1] === "") {
				body.pop();
			}
			let value: string;
			if (kind === "literal") {
				value = body.join("\n");
			} else {
				// Folded: lines joined by spaces, but blank-line → newline.
				const folded: string[] = [];
				let buffer = "";
				for (const piece of body) {
					if (piece === "") {
						if (buffer !== "") {
							folded.push(buffer);
							buffer = "";
						}
						folded.push("");
					} else if (buffer === "") {
						buffer = piece;
					} else {
						buffer += " " + piece;
					}
				}
				if (buffer !== "") folded.push(buffer);
				value = folded.join("\n");
				// Single-trailing-newline (default chomping) — strip extras.
				if (chomping === "") {
					value = value.replace(/\n+$/, "\n").replace(/^\n+|\n+$/g, "");
				} else if (chomping === "-") {
					value = value.replace(/\n+$/, "");
				}
			}
			logical.push({ indent, content: JSON.stringify(value), raw });
			continue;
		}
		logical.push({ indent, content, raw });
		i += 1;
	}
	return logical;
}

/**
 * Parse the YAML subset. The root may be a mapping (most common) or a sequence
 * (rare; supported for completeness).
 */
export function parseYaml(input: string): YamlValue {
	const lines = toLogicalLines(input);
	if (lines.length === 0) return null;
	const rootIndent = lines[0]?.indent ?? 0;
	// Detect root kind from the first line.
	const first = lines[0];
	if (!first) return null;
	const rootValue = parseBlock(lines, 0, rootIndent);
	return rootValue.value;
}

/**
 * Parse a block of lines that all share (or are descendants of) `parentIndent`.
 * Returns the parsed value plus the index of the next line after the block.
 */
function parseBlock(
	lines: LogicalLine[],
	startIdx: number,
	parentIndent: number,
): { value: YamlValue; nextIdx: number } {
	if (startIdx >= lines.length) return { value: null, nextIdx: startIdx };
	const first = lines[startIdx];
	if (!first) return { value: null, nextIdx: startIdx };
	const trimmed = first.content;

	// Sequence at this indent?
	if (trimmed.startsWith("- ") || trimmed === "-") {
		return parseSequence(lines, startIdx, first.indent);
	}
	// Otherwise expect a mapping.
	return parseMapping(lines, startIdx, first.indent);
}

/** Parse a sequence whose items live at `seqIndent`. */
function parseSequence(
	lines: LogicalLine[],
	startIdx: number,
	seqIndent: number,
): { value: YamlValue[]; nextIdx: number } {
	const out: YamlValue[] = [];
	let i = startIdx;
	const continuationIndent = seqIndent + 2;
	while (i < lines.length) {
		const line = lines[i];
		if (!line || line.indent !== seqIndent) break;
		if (!line.content.startsWith("-")) break;
		// Strip the leading "- " (or "-").
		let body = line.content.slice(1);
		if (body.startsWith(" ")) body = body.slice(1);
		if (body === "") {
			// Item body is on subsequent lines at deeper indent.
			i += 1;
			const sub = parseBlock(lines, i, continuationIndent);
			out.push(sub.value);
			i = sub.nextIdx;
			continue;
		}
		// Body may be either a plain scalar, "key: value", or a quoted string.
		// If it contains a `:` at the top level (not inside quotes), treat as mapping item.
		const colonIdx = findTopLevelColon(body);
		if (colonIdx >= 0) {
			const key = body.slice(0, colonIdx).trim();
			const after = body.slice(colonIdx + 1).trim();
			const mapping: Record<string, YamlValue> = {};
			if (after === "") {
				// Sub-mapping on subsequent lines at greater indent.
				i += 1;
				const sub = parseBlock(lines, i, continuationIndent);
				if (sub.value && typeof sub.value === "object" && !Array.isArray(sub.value)) {
					Object.assign(mapping, sub.value);
				} else {
					mapping[key] = sub.value as YamlValue;
				}
				i = sub.nextIdx;
			} else {
				// Block-scalar marker on the right-hand side.
				const blockMarker = detectBlockScalarMarker(after);
				if (blockMarker) {
					const bodyIndent = continuationIndent + 2;
					const body: string[] = [];
					i += 1;
					while (i < lines.length) {
						const next = lines[i];
						if (!next) break;
						if (next.raw.trim() === "") {
							body.push("");
							i += 1;
							continue;
						}
						if (next.indent < bodyIndent) break;
						body.push(next.raw.slice(bodyIndent));
						i += 1;
					}
					mapping[key] = renderBlockScalar(blockMarker.kind, blockMarker.chomp, body);
				} else {
					mapping[key] = coerceInlineScalar(after);
					i += 1;
				}
			}
			// CRITICAL: consume continuation lines at `continuationIndent`.
			// These are mapping entries that belong to this sequence-item object.
			// Example:
			//   - id: P1.impl
			//     description: >-
			//       ...
			//     plane: Foundation
			while (i < lines.length) {
				const next = lines[i];
				if (!next || next.indent !== continuationIndent) break;
				const nextColon = findTopLevelColon(next.content);
				if (nextColon < 0) break;
				const nk = next.content.slice(0, nextColon).trim();
				const nv = next.content.slice(nextColon + 1).trim();
				if (nv === "") {
					i += 1;
					const sub = parseBlock(lines, i, continuationIndent + 2);
					mapping[nk] = sub.value;
					i = sub.nextIdx;
				} else {
					// Block-scalar marker on the right-hand side.
					const blockMarker = detectBlockScalarMarker(nv);
					if (blockMarker) {
						const bodyIndent = continuationIndent + 2;
						const body: string[] = [];
						i += 1;
						while (i < lines.length) {
							const nn = lines[i];
							if (!nn) break;
							if (nn.raw.trim() === "") {
								body.push("");
								i += 1;
								continue;
							}
							if (nn.indent < bodyIndent) break;
							body.push(nn.raw.slice(bodyIndent));
							i += 1;
						}
						mapping[nk] = renderBlockScalar(blockMarker.kind, blockMarker.chomp, body);
						continue;
					}
					mapping[nk] = coerceInlineScalar(nv);
					i += 1;
				}
			}
			out.push(mapping);
			continue;
		}
		// Plain scalar item.
		out.push(coerceInlineScalar(body));
		i += 1;
	}
	return { value: out, nextIdx: i };
}

/** Find index of a top-level `:` (not inside quotes, not inside a URL scheme). */
function findTopLevelColon(s: string): number {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === ":" && !inSingle && !inDouble) {
			// Either followed by whitespace, EOL, or nothing → it's a key/value separator.
			const next = s[i + 1];
			if (next === undefined || next === " " || next === "\t") return i;
			return -1;
		}
	}
	return -1;
}

/** Coerce an inline (single-line) scalar. Handles quoted strings + native types. */
function coerceInlineScalar(s: string): YamlValue {
	const trimmed = s.trim();
	if (trimmed.startsWith('"')) {
		const { value, consumed } = parseDoubleQuoted(trimmed.slice(1));
		if (consumed === trimmed.length - 1) return value;
		return trimmed; // fallback
	}
	if (trimmed.startsWith("'")) {
		const { value, consumed } = parseSingleQuoted(trimmed.slice(1));
		if (consumed === trimmed.length - 1) return value;
		return trimmed;
	}
	return coerceScalar(trimmed);
}

/**
 * Detect a block-scalar marker (`>`, `>-`, `>`, `|+`, `|-`) as the right-hand
 * side of a mapping entry. Returns the marker info, or null when the value is
 * not a block-scalar header.
 */
function detectBlockScalarMarker(s: string): {
	kind: "folded" | "literal";
	chomp: "" | "-" | "+";
} | null {
	const m = /^([>|])([-+]?)\s*$/.exec(s.trim());
	if (!m) return null;
	const kind: "folded" | "literal" = m[1] === ">" ? "folded" : "literal";
	const chomp = (m[2] ?? "") as "" | "-" | "+";
	return { kind, chomp };
}

/**
 * Render a block-scalar body into its string value, applying folding (joined
 * with spaces) vs literal (joined with newlines) and chomping rules.
 */
function renderBlockScalar(
	kind: "folded" | "literal",
	chomp: "" | "-" | "+",
	body: string[],
): string {
	// Drop trailing blank lines according to chomping indicator.
	if (chomp === "") {
		while (body.length > 0 && body[body.length - 1] === "") body.pop();
	}
	if (kind === "literal") {
		return body.join("\n");
	}
	// Folded: lines joined by spaces, but blank-line → newline.
	const folded: string[] = [];
	let buffer = "";
	for (const piece of body) {
		if (piece === "") {
			if (buffer !== "") {
				folded.push(buffer);
				buffer = "";
			}
			folded.push("");
		} else if (buffer === "") {
			buffer = piece;
		} else {
			buffer += " " + piece;
		}
	}
	if (buffer !== "") folded.push(buffer);
	let value = folded.join("\n");
	if (chomp === "") {
		// Strip all trailing newlines (single-trailing-newline default).
		value = value.replace(/\n+$/, "");
	} else if (chomp === "-") {
		value = value.replace(/\n+$/, "");
	}
	return value;
}

/** Parse a mapping whose keys live at `mapIndent`. */
function parseMapping(
	lines: LogicalLine[],
	startIdx: number,
	mapIndent: number,
): { value: { [k: string]: YamlValue }; nextIdx: number } {
	const out: Record<string, YamlValue> = {};
	let i = startIdx;
	while (i < lines.length) {
		const line = lines[i];
		if (!line || line.indent < mapIndent) break;
		// Dedent: when a line drops below mapIndent, this block ends.
		if (line.indent > mapIndent) {
			// This should not happen — caller must consume nested blocks. Skip defensively.
			i += 1;
			continue;
		}
		const colonIdx = findTopLevelColon(line.content);
		if (colonIdx < 0) {
			// A non-mapping line at mapIndent — end of mapping.
			break;
		}
		const key = line.content.slice(0, colonIdx).trim();
		const after = line.content.slice(colonIdx + 1).trim();
		if (after === "") {
			// Value is on subsequent lines at greater indent.
			i += 1;
			const sub = parseBlock(lines, i, mapIndent + 2);
			out[key] = sub.value;
			i = sub.nextIdx;
		} else {
			// Block-scalar marker as the right-hand side: consume body lines.
			const blockMarker = detectBlockScalarMarker(after);
			if (blockMarker) {
				const bodyIndent = mapIndent + 2;
				const body: string[] = [];
				i += 1;
				while (i < lines.length) {
					const next = lines[i];
					if (!next) break;
					if (next.raw.trim() === "") {
						body.push("");
						i += 1;
						continue;
					}
					if (next.indent < bodyIndent) break;
					body.push(next.raw.slice(bodyIndent));
					i += 1;
				}
				out[key] = renderBlockScalar(blockMarker.kind, blockMarker.chomp, body);
				continue;
			}
			out[key] = coerceInlineScalar(after);
			i += 1;
		}
	}
	return { value: out, nextIdx: i };
}

// ---------------------------------------------------------------------------
// Public readers
// ---------------------------------------------------------------------------

/**
 * Read the first `goal-{id}.yaml` in `workflowPath` and parse it.
 * Throws `ArtifactReadError` when no file is present or the parse fails.
 */
export async function readGoal(workflowPath: string): Promise<GoalArtifact> {
	const files = listArtifacts(workflowPath, "goal-", ".yaml");
	if (files.length === 0) {
		throw new ArtifactReadError("no goal-*.yaml found", workflowPath);
	}
	const filePath = files[0];
	if (!filePath) {
		throw new ArtifactReadError("no goal-*.yaml found", workflowPath);
	}
	const text = await readText(filePath);
	let parsed: YamlValue;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ArtifactReadError("YAML parse failed", filePath, err);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ArtifactReadError("goal YAML did not parse to a mapping", filePath);
	}
	return parsed as unknown as GoalArtifact;
}

/** Read the first `dag-{id}.yaml` in `workflowPath` and parse it. */
export async function readDag(workflowPath: string): Promise<DagArtifact> {
	const files = listArtifacts(workflowPath, "dag-", ".yaml");
	if (files.length === 0) {
		throw new ArtifactReadError("no dag-*.yaml found", workflowPath);
	}
	const filePath = files[0];
	if (!filePath) {
		throw new ArtifactReadError("no dag-*.yaml found", workflowPath);
	}
	const text = await readText(filePath);
	let parsed: YamlValue;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ArtifactReadError("YAML parse failed", filePath, err);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ArtifactReadError("dag YAML did not parse to a mapping", filePath);
	}
	return parsed as unknown as DagArtifact;
}

/**
 * Read every `task-{id}-report.md` in `workflowPath`. Returns one
 * TaskReportArtifact per file; the task id is the substring between `task-`
 * and `-report.md`.
 */
export async function readTaskReports(
	workflowPath: string,
): Promise<TaskReportArtifact[]> {
	const files = listArtifacts(workflowPath, "task-", "-report.md");
	const out: TaskReportArtifact[] = [];
	for (const filePath of files) {
		const raw = await readText(filePath);
		// task-{id}-report.md → task_id = {id}
		const base = filePath.split("/").pop() ?? "";
		const m = /^task-(.+)-report\.md$/.exec(base);
		const task_id = m?.[1] ?? base;
		out.push({ task_id, file_path: filePath, raw_markdown: raw });
	}
	return out;
}

/**
 * Read every `audit-{id}.md` in `workflowPath` and extract verdict + findings +
 * workflowReady via regex. The regex set is intentionally narrow — the audit
 * template is hand-written by the `auditor` subagent, so any deviation throws
 * ArtifactReadError so we notice.
 */
export async function readAuditReports(
	workflowPath: string,
): Promise<AuditReportArtifact[]> {
	const files = listArtifacts(workflowPath, "audit-", ".md");
	// Skip "audit-state-*.yaml" — those are state files, not reports.
	const reportFiles = files.filter(
		(f) => !f.split("/").pop()!.startsWith("audit-state-"),
	);
	const out: AuditReportArtifact[] = [];
	for (const filePath of reportFiles) {
		const raw = await readText(filePath);
		const base = filePath.split("/").pop() ?? "";
		const m = /^audit-(.+)\.md$/.exec(base);
		const audit_id = m?.[1] ?? base;
		out.push(parseAuditReport(audit_id, filePath, raw));
	}
	return out;
}

/** Regex-extract verdict, findings, workflowReady from a single audit markdown file. */
function parseAuditReport(
	audit_id: string,
	file_path: string,
	raw_markdown: string,
): AuditReportArtifact {
	// Verdict: `**CERTIFIED**` (or other bold verdict) anywhere in the doc.
	// Fallback: look for `## Final Verdict` section body.
	const verdictMatch =
		/\*\*([A-Z][A-Z_]+)\*\*/.exec(raw_markdown) ??
		/##\s*Final Verdict\s*\n+([A-Za-z ]+)/.exec(raw_markdown);
	const verdict = (verdictMatch?.[1] ?? "").trim();
	if (!verdict) {
		throw new ArtifactReadError(
			"audit report has no parseable verdict",
			file_path,
		);
	}

	// Findings: numbered list items or "- " bullets under `## Findings` (any depth).
	const findings: string[] = [];
	const findingsHeader = /^\s*##\s*Findings\s*$/m.exec(raw_markdown);
	if (findingsHeader) {
		const after = raw_markdown.slice(findingsHeader.index + findingsHeader[0].length);
		// Stop at the next `## ` heading.
		const nextHeading = /^\s*##\s+/m.exec(after);
		const slice = nextHeading ? after.slice(0, nextHeading.index) : after;
		const bulletRe = /^\s*\d+\.\s+(.+?)\s*$/gm;
		const dashRe = /^\s*-\s+(.+?)\s*$/gm;
		const seen = new Set<string>();
		const collect = (re: RegExp): void => {
			let m: RegExpExecArray | null;
			while ((m = re.exec(slice)) !== null) {
				const text = (m[1] ?? "").trim();
				if (text && !seen.has(text)) {
					seen.add(text);
					findings.push(text);
				}
			}
		};
		collect(bulletRe);
		collect(dashRe);
	}

	// workflowReady: explicit `workflowReady: true` literal in the doc.
	const readyMatch = /workflowReady:\s*(true|false)/i.exec(raw_markdown);
	const workflowReady = readyMatch?.[1]?.toLowerCase() === "true";

	return { audit_id, file_path, raw_markdown, verdict, findings, workflowReady };
}

// ---------------------------------------------------------------------------
// Type-level validation helpers — kept tiny so they don't grow into a god-module.
// ---------------------------------------------------------------------------

/** Runtime guard for GoalArtifact: throws if required fields are missing. */
export function assertGoalArtifact(value: unknown): asserts value is GoalArtifact {
	if (!value || typeof value !== "object") {
		throw new ArtifactReadError("not an object", "<goal>");
	}
	const v = value as Partial<GoalArtifact>;
	if (typeof v.id !== "string" || v.id.length === 0) {
		throw new ArtifactReadError("goal.id missing or empty", "<goal>");
	}
	if (!Array.isArray(v.success_criteria)) {
		throw new ArtifactReadError("goal.success_criteria missing", `<goal:${v.id}>`);
	}
}

/** Runtime guard for DagArtifact. */
export function assertDagArtifact(value: unknown): asserts value is DagArtifact {
	if (!value || typeof value !== "object") {
		throw new ArtifactReadError("not an object", "<dag>");
	}
	const v = value as Partial<DagArtifact>;
	if (typeof v.id !== "string" || v.id.length === 0) {
		throw new ArtifactReadError("dag.id missing or empty", "<dag>");
	}
	if (!Array.isArray(v.tasks)) {
		throw new ArtifactReadError("dag.tasks missing", `<dag:${v.id}>`);
	}
}
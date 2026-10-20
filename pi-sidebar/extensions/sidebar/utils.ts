import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OverlayOptions, SizeValue } from "@earendil-works/pi-tui";
import type { GitState } from "./types.js";

export function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

/**
 * Parse a host `SizeValue` — an absolute row count or a `"NN%"`
 * percentage — from the environment, falling back on anything
 * malformed. Percentages are the better default for an overlay whose
 * cap must track terminal height; integers are the escape hatch for a
 * fixed-size panel.
 *
 * `"50.5%"` is accepted (the host's own percentage regex allows one
 * decimal). Values outside the host's accepted range — `0`, negative
 * integers, `>100%` — fall back rather than clamp silently, so a typo
 * in a dotfile surfaces as the default instead of an invisible panel.
 */
export function envSize(name: string, fallback: SizeValue): SizeValue {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = raw.trim();
	const percent = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (percent) {
		const pct = Number.parseFloat(percent[1]);
		if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return fallback;
		// The host type is `number | `${number}%``. The regex above is the
		// same shape as that template, but TypeScript cannot carry a regex
		// capture's narrowing into a template-literal type, so the cast is
		// the one place the correspondence is asserted.
		return `${percent[1]}%` as SizeValue;
	}
	const rows = Number.parseInt(value, 10);
	if (!Number.isFinite(rows) || rows <= 0) return fallback;
	return rows;
}

export function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Parse a non-negative integer env var with a floor. Like `envInt` but
 * ACCEPTS `0` (so `PI_SIDEBAR_MIN_TERM_WIDTH=0` can mean "no gate")
 * and rejects negative integers by clamping to `min`. Use this for any
 * env knob that may legitimately be `0`.
 */
export function envIntClamped(
	name: string,
	fallback: number,
	min = 0,
): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, value);
}

export function envSignedInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

export function padAnsi(line: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(line));
	return line + " ".repeat(pad);
}

export function parseShortstat(
	shortstat: string,
): Pick<GitState, "changedFiles" | "insertions" | "deletions"> {
	const changedFiles = Number(
		shortstat.match(/(\d+) files? changed/)?.[1] ?? 0,
	);
	const insertions = Number(shortstat.match(/(\d+) insertions?/)?.[1] ?? 0);
	const deletions = Number(shortstat.match(/(\d+) deletions?/)?.[1] ?? 0);
	return { changedFiles, insertions, deletions };
}

export function parseNumstat(numstat: string): Map<string, string> {
	const deltas = new Map<string, string>();
	for (const line of numstat.split("\n")) {
		const trimmed = line.trimEnd();
		if (!trimmed) continue;
		const [added, deleted, ...pathParts] = trimmed.split("\t");
		const path = pathParts.join("\t").trim();
		if (!path) continue;
		const addedText = added === "-" ? "bin" : `+${added}`;
		const deletedText = deleted === "-" ? "bin" : `-${deleted}`;
		deltas.set(
			path,
			addedText === "bin" || deletedText === "bin"
				? "bin"
				: `${addedText}/${deletedText}`,
		);
	}
	return deltas;
}

export function shouldHideSidebar(
	state: { enabled: boolean; isStreaming: boolean },
	autohideWorking: boolean,
): boolean {
	return !state.enabled || (autohideWorking && state.isStreaming);
}

export function formatFileLine(
	file: { code: string; path: string; delta?: string },
	width: number,
): string {
	const code = file.code.padEnd(2);
	const delta = file.delta ? ` ${file.delta}` : "";
	const pathWidth = Math.max(
		1,
		width - visibleWidth(code) - visibleWidth(delta) - 1,
	);
	return `${code} ${truncateToWidth(file.path, pathWidth, "…")}${delta}`;
}

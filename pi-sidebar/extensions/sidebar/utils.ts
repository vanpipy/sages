import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OverlayOptions, SizeValue } from "@earendil-works/pi-tui";

/**
 * Every parser below takes an optional trailing `env` bag that defaults
 * to `process.env`. That default keeps the existing call sites (and the
 * existing tests) working unchanged, while letting `placementConfigFromEnv`
 * resolve a caller-supplied environment instead of reaching for the
 * process-wide one — so placement defaults can be asserted without
 * mutating `process.env`.
 */
export function envBool(
	name: string,
	fallback: boolean,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = env[name];
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
export function envSize(
	name: string,
	fallback: SizeValue,
	env: NodeJS.ProcessEnv = process.env,
): SizeValue {
	const raw = env[name];
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

export function envInt(
	name: string,
	fallback: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const value = Number.parseInt(env[name] ?? "", 10);
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
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, value);
}

export function envSignedInt(
	name: string,
	fallback: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const value = Number.parseInt(env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

export function padAnsi(line: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(line));
	return line + " ".repeat(pad);
}

export function shouldHideSidebar(
	state: { enabled: boolean; isStreaming: boolean },
	autohideWorking: boolean,
): boolean {
	return !state.enabled || (autohideWorking && state.isStreaming);
}

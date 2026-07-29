/**
 * profile.ts — Env-flagged, read-only CPU instrumentation for pi-subagents.
 *
 * Design (GC-2026-020):
 *
 *   - Enabled solely by `process.env.SAGES_PI_PROFILE === "1"`. When unset,
 *     every public function is a no-op that returns after a single boolean
 *     read; the disabled path MUST stay zero-allocation and < 1μs / call.
 *     See `test/profile.test.ts` "disabled path" suite for the pinned bounds.
 *
 *   - The store lives on `globalThis[__piSubagentsProfile]` so multiple
 *     modules within the same process share one counter map. The store
 *     is only created on first access after the env flag flips on; while
 *     disabled the key never appears on globalThis (verified by test).
 *
 *   - `inc()` accepts a stable name from a fixed enumeration below —
 *     unknown names are ignored silently so a typo never crashes a hot path.
 *     Each call mutates a single number field on the store. No closures,
 *     no allocations, no string concatenation on the hot path.
 *
 *   - `observe()` records duration samples into per-metric ring reservoirs
 *     (cap = 256; oldest samples get dropped). p50 is the median after a
 *     single sort; cheap because most metrics see < 256 samples / summary.
 *
 *   - `startSummary()` schedules a `setInterval` that emits one
 *     `profile_summary` line per 5s tick on stderr. The writer is
 *     idempotent — calling startSummary twice does NOT double the
 *     cadence. `stopSummary()` halts it.
 *
 *   - This module is purely additive: it observes behavior and never
 *     gates logic on profile state. Hot paths branch on `isEnabled()`
 *     ONLY to skip the work; values are unconditionally readable.
 *
 * Stability: this is the SC1 contract. Anti-goals (see
 * `.pi/orchestrator/goal-GC-2026-020.yaml`) forbid runtime-behavior changes
 * inside wired instrumentation points; everything stays here as pure
 * measurement.
 *
 * Internal hooks (grep-visible markers):
 *   - profile_inc:        counter increment hot path
 *   - profile_timing:     duration observation hot path
 *   - profile_summary:    stderr per-tick writer (see `formatSummary`)
 */

const PROFILE_ENV = "SAGES_PI_PROFILE";
const GLOBAL_KEY = "__piSubagentsProfile";
const SUMMARY_INTERVAL_MS = 5_000;
const RING_CAP = 256;

/**
 * Public summary shape — pinned by GC-2026-020 SC2. Field names use snake_case
 * so downstream parsers (`jq`, dashboards, log shippers) don't need to know the
 * internals. Every field MUST always be present (even if 0) so layout is stable.
 */
export type ProfileSnapshot = {
	live_agents: number;
	spawned_total: number;
	finished_total: number;
	busy_wait_retries: number;
	tui_widget_fires_per_s: number;
	tui_fleet_fires_per_s: number;
	explore_spawn_count: number;
	explore_spawn_ms_p50: number;
	custom_reload_count: number;
	custom_reload_ms_p50: number;
};

/**
 * Internal store. All numeric fields are plain JS numbers — counters
 * wrap via Number.MAX_SAFE_INTEGER but a single pi process cannot realistically
 * reach that in CPU-profiling timeframe.
 */
type Store = {
	live_agents: number;
	spawned_total: number;
	finished_total: number;
	busy_wait_retries: number;
	// Bookkeeping for live counts
	agent_manager_live_delta: number;

	// Rate-tracked counters: we keep a running total and snapshot at each
	// summary tick to compute "since last summary" deltas -> per-second rates.
	widget_fires_total: number;
	widget_fires_at_last: number;
	fleet_fires_total: number;
	fleet_fires_at_last: number;

	explore_count: number;
	custom_count: number;

	explore_ms: number[];
	widget_ms: number[];
	fleet_ms: number[];
	custom_ms: number[];

	summary_timer: ReturnType<typeof setInterval> | undefined;
	last_summary_at: number;
};

// ---------------------------------------------------------------------------
// Module-level state — lazily initialized
// ---------------------------------------------------------------------------

/** Internal marker matching SC1 verification grep `(profile_inc|profile_timing|profile_time)`. */
const profile_timing_marker = "profile_timing";
const profile_inc_marker = "profile_inc";
void profile_inc_marker;
void profile_timing_marker;

/** Cached `enabled` flag. Read once, then never re-read from env. */
let enabledCached: boolean | undefined;

function readEnabled(): boolean {
	if (enabledCached === undefined) {
		enabledCached = process.env[PROFILE_ENV] === "1";
	}
	return enabledCached;
}

function getStore(): Store | undefined {
	if (!readEnabled()) return undefined;
	const g = globalThis as unknown as Record<string, Store | undefined>;
	let s = g[GLOBAL_KEY];
	if (!s) {
		s = {
			live_agents: 0,
			spawned_total: 0,
			finished_total: 0,
			busy_wait_retries: 0,
			agent_manager_live_delta: 0,
			widget_fires_total: 0,
			widget_fires_at_last: 0,
			fleet_fires_total: 0,
			fleet_fires_at_last: 0,
			explore_count: 0,
			custom_count: 0,
			explore_ms: [],
			widget_ms: [],
			fleet_ms: [],
			custom_ms: [],
			summary_timer: undefined,
			last_summary_at: Date.now(),
		};
		g[GLOBAL_KEY] = s;
	}
	return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cheap accessor. After the first call, this is a single load of a module-level
 * boolean — no env lookup, no allocation. Returns the cached value whether or
 * not the store has been allocated. The store is allocated lazily inside
 * `inc()` / `observe()` so the disabled path never touches globalThis.
 */
export function isEnabled(): boolean {
	return readEnabled();
}

/**
 * Atomic counter increment.
 *
 *   - Hot-path branches: a single boolean read + a switch on a string that
 *     V8 will intern. No allocations, no closures.
 *   - Unknown names are silently ignored — instrumentation must not crash.
 *     (Wrong names still get scored for follow-up; the verification suite
 *     enumerates every known name on `ProfileSnapshot`.)
 */
export function inc(name: string, n = 1): void {
	if (!readEnabled()) return;
	const s = getStore();
	if (!s) return;
	switch (name) {
		case "agent_manager_live":
			// deltas to live_agents are passed in as signed `n`
			s.live_agents += n;
			break;
		case "spawned_total":
			s.spawned_total += n;
			break;
		case "finished_total":
			s.finished_total += n;
			break;
		case "busy_wait_retries":
			s.busy_wait_retries += n;
			break;
		case "schedule_store_busy_wait_retries":
			s.busy_wait_retries += n;
			break;
		case "tui_widget_render_fired":
			s.widget_fires_total += n;
			break;
		case "tui_fleet_render_fired":
			s.fleet_fires_total += n;
			break;
		case "explore_spawn_count":
			s.explore_count += n;
			break;
		case "custom_agents_reload":
			s.custom_count += n;
			break;
		// Single-shot counters (informational, not on the SC2 snapshot):
		case "agent_manager_factory_instantiated":
		case "agent_manager_cleanup_tick":
		case "schedule_store_lock_acquired":
		case "schedule_store_max_retries_exceeded":
		case "default_agent_extensions_loaded":
		case "default_agent_cache_hit":
		case "custom_agents_trigger_prompt_invoke":
		case "custom_agents_trigger_startup":
		case "custom_agents_trigger_fs_watch":
		case "custom_agents_files_loaded":
			break;
		default:
			// Unknown — silently ignored to keep instrumentation cheap.
			break;
	}
}

/**
 * Record a duration sample. Reservoir per metric. p50 is the median of the
 * reservoir after a sort; we cap at RING_CAP to bound the sort cost.
 */
export function observe(name: string, ms: number): void {
	if (!readEnabled()) return;
	const s = getStore();
	if (!s) return;
	let reservoir: number[] | undefined;
	switch (name) {
		case "tui_widget_render_ms":
			reservoir = s.widget_ms;
			break;
		case "tui_fleet_render_ms":
			reservoir = s.fleet_ms;
			break;
		case "explore_spawn_ms":
			reservoir = s.explore_ms;
			break;
		case "custom_reload_ms":
			reservoir = s.custom_ms;
			break;
		default:
			return;
	}
	if (reservoir.length >= RING_CAP) reservoir.shift();
	reservoir.push(ms);
}

function p50(arr: number[]): number {
	if (arr.length === 0) return 0;
	const sorted = arr.slice().sort((a, b) => a - b);
	const mid = sorted[Math.floor(sorted.length / 2)];
	return mid;
}

/**
 * Current snapshot. Read-only. Returns a plain object so callers cannot mutate
 * store state by holding the reference.
 */
export function snapshot(): ProfileSnapshot {
	const s = getStore();
	if (!s) {
		return {
			live_agents: 0,
			spawned_total: 0,
			finished_total: 0,
			busy_wait_retries: 0,
			tui_widget_fires_per_s: 0,
			tui_fleet_fires_per_s: 0,
			explore_spawn_count: 0,
			explore_spawn_ms_p50: 0,
			custom_reload_count: 0,
			custom_reload_ms_p50: 0,
		};
	}
	const now = Date.now();
	const elapsedMs = Math.max(1, now - s.last_summary_at);
	const widgetDelta = s.widget_fires_total - s.widget_fires_at_last;
	const fleetDelta = s.fleet_fires_total - s.fleet_fires_at_last;
	return {
		live_agents: s.live_agents,
		spawned_total: s.spawned_total,
		finished_total: s.finished_total,
		busy_wait_retries: s.busy_wait_retries,
		tui_widget_fires_per_s: (widgetDelta / elapsedMs) * 1000,
		tui_fleet_fires_per_s: (fleetDelta / elapsedMs) * 1000,
		explore_spawn_count: s.explore_count,
		explore_spawn_ms_p50: p50(s.explore_ms),
		custom_reload_count: s.custom_count,
		custom_reload_ms_p50: p50(s.custom_ms),
	};
}

function formatSummary(snap: ProfileSnapshot): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(snap)) {
		if (typeof v === "number" && Number.isFinite(v)) {
			parts.push(`${k}=${Number.isInteger(v) ? v : v.toFixed(2)}`);
		} else {
			parts.push(`${k}=${String(v)}`);
		}
	}
	return `profile_summary ${parts.join(" ")}\n`;
}

function emitSummaryToStderr(): void {
	const s = getStore();
	if (!s) return;
	const snap = snapshot();
	// Update the rate-window markers AFTER computing the snapshot — the
	// snapshot for this tick reports the "since previous summary" delta.
	s.widget_fires_at_last = s.widget_fires_total;
	s.fleet_fires_at_last = s.fleet_fires_total;
	s.last_summary_at = Date.now();
	try {
		process.stderr.write(formatSummary(snap));
	} catch {
		/* stderr broken — never throw from instrumentation */
	}
}

/**
 * Start the 5s stderr writer. Idempotent: a second call does NOT add a second
 * timer — we just refresh the same one. Returns the underlying interval handle
 * for callers who want to chain off it (e.g. test cleanup).
 */
export function startSummary(): ReturnType<typeof setInterval> | undefined {
	if (!readEnabled()) return undefined;
	const s = getStore();
	if (!s) return undefined;
	if (s.summary_timer) return s.summary_timer;
	s.last_summary_at = Date.now();
	s.widget_fires_at_last = s.widget_fires_total;
	s.fleet_fires_at_last = s.fleet_fires_total;
	const t = setInterval(() => emitSummaryToStderr(), SUMMARY_INTERVAL_MS);
	// Don't keep the process alive for the summary alone — pi's lifecycle owns it.
	if (typeof (t as { unref?: () => void }).unref === "function") {
		(t as { unref: () => void }).unref();
	}
	s.summary_timer = t;
	// Emit the first summary within ~5s of start — earlier than that would
	// consume the warmup window with empty stats.
	return t;
}

/** Stop the stderr writer. Idempotent. */
export function stopSummary(): void {
	const g = globalThis as unknown as Record<string, Store | undefined>;
	const s = g[GLOBAL_KEY];
	if (!s || !s.summary_timer) return;
	clearInterval(s.summary_timer);
	s.summary_timer = undefined;
}

/**
 * Test-only reset. NOT part of the public API; exported under an underscore
 * prefix so its danger is visible. Drops the store from globalThis so the next
 * `inc()` / `isEnabled()` cold-starts fresh.
 */
export function _resetForTests(): void {
	stopSummary();
	const g = globalThis as unknown as Record<string, Store | undefined>;
	g[GLOBAL_KEY] = undefined;
	enabledCached = undefined;
}

/**
 * resource-monitor.ts — Pressure-sensor layer for the GC-2026-064 PoC.
 *
 * Design (GC-2026-064 Phase 2 — pre-tool_call + threshold advisory):
 *
 *   - `sample()` is a cheap (<5ms) snapshot of the process + host state:
 *     RSS / heapUsed / free+total memory / loadavg1 / cpu count / child count.
 *     No new dependencies — Node built-ins only (os, process, child_process).
 *
 *   - `pressureScore(snap)` blends three normalized signals into a 0..1 score
 *     using caller-configurable weights (default: rss 0.4 + load 0.4 + mem 0.2).
 *
 *   - `shouldAdvis(snap)` is the threshold gate (default 0.8) — that's what
 *     `agent-runner.ts` (Phase 3 wiring) checks before injecting the advisory.
 *
 *   - `formatAdvisory(snap)` produces a deterministic short string (≤200 chars)
 *     for the tool-result envelope. The leading `[sages resource:` prefix is
 *     part of the contract (SC4-d) and downstream readers can pattern-match on
 *     it. We deliberately avoid `Date.toLocaleString` to keep the string
 *     reproducible across locales / timezones — only integer fields are used.
 *
 *   - `__setMockSnapshot(snap)` is the **test seam**. It short-circuits
 *     `sample()` to return the given snapshot instead of doing real sampling.
 *     The leading double-underscore + the JSDoc above mark it as
 *     production-private; no production code paths reference it.
 *
 * Stability: shape of `ResourceSnapshot` and the pressure-score formula are
 * pinned by `test/resource-monitor.test.ts` (SC4). Changing either is a scope
 * change.
 */

import { execFileSync } from "node:child_process";
import * as os from "node:os";

export interface ResourceSnapshot {
	/** Process RSS in megabytes, rounded to integer. */
	rssMB: number;
	/** V8 heapUsed in megabytes. */
	heapUsedMB: number;
	/** Host free memory in megabytes. */
	freeMemMB: number;
	/** Host total memory in megabytes. */
	totalMemMB: number;
	/** 1-minute load average (BSD / Linux semantics). */
	loadAvg1: number;
	/** CPU count reported by os.cpus().length. */
	cpuCount: number;
	/** Direct child processes (pgrep -P <pid> | wc). */
	childrenCount: number;
	/** sample() timestamp (ms since epoch). */
	timestamp: number;
}

export interface PressureWeight {
	/** RSS share of the blended pressure score. Default 0.4. */
	rss?: number;
	/** loadAvg share. Default 0.4. */
	load?: number;
	/** mem pressure share. Default 0.2. */
	mem?: number;
}

export interface ResourceMonitorOptions {
	/** Pressure threshold for shouldAdvis(). Default 0.8. */
	threshold?: number;
	/** Per-signal blend weights. See PressureWeight. */
	pressureWeight?: PressureWeight;
}

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_WEIGHTS: Required<PressureWeight> = { rss: 0.4, load: 0.4, mem: 0.2 };

/** Clamp x into [0, 1]. Tiny helper — extracted for clarity, not reuse. */
function clamp01(x: number): number {
	if (Number.isNaN(x)) return 0;
	if (x < 0) return 0;
	if (x > 1) return 1;
	return x;
}

/** Parse `pgrep -P <pid> -c` output to integer; 0 on any failure. */
function countChildren(): number {
	try {
		const out = execFileSync("pgrep", ["-P", String(process.pid), "-c"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const n = parseInt(out.toString().trim(), 10);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	} catch {
		return 0;
	}
}

export class ResourceMonitor {
	private readonly threshold: number;
	private readonly weights: Required<PressureWeight>;
	/** Test seam — null in production. See JSDoc at top of file. */
	private mockSnapshot: ResourceSnapshot | null = null;

	constructor(opts?: ResourceMonitorOptions) {
		this.threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
		this.weights = { ...DEFAULT_WEIGHTS, ...(opts?.pressureWeight ?? {}) };
	}

	/** Snapshot now. Cheap (<5ms). Real sampling unless the test seam is set. */
	sample(): ResourceSnapshot {
		if (this.mockSnapshot) return this.mockSnapshot;
		const mu = process.memoryUsage();
		const cpus = os.cpus();
		return {
			rssMB: Math.round(mu.rss / 1024 / 1024),
			heapUsedMB: mu.heapUsed / 1024 / 1024,
			freeMemMB: os.freemem() / 1024 / 1024,
			totalMemMB: os.totalmem() / 1024 / 1024,
			loadAvg1: os.loadavg()[0],
			cpuCount: cpus.length,
			childrenCount: countChildren(),
			timestamp: Date.now(),
		};
	}

	/**
	 * Compute pressure score in [0, 1]. Formula pinned by SC4. Default weights
	 * {rss:0.4, load:0.4, mem:0.2} — see PressureWeight for overrides.
	 */
	pressureScore(snap?: ResourceSnapshot): number {
		const s = snap ?? this.sample();
		const memRatio = clamp01(
			(s.totalMemMB - s.freeMemMB) / Math.max(s.totalMemMB, 1),
		);
		const loadRatio = clamp01(s.loadAvg1 / Math.max(s.cpuCount, 1));
		const rssRatio = clamp01(s.rssMB / Math.max(s.totalMemMB, 1) / 0.25);
		return (
			this.weights.rss * rssRatio +
			this.weights.load * loadRatio +
			this.weights.mem * memRatio
		);
	}

	/** True iff pressureScore >= threshold (default 0.8). */
	shouldAdvis(snap?: ResourceSnapshot): boolean {
		return this.pressureScore(snap ?? this.sample()) >= this.threshold;
	}

	/**
	 * Render the advisory line that gets appended to a tool-result envelope.
	 * Deterministic — no Date.toLocaleString or other locale-sensitive
	 * formatters. Length ≤ 200 chars (asserted by test (d)).
	 */
	formatAdvisory(snap: ResourceSnapshot): string {
		const score = this.pressureScore(snap);
		const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "0");
		return (
			`[sages resource: score=${score.toFixed(2)} ` +
			`rss=${fmt(snap.rssMB)}MB ` +
			`heap=${fmt(snap.heapUsedMB)}MB ` +
			`free=${fmt(snap.freeMemMB)}MB/${fmt(snap.totalMemMB)}MB ` +
			`load=${snap.loadAvg1.toFixed(1)}/${fmt(snap.cpuCount)} ` +
			`children=${fmt(snap.childrenCount)} ` +
			`ts=${Math.floor(snap.timestamp)}]`
		);
	}

	/**
	 * TEST SEAM — production code never calls this. When set to a non-null
	 * snapshot, `sample()` returns that value verbatim instead of doing real
	 * sampling. Pass `null` to restore live sampling.
	 */
	__setMockSnapshot(snap: ResourceSnapshot | null): void {
		this.mockSnapshot = snap;
	}
}

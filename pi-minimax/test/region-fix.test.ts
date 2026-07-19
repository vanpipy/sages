/**
 * RED phase: tests for region-fix service.
 *
 * The region-fix service detects the mmx-cli 1.0.15/1.0.16 bug where the
 * region=cn auto-resolved base_url ends with `/anthropic/v1` but the
 * endpoint handlers prepend another `/v1/...`, producing a doubled prefix
 * that 404s. Workaround: pass `--base-url https://api.minimaxi.com` (no
 * `/anthropic/v1` suffix) to bypass the auto-detection.
 *
 * Scenarios:
 *   R1: reader returns config with region=cn → needsBaseUrlOverride=true
 *   R2: reader returns config with region=global → needsBaseUrlOverride=false
 *   R3: reader returns null (file missing) → needsBaseUrlOverride=false
 *   R4: reader throws (IO error) → needsBaseUrlOverride=false
 *   R5: caches result across calls (reader invoked exactly once)
 *   R6: clearRegionFixCache() forces re-read
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
    detectRegionFix,
    clearRegionFixCache,
    CORRECTED_CN_BASE_URL,
    type MmxConfigSnapshot,
    type RegionFixReader,
} from "../src/services/region-fix.js";

/**
 * Build a reader from an array of snapshots (queue semantics). Throws if
 * invoked more times than there are snapshots — tests must size the queue
 * to match the expected number of detectRegionFix() calls.
 */
function queueReader(
    snapshots: Array<MmxConfigSnapshot | null>,
    opts: { throwOn?: number[] } = {},
): { reader: RegionFixReader; callCount: () => number } {
    const queue = [...snapshots];
    let calls = 0;
    const reader: RegionFixReader = async () => {
        const idx = calls;
        calls++;
        if (opts.throwOn?.includes(idx)) {
            throw new Error("simulated IO error");
        }
        const next = queue.shift();
        if (next === undefined) {
            throw new Error(`queueReader: no snapshot left for call #${idx}`);
        }
        return next;
    };
    return { reader, callCount: () => calls };
}

describe("region-fix", () => {
    beforeEach(() => {
        clearRegionFixCache();
    });

    it("R1: region=cn in config triggers needsBaseUrlOverride=true", async () => {
        const { reader } = queueReader([{ region: "cn" }]);
        const fix = await detectRegionFix({ reader });
        expect(fix.needsBaseUrlOverride).toBe(true);
        expect(fix.correctedBaseUrl).toBe(CORRECTED_CN_BASE_URL);
        expect(fix.correctedBaseUrl).toBe("https://api.minimaxi.com");
    });

    it("R2: region=global in config leaves needsBaseUrlOverride=false", async () => {
        const { reader } = queueReader([{ region: "global" }]);
        const fix = await detectRegionFix({ reader });
        expect(fix.needsBaseUrlOverride).toBe(false);
        // correctedBaseUrl is still set (so callers can use it as fallback)
        expect(fix.correctedBaseUrl).toBe(CORRECTED_CN_BASE_URL);
    });

    it("R3: missing region field leaves needsBaseUrlOverride=false", async () => {
        const { reader } = queueReader([{ api_key: "sk-xxx" }]);
        const fix = await detectRegionFix({ reader });
        expect(fix.needsBaseUrlOverride).toBe(false);
    });

    it("R4: reader returns null (file not found) → no override", async () => {
        const { reader } = queueReader([null]);
        const fix = await detectRegionFix({ reader });
        expect(fix.needsBaseUrlOverride).toBe(false);
    });

    it("R5: reader throws (IO error) → no override (fail-open)", async () => {
        const { reader } = queueReader([], { throwOn: [0] });
        const fix = await detectRegionFix({ reader });
        expect(fix.needsBaseUrlOverride).toBe(false);
    });

    it("R6: result is cached — reader invoked exactly once across multiple calls", async () => {
        const { reader, callCount } = queueReader([{ region: "cn" }]);
        const a = await detectRegionFix({ reader });
        const b = await detectRegionFix({ reader });
        const c = await detectRegionFix({ reader });
        expect(callCount()).toBe(1);
        expect(a).toEqual(b);
        expect(b).toEqual(c);
        expect(a.needsBaseUrlOverride).toBe(true);
    });

    it("clearRegionFixCache() forces reader to be invoked again", async () => {
        const { reader, callCount } = queueReader([
            { region: "cn" },
            { region: "global" }, // after clear, this should be read
        ]);
        const first = await detectRegionFix({ reader });
        expect(first.needsBaseUrlOverride).toBe(true);
        expect(callCount()).toBe(1);

        clearRegionFixCache();
        const second = await detectRegionFix({ reader });
        expect(second.needsBaseUrlOverride).toBe(false);
        expect(callCount()).toBe(2);
    });

    it("region field is case-sensitive (mmx-cli uses lowercase)", async () => {
        // Defensive: mmx-cli's resolver is case-sensitive on 'cn' / 'global'.
        // A user with 'CN' (uppercase) would NOT hit the bug — verify we don't
        // false-positive on it.
        const { reader } = queueReader([{ region: "CN" }]);
        const fix = await detectRegionFix({ reader });
        expect(fix.needsBaseUrlOverride).toBe(false);
    });

    it("empty config object leaves needsBaseUrlOverride=false", async () => {
        const { reader } = queueReader([{}]);
        const fix = await detectRegionFix({ reader });
        expect(fix.needsBaseUrlOverride).toBe(false);
    });
});
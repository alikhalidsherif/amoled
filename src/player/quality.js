// Quality negotiation system (PLAN.md §Phase 8).
//
// requested (scene.quality)
//     ↓ device capabilities tier
//     ↓ measured cost  (FPS is PRIMARY [A1]; CPU submit cost is secondary —
//                       submit time underestimates GPU-bound devices exactly
//                       where protection matters most)
//     ↓ safety limits
//     ↓ actual quality { logicalWidth, logicalHeight, fps, supersample }
//
// ART-KEY IMMUTABILITY (Rule 3): this module can only ever write the keys
// in WRITABLE_KEYS. Everything artistic/display is physically out of reach.
//
// DOM-free and interval-free: the host drives samples via .sample(now).
// Unit-testable in bare Node with mocked metrics.

import { mulberry32 } from "../scene/prng.js";

/** The ONLY keys any quality code may write anywhere. */
export const WRITABLE_KEYS = Object.freeze([
    "supersample",
    "maxDevicePixelRatio",
    "logicalWidth",
    "logicalHeight",
    "fps"
]);

const FPS_FLOOR = 12;
const Hysteresis = Object.freeze({ strikesDown: 3, goodUp: 8, cooldownDownMs: 5000, cooldownUpMs: 10000 });

function assertWritable(patch, origin) {
    for (const k of Object.keys(patch)) {
        if (!WRITABLE_KEYS.includes(k)) {
            throw new Error(`quality violation: "${origin}" attempted to write non-quality key "${k}"`);
        }
    }
}

/**
 * @param {object} options
 * @param {object} options.renderer - exposes config + updateConfig(patch).
 * @param {object} options.runtime - exposes setQualityOverride(o) / isRunning /
 *   isStatic (optional).
 * @param {() => object} options.getRequested - { logicalWidth?, logicalHeight?,
 *   fps, supersample } from the active scene (nulls = auto).
 * @param {() => boolean} options.isAnimated - false ⇒ sampling exempt (static
 *   scenes don't consume continuous time and are never downgraded).
 * @param {() => {renderCostMs:number, measuredFps:number}} options.getMeasured
 * @param {boolean} [options.lowTier] - explicit device-tier override
 *   (defaults to deviceMemory/hardwareConcurrency heuristics).
 * @param {(actual:object) => void} [options.onqualitychange]
 */
export function createQualityNegotiator(options) {
    const { renderer, runtime, getRequested, isAnimated, getMeasured, onqualitychange } = options;
    if (!renderer || typeof renderer.updateConfig !== "function") {
        throw new Error("createQualityNegotiator requires a renderer");
    }

    // ---- Device capabilities tier ------------------------------------
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const mem = nav.deviceMemory || 8;
    const cores = nav.hardwareConcurrency || 8;
    const lowTier = typeof options.lowTier === "boolean"
        ? options.lowTier
        : (mem <= 2 || cores <= 4);

    // Safety limits (engine-owned ceilings; never exceeded by negotiation).
    const limits = Object.freeze({
        dprCap: lowTier ? 1 : (renderer.config.maxDevicePixelRatio || 2),
        supersampleCeiling: lowTier ? 1 : 4,
        resolutionCeiling: 1280,
        minPixelScale: renderer.config.minPixelScale || 1
    });

    // ---- State --------------------------------------------------------
    let requested = normalizeRequested(getRequested ? getRequested() : null);
    let rng = mulberry32(0x91ec7e5);

    const state = {
        resStep: 0,       // logicalResolution −25% per step (max 2 steps)
        fpsStep: 0,       // fps −30% per step (max 2 steps)
        ssDropped: false,
        dprCapped: false,
        strikes: 0,
        goodStreak: 0,
        cooldownUntil: 0
    };

    let lastActual = null;

    function normalizeRequested(r) {
        r = r || {};
        return {
            logicalWidth: Number.isFinite(r.logicalWidth) ? r.logicalWidth : null,
            logicalHeight: Number.isFinite(r.logicalHeight) ? r.logicalHeight : null,
            fps: Number.isFinite(r.fps) && r.fps >= 1 ? r.fps : 30,
            supersample: [1, 2, 3, 4].includes(r.supersample) ? r.supersample : null // auto
        };
    }

    function computeActual() {
        // Start from request.
        let w = requested.logicalWidth;
        let h = requested.logicalHeight;
        let fps = requested.fps;
        let ss = requested.supersample;

        // Auto resolution: aspect-corrected default handled by the runtime;
        // here we only scale whatever base exists by the downgrade ladder.
        const resScale = Math.pow(0.75, state.resStep);
        if (w) w = Math.max(64, Math.min(limits.resolutionCeiling, Math.round(w * resScale)));
        if (h) h = Math.max(64, Math.min(limits.resolutionCeiling, Math.round(h * resScale)));

        fps = Math.max(FPS_FLOOR, Math.round(fps * Math.pow(0.7, state.fpsStep)));

        // A dropped supersample forces 1 even for "auto" requests; otherwise
        // auto stays auto (the engine chooses).
        if (state.ssDropped) ss = 1;

        return {
            logicalWidth: w,
            logicalHeight: h,
            fps,
            supersample: ss,
            maxDevicePixelRatio: state.dprCapped ? 1 : limits.dprCap
        };
    }

    function publish(force) {
        const actual = computeActual();
        const key = JSON.stringify(actual);
        if (!force && key === JSON.stringify(lastActual)) return false;
        lastActual = actual;

        // Apply through whitelisted channels only.
        const rendererPatch = {};
        if (actual.supersample !== null &&
            renderer.config.supersample !== actual.supersample) {
            rendererPatch.supersample = actual.supersample;
        }
        const dprNow = renderer.config.maxDevicePixelRatio;
        if (actual.maxDevicePixelRatio !== dprNow) {
            rendererPatch.maxDevicePixelRatio = actual.maxDevicePixelRatio;
        }
        assertWritable(rendererPatch, "quality-negotiator/renderer");

        const runtimeOverride = {
            logicalWidth: actual.logicalWidth,
            logicalHeight: actual.logicalHeight,
            fps: actual.fps
        };
        assertWritable(runtimeOverride, "quality-negotiator/runtime");

        if (Object.keys(rendererPatch).length) renderer.updateConfig(rendererPatch);
        if (runtime && typeof runtime.setQualityOverride === "function") {
            runtime.setQualityOverride(runtimeOverride);
        }
        if (onqualitychange) onqualitychange({ ...actual });
        return true;
    }

    /** Re-read requested quality (scene change) and republish. */
    function refreshRequest(newRequested) {
        requested = normalizeRequested(newRequested);
        state.resStep = 0;
        state.fpsStep = 0;
        state.ssDropped = false;
        state.dprCapped = false;
        state.strikes = 0;
        state.goodStreak = 0;
        publish(true);
    }

    /**
     * One negotiation sample. Host calls this periodically (~1.5s) while a
     * scene is animated.
     */
    function sample(now) {
        if (!isAnimated()) return;         // static scenes are exempt
        const m = getMeasured ? getMeasured() : { renderCostMs: 0, measuredFps: 0 };
        if (!(m.measuredFps > 0)) return;  // nothing measured yet

        const budget = 1000 / computeActual().fps;
        const fpsMiss = m.measuredFps < computeActual().fps * 0.8;
        // PRIMARY: FPS misses weigh fully. SECONDARY: cost misses weigh half.
        const costMiss = m.renderCostMs > budget * 0.85;

        now = now ?? Date.now();

        if (fpsMiss || costMiss) {
            state.strikes += fpsMiss ? 1 : 0.5;
            state.goodStreak = 0;
        } else {
            state.strikes = 0;
            state.goodStreak++;
        }

        if (state.strikes >= Hysteresis.strikesDown && now > state.cooldownUntil) {
            downgrade();
            state.cooldownUntil = now + Hysteresis.cooldownDownMs;
        } else if (state.goodStreak >= Hysteresis.goodUp && now > state.cooldownUntil) {
            upgrade();
            state.cooldownUntil = now + Hysteresis.cooldownUpMs;
        }
    }

    function downgrade() {
        // Ladder order: resolution → fps → supersample → DPR (§Phase 8).
        rng(); // keep PRNG touched for future jitter use
        if (state.resStep < 2) state.resStep++;
        else if (state.fpsStep < 2) state.fpsStep++;
        else if (!state.ssDropped) state.ssDropped = true;
        else if (!state.dprCapped) state.dprCapped = true;
        else return; // already at floor
        publish(true);
    }

    function upgrade() {
        if (state.dprCapped) state.dprCapped = false;
        else if (state.ssDropped) state.ssDropped = false;
        else if (state.fpsStep > 0) state.fpsStep--;
        else if (state.resStep > 0) state.resStep--;
        else return;
        publish(true);
    }

    // Initial publish.
    publish(true);

    return {
        sample,
        refreshRequest,
        getActual: () => ({ ...(lastActual || computeActual()) }),
        getRequested: () => ({ ...requested }),
        /** Test hook: force a specific ladder position. */
        __forceLadder(resStep, fpsStep, ssDropped, dprCapped) {
            state.resStep = resStep; state.fpsStep = fpsStep;
            state.ssDropped = ssDropped; state.dprCapped = dprCapped;
            publish(true);
        }
    };
}

/** Deterministic RNG exposure for hosts that need seeded decisions. */
export function qualityRng(seed) {
    return mulberry32(seed);
}


// ------------------------------------------------------------------
// LEGACY: Phase 1 extraction kept for the standalone demo path until the
// demo is replaced by the player everywhere. New code should use
// createQualityNegotiator. TODO(Phase 9/10 cleanup): remove with demo.
// ------------------------------------------------------------------

/**
 * @param {object} renderer - a renderer instance (GPU or Canvas 2D) exposing
 *   `config`, `updateConfig(patch)` and optionally `getRenderCost()`.
 * @param {object} [options]
 * @param {() => number} [options.getTargetFps] - current FPS target.
 * @param {() => boolean} [options.isActive] - governor samples only while true.
 * @param {(label: string) => void} [options.onStateChange] - "ok" | "auto-qN".
 */
export function createQualityGovernor(renderer, options = {}) {
    const getTargetFps = typeof options.getTargetFps === "function"
        ? options.getTargetFps : () => 24;
    const isActive = typeof options.isActive === "function"
        ? options.isActive : () => true;
    const onStateChange = typeof options.onStateChange === "function"
        ? options.onStateChange : () => {};

    const config = renderer.config;
    const original = {
        supersample: config.supersample,
        maxInternalPixels: config.maxInternalPixels,
        maxDevicePixelRatio: config.maxDevicePixelRatio
    };

    // Cumulative downgrade ladder; step 0 = requested settings untouched.
    const LADDER = [
        null,
        { supersample: 1 },
        { maxInternalPixels: Math.min(original.maxInternalPixels, 12582912) },
        { maxDevicePixelRatio: 1 },
        { maxInternalPixels: 5242880, maxDevicePixelRatio: 1 }
    ];

    const state = { step: 0, strikes: 0, goodStreak: 0, cooldownUntil: 0 };
    let frames = 0;
    let lastTick = 0;
    let sampleTimer = null;
    let rafHandle = 0;
    let disposed = false;

    function label() {
        return state.step === 0 ? "ok" : "auto-q" + state.step;
    }

    function applyStep(step) {
        if (step === 0) {
            renderer.updateConfig({
                supersample: original.supersample,
                maxInternalPixels: original.maxInternalPixels,
                maxDevicePixelRatio: original.maxDevicePixelRatio
            });
        } else {
            renderer.updateConfig(LADDER[step]);
        }
        onStateChange(label());
    }

    function tickFrame() {
        frames++;
        rafHandle = requestAnimationFrame(tickFrame);
    }

    function sample() {
        if (disposed) return;
        const now = performance.now();

        if (document.hidden || !isActive()) {
            lastTick = now;
            frames = 0;
            return;
        }

        const elapsed = Math.max(1, now - lastTick);
        lastTick = now;

        const targetFps = Math.max(1, Number(getTargetFps()) || 24);
        const budgetMs = 1000 / targetFps;
        const cost = typeof renderer.getRenderCost === "function"
            ? renderer.getRenderCost()
            : 0;
        const measuredFps = frames * 1000 / elapsed;
        frames = 0;

        if (!cost) return;

        const overloaded =
            cost > budgetMs * 0.85 ||
            (measuredFps < targetFps * 0.7 && state.step > 0);

        if (overloaded) {
            state.strikes++;
            state.goodStreak = 0;
        } else {
            state.strikes = 0;
            state.goodStreak =
                state.step > 0 && cost < budgetMs * 0.4 &&
                measuredFps >= targetFps * 0.95
                    ? state.goodStreak + 1
                    : 0;
        }

        if (state.strikes >= 3 && now > state.cooldownUntil) {
            if (state.step < LADDER.length - 1) {
                state.step++;
                applyStep(state.step);
            }
            state.strikes = 0;
            state.cooldownUntil = now + 5000;
        } else if (state.goodStreak >= 8 && now > state.cooldownUntil) {
            state.step--;
            applyStep(state.step);
            state.goodStreak = 0;
            state.cooldownUntil = now + 10000;
        }
    }

    function start() {
        if (sampleTimer || disposed) return;
        lastTick = performance.now();
        frames = 0;
        rafHandle = requestAnimationFrame(tickFrame);
        sampleTimer = setInterval(sample, 1500);
    }

    function stop() {
        if (sampleTimer) {
            clearInterval(sampleTimer);
            sampleTimer = null;
        }
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = 0;
        }
    }

    function getActualQuality() {
        return {
            label: label(),
            step: state.step,
            supersample: config.supersample,
            maxInternalPixels: config.maxInternalPixels,
            maxDevicePixelRatio: config.maxDevicePixelRatio
        };
    }

    function setRequestedQuality(requested = {}) {
        if (typeof requested.supersample !== "undefined") {
            original.supersample = requested.supersample;
        }
        if (typeof requested.maxInternalPixels !== "undefined") {
            original.maxInternalPixels = requested.maxInternalPixels;
        }
        if (typeof requested.maxDevicePixelRatio !== "undefined") {
            original.maxDevicePixelRatio = requested.maxDevicePixelRatio;
        }
        state.step = 0;
        state.strikes = 0;
        state.goodStreak = 0;
        applyStep(0);
    }

    function destroy() {
        stop();
        disposed = true;
        renderer.updateConfig({
            supersample: original.supersample,
            maxInternalPixels: original.maxInternalPixels,
            maxDevicePixelRatio: original.maxDevicePixelRatio
        });
    }

    start();

    return { start, stop, destroy, setRequestedQuality, getActualQuality };
}
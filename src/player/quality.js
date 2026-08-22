// Adaptive quality governor (Phase 1 extraction of the app.js logic).
//
// TODO(Phase 8): this whole implementation is replaced by the quality
// negotiation system described in PLAN.md §Phase 8. The public surface
// (createQualityGovernor / setRequestedQuality / getActualQuality) is kept
// stable so the swap is internal.
//
// Rules honored here (PLAN.md §2 Rule 3): only quality variables are ever
// written — supersample, maxInternalPixels, maxDevicePixelRatio. Artistic /
// display variables are never touched.

/**
 * @param {object} renderer - a renderer instance (GPU or Canvas 2D) exposing
 *   `config`, `updateConfig(patch)` and optionally `getRenderCost()`.
 * @param {object} [options]
 * @param {() => number} [options.getTargetFps] - current FPS target.
 * @param {() => boolean} [options.isActive] - governor samples only while true
 *   (e.g. animated media is playing).
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

        // Nothing rendered during this window; nothing to judge.
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
        // Restore the requested settings before going away.
        renderer.updateConfig({
            supersample: original.supersample,
            maxInternalPixels: original.maxInternalPixels,
            maxDevicePixelRatio: original.maxDevicePixelRatio
        });
    }

    start();

    return { start, stop, destroy, setRequestedQuality, getActualQuality };
}

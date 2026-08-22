// Central clock + scheduling (PLAN.md §Phase 3/4).
//
// Owns THE single requestAnimationFrame loop when a scene is animated, and
// NO loop at all when it is static (Rule 4). Animated scenes are gated to
// quality.fps via accumulated time inside rAF.

export function createRuntime({ renderer }) {
    const engineRenderer = renderer;
    let definition = null;
    let assets = {};
    let workspace = null;       // reusable RGB buffer
    let logicalW = 0;
    let logicalH = 0;

    let running = false;
    let rafHandle = 0;
    let lastFrameTime = 0;
    let accumulated = 0;
    let sceneTime = 0;

    const listeners = { frame: [], error: [] };

    function emit(kind, payload) {
        for (const fn of listeners[kind]) {
            try { fn(payload); } catch (e) { console.error(e); }
        }
    }

    function negotiateLogicalSize(def) {
        // Aspect-correct logical resolution: match the renderer canvas so
        // content never stretches (PLAN.md Rule 6).
        const rect = renderer.canvas
            ? renderer.canvas.getBoundingClientRect()
            : null;
        const aspect = rect && rect.height > 0 ? rect.width / rect.height : 16 / 9;

        if (def.quality.logicalWidth && def.quality.logicalHeight) {
            return {
                width: Math.round(def.quality.logicalWidth),
                height: Math.round(def.quality.logicalHeight)
            };
        }
        if (def.quality.logicalWidth) {
            const w = def.quality.logicalWidth;
            return { width: w, height: Math.max(64, Math.round(w / aspect)) };
        }
        if (def.quality.logicalHeight) {
            const h = def.quality.logicalHeight;
            return { width: Math.min(1280, Math.max(64, Math.round(h * aspect))), height: h };
        }
        // Auto: 180px on the short side.
        const height = aspect < 1 ? 320 : 180;
        return {
            width: Math.min(1280, Math.max(64, Math.round(height * aspect))),
            height: height
        };
    }

    function renderOnce() {
        if (!definition) return;
        workspace = rasterizeCurrent();
        renderer.loadFrameBuffer(logicalW, logicalH, workspace);
    }

    function rasterizeCurrent() {
        // Imported lazily to keep this module's dependency list explicit.
        return runtimeRasterize(definition, sceneTime, { width: logicalW, height: logicalH }, assets, workspace);
    }

    function tick(now) {
        if (!running || !definition) return;
        rafHandle = requestAnimationFrame(tick);

        const dt = Math.min(250, now - lastFrameTime);
        lastFrameTime = now;

        const targetFps = definition.isStatic ? 60 : (definition.quality.fps || 30);
        accumulated += dt;
        const frameInterval = 1000 / targetFps;

        if (!definition.isStatic && accumulated >= frameInterval) {
            // Advance scene time; loop wrap handled by timeline in Phase 4.
            sceneTime += accumulated / 1000;
            accumulated %= frameInterval;

            try {
                workspace = rasterizeCurrent();
                renderer.loadFrameBuffer(logicalW, logicalH, workspace);
                emit("frame", { t: sceneTime });
            } catch (err) {
                emit("error", err);
            }
        }
    }

    function startLoop() {
        if (running || !definition) return;
        if (definition.isStatic) {
            // Rule 4: static scenes render exactly once. No loop.
            renderOnce();
            return;
        }
        running = true;
        lastFrameTime = performance.now();
        accumulated = 0;
        rafHandle = requestAnimationFrame(tick);
    }

    const runtime = {
        /**
         * Attach a parsed+validated scene and its loaded assets. Applies the
         * display configuration through ONE updateConfig call (public API)
         * and renders the first frame immediately.
         */
        setScene({ definition: def, assets: loadedAssets }) {
            definition = def;
            assets = loadedAssets || {};

            applyDisplayConfig(engineRenderer, def.display);

            const size = negotiateLogicalSize(def);
            logicalW = size.width;
            logicalH = size.height;

            // Stop any previous loop before re-rendering.
            runtime.stop();
            renderOnce();
        },

        start: startLoop,

        pause() {
            running = false;
            if (rafHandle) cancelAnimationFrame(rafHandle);
            rafHandle = 0;
        },

        stop() {
            runtime.pause();
            sceneTime = 0;
            accumulated = 0;
        },

        /** Re-rasterize (quality change / invalidation). */
        invalidate() {
            if (running) {
                // next tick re-rasterizes anyway
            } else {
                renderOnce();
            }
        },

        get isRunning() { return running; },
        get isStatic() { return Boolean(definition && definition.isStatic); },
        get logicalSize() { return { width: logicalW, height: logicalH }; },
        get time() { return sceneTime; },

        on: function (kind, fn) {
            if (listeners[kind]) listeners[kind].push(fn);
        },

        destroy() {
            runtime.stop();
            definition = null;
            assets = null;
            workspace = null;
        }
    };

    return runtime;
}

// ------------------------------------------------------------------
// display -> engine config mapping (documented table, PLAN.md §Phase 3/§5.2)
// ------------------------------------------------------------------

/**
 * Maps normalized SceneDefinition.display onto engine config keys.
 * pitch === null means "auto": leave auto-density untouched.
 */
export function displayToEngineConfig(display) {
    return {
        pixelScale: display.pitch !== null ? display.pitch : undefined,
        autoPixelScale: display.pitch === null ? true : false,
        emitterGamma: display.gamma,
        activeLevel: display.activeLevel,
        inactiveLevel: display.inactiveLevel,
        opticalSpill: display.spill,
        redMaxOutput: display.maxOutput.r,
        greenMaxOutput: display.maxOutput.g,
        blueMaxOutput: display.maxOutput.b,
        redSigma: display.sigma.r,
        greenSigma: display.sigma.g,
        blueSigma: display.sigma.b,
        bloomIntensity: display.bloom.intensity,
        bloomThreshold: display.bloom.threshold,
        bloomPower: display.bloom.power,
        bloomRadius: display.bloom.radius,
        rowPitchFactor: display.pentile.rowPitchFactor,
        blackMatrixRatio: display.pentile.blackMatrixRatio,
        greenSizeRatio: display.pentile.greenSizeRatio,
        diamondSizeRatio: display.pentile.diamondSizeRatio
    };
}

function applyDisplayConfig(renderer, display) {
    const patch = displayToEngineConfig(display);
    // Drop undefined keys (e.g. pixelScale "auto") — updateConfig treats
    // absent keys as untouched, preserving the current value.
    const clean = {};
    for (const k of Object.keys(patch)) {
        if (patch[k] !== undefined) clean[k] = patch[k];
    }
    renderer.updateConfig(clean);
}

// Rasterizer import indirection (avoids circular import concerns later).
import { rasterize as runtimeRasterize } from "../scene/rasterizer.js";

// Central clock + scheduling (PLAN.md §Phase 3/4).
//
// Owns THE single requestAnimationFrame loop when a scene is animated, and
// NO loop at all when it is static (Rule 4). Animated scenes are gated to
// quality.fps via accumulated time inside rAF.
//
// Phase 4 additions: timeline keyframes applied per tick as uniform-only
// updateConfig patches; GIF/video scene types driven through the runtime
// clock (decoder handles from the player); tab-visibility pauses the clock;
// window resizes re-negotiate logical size and re-render [A2].

import { rasterize } from "../scene/rasterizer.js";
import { createTimeline } from "./timeline.js";

export function createRuntime({ renderer }) {
    const engineRenderer = renderer;
    let definition = null;
    let assets = {};
    let timeline = null;
    let mediaDecoder = null;     // decoder handle when scene.type is gif/video
    let workspace = null;        // reusable RGB buffer
    let logicalW = 0;
    let logicalH = 0;

    let running = false;
    let rafHandle = 0;
    let lastFrameTime = 0;
    let accumulated = 0;
    let sceneTime = 0;

    // Quality-negotiation override (Phase 8): wins over scene quality
    // requests. Keys: logicalWidth, logicalHeight, fps (all optional).
    let qualityOverride = null;

    const listeners = { frame: [], error: [] };

    function emit(kind, payload) {
        for (const fn of listeners[kind]) {
            try { fn(payload); } catch (e) { console.error(e); }
        }
    }

    function negotiateLogicalSize(def) {
        // Aspect-correct logical resolution: match the renderer canvas so
        // content never stretches (PLAN.md Rule 6). Negotiated overrides
        // (Phase 8) win over scene requests.
        const o = qualityOverride;
        if (o && o.logicalWidth && o.logicalHeight) {
            return { width: o.logicalWidth, height: o.logicalHeight };
        }
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

    function isMediaScene() {
        return Boolean(mediaDecoder);
    }

    function pushCurrentFrame() {
        if (isMediaScene()) {
            mediaDecoder.advance();
            const frame = mediaDecoder.getFrame(logicalW, logicalH);
            if (frame && frame.data && frame.width === logicalW && frame.height === logicalH) {
                renderer.loadFrameBuffer(frame.width, frame.height, frame.data);
            }
            return;
        }
        workspace = rasterizeCurrent();
        renderer.loadFrameBuffer(logicalW, logicalH, workspace);
    }

    function mediaAdvance() {
        if (isMediaScene()) mediaDecoder.advance();
    }

    function rasterizeCurrent() {
        return rasterize(definition, sceneTime, { width: logicalW, height: logicalH }, assets, workspace);
    }

    function tick(now) {
        if (!running || !definition) return;
        rafHandle = requestAnimationFrame(tick);

        const dt = Math.min(250, now - lastFrameTime);
        lastFrameTime = now;

        const targetFps = definition.isStatic
            ? 60
            : ((qualityOverride && qualityOverride.fps) || definition.quality.fps || 30);
        accumulated += dt;
        const frameInterval = 1000 / targetFps;

        if (!definition.isStatic && accumulated >= frameInterval) {
            sceneTime += accumulated / 1000;
            accumulated %= frameInterval;

            try {
                // Keyframed display properties: uniform-only patch, cheap.
                const patch = timeline.sample(sceneTime);
                if (Object.keys(patch).length > 0) {
                    engineRenderer.updateConfig(patch);
                }

                mediaAdvance();
                pushCurrentFrame();
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
            pushCurrentFrame();
            return;
        }
        running = true;
        lastFrameTime = performance.now();
        accumulated = 0;
        rafHandle = requestAnimationFrame(tick);
        if (mediaDecoder) mediaDecoder.play();
    }

    function applyDisplay(display) {
        const patch = displayToEngineConfig(display);
        // Drop undefined keys (e.g. pixelScale "auto") — updateConfig treats
        // absent keys as untouched, preserving the current value.
        const clean = {};
        for (const k of Object.keys(patch)) {
            if (patch[k] !== undefined) clean[k] = patch[k];
        }
        engineRenderer.updateConfig(clean);
    }

    // ---- Tab visibility + resize handling [A2] ------------------------
    function handleVisibility() {
        if (!definition || definition.isStatic) return;
        if (document.hidden) {
            runtime.pause();
            if (mediaDecoder) mediaDecoder.pause();
        } else if (definition) {
            startLoop();
            if (mediaDecoder) mediaDecoder.play();
        }
    }

    function handleResize() {
        if (!definition) return;
        const size = negotiateLogicalSize(definition);
        if (size.width !== logicalW || size.height !== logicalH) {
            logicalW = size.width;
            logicalH = size.height;
            workspace = null;      // force reallocation at new size
            runtime.invalidate();
        }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("resize", handleResize);

    const runtime = {
        /**
         * Attach a parsed+validated scene and its loaded assets. Applies the
         * display configuration through ONE updateConfig call (public API)
         * and renders the first frame immediately.
         */
        setScene({ definition: def, assets: loadedAssets }) {
            definition = def;
            assets = loadedAssets || {};

            timeline = createTimeline(def.timeline);
            mediaDecoder = null;
            for (const key of Object.keys(assets)) {
                const a = assets[key];
                if (a && (a.type === "gif" || a.type === "video")) {
                    mediaDecoder = a;
                    break;
                }
            }

            applyDisplay(def.display);

            const size = negotiateLogicalSize(def);
            logicalW = size.width;
            logicalH = size.height;

            runtime.stop();
            pushCurrentFrame();

            if (mediaDecoder && mediaDecoder.type === "video") mediaDecoder.play();
        },

        start: startLoop,

        pause() {
            running = false;
            if (rafHandle) cancelAnimationFrame(rafHandle);
            rafHandle = 0;
            if (mediaDecoder) mediaDecoder.pause();
        },

        stop() {
            runtime.pause();
            sceneTime = 0;
            accumulated = 0;
        },

        /** Re-rasterize (quality change / invalidation). */
        invalidate() {
            renderOnceIfIdle();
        },

        /** Quality-negotiation override; re-renders at the new size. */
        setQualityOverride(o) {
            const prevW = logicalW, prevH = logicalH;
            qualityOverride = o ? Object.assign({}, o) : null;
            const size = negotiateLogicalSize(definition || { quality: {} });
            logicalW = size.width;
            logicalH = size.height;
            if (logicalW !== prevW || logicalH !== prevH) {
                workspace = null; // force reallocation at new size
                renderOnceIfIdle();
            } else {
                renderOnceIfIdle();
            }
        },

        get isRunning() { return running; },
        get definitionRef() { return definition; },
        get isStatic() { return Boolean(definition && definition.isStatic); },
        get logicalSize() { return { width: logicalW, height: logicalH }; },
        get time() { return sceneTime; },
        get timeline() { return timeline; },

        on: function (kind, fn) {
            if (listeners[kind]) listeners[kind].push(fn);
        },

        destroy() {
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener("resize", handleResize);
            runtime.pause();
            if (mediaDecoder) mediaDecoder.destroy();
            definition = null;
            assets = null;
            workspace = null;
        }
    };

    function renderOnceIfIdle() {
        if (!definition || running) return; // next tick re-rasterizes anyway
        if (definition.isStatic || !isMediaScene()) {
            if (definition.isStatic) {
                pushCurrentFrame();
                return;
            }
        }
        pushCurrentFrame();
    }

    return runtime;
}

// ------------------------------------------------------------------
// display -> engine config mapping (documented table, PLAN.md §5.2)
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

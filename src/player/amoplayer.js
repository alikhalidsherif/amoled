// AMOLEDPlayer — public scene playback API (PLAN.md §Phase 3).
//
// Fetch → parse → validate → assets → runtime → renderer. The player only
// touches the engine through its public boundary (loadFrameBuffer /
// updateConfig / requestRender) per PLAN.md Rule 1.

import { parseAmo, AmoError } from "../scene/parser.js";
import { loadAssets } from "../scene/assets.js";
import { createRuntime } from "./runtime.js";
import { createCacheStore } from "./cache.js";
import { createMediaDecoderFactory } from "./media-decoder.js";
import { createQualityNegotiator } from "./quality.js";

export default class AMOLEDPlayer {
    /**
     * @param {object} options
     * @param {object} options.renderer - a renderer instance (required).
     * @param {object} [options.events] - { onloadstart, onload, onerror }.
     */
    constructor({ renderer, events } = {}) {
        if (!renderer) throw new Error("AMOLEDPlayer requires a renderer instance.");
        this.renderer = renderer;
        this._events = events || {};
        this._caches = createCacheStore();
        this._decoderFactory = createMediaDecoderFactory();
        this.runtime = createRuntime({ renderer });
        this._currentUrl = null;

        // Phase 8: quality negotiation (FPS-primary signal, whitelisted keys).
        this._measuredFps = 0;
        let frames = 0;
        let lastTick = performance.now();
        const countFrame = () => { frames++; lastTick = performance.now(); };
        const fpsCounter = setInterval(() => {
            const now = performance.now();
            this._measuredFps = Math.round(frames * 1000 / Math.max(1, now - lastTick));
            frames = 0;
            lastTick = now;
        }, 1500);
        this._fpsInterval = fpsCounter;

        this.qualityNegotiator = createQualityNegotiator({
            renderer,
            runtime: this.runtime,
            getRequested: () => {
                const q = this.runtime.definition ? this.runtime.definition.quality : null;
                return q ? { logicalWidth: q.logicalWidth, logicalHeight: q.logicalHeight, fps: q.fps, supersample: q.supersample } : null;
            },
            isAnimated: () => this.runtime.isRunning && !this.runtime.isStatic,
            getMeasured: () => ({
                renderCostMs: typeof renderer.getRenderCost === "function" ? renderer.getRenderCost() : 0,
                measuredFps: this._measuredFps
            }),
            onqualitychange: (actual) => {
                if (this._events.onqualitychange) this._events.onqualitychange(actual);
            }
        });

        // Drive negotiation sampling.
        this._negotiationTimer = setInterval(() => {
            if (!document.hidden) this.qualityNegotiator.sample(performance.now());
        }, 1500);
    }

    /** Accepts a URL to a .amo file or a pre-parsed definition object. */
    async load(source) {
        const events = this._events;
        try {
            if (events.onloadstart) events.onloadstart({ source });

            let parsed;
            if (typeof source === "string") {
                const cached = this._caches.getScene(source);
                if (cached) {
                    parsed = cached;
                } else {
                    const response = await fetch(source);
                    if (!response.ok) {
                        throw new AmoError("", `failed to fetch ${source} (${response.status})`);
                    }
                    parsed = parseAmo(await response.text(), new URL(source, location.href).href);
                    this._caches.putScene(source, parsed);
                }
                this._currentUrl = source;
            } else {
                parsed = parseAmo(source); // pre-parsed object (or raw def)
                this._currentUrl = null;
            }

            const assets = await loadAssets(parsed.definition, this._caches.assetCache, this._decoderFactory);

            // Static-frame reuse: same definition + size ⇒ skip rasterize.
            const runtime = this.runtime;

            if (this._onSceneApplied) this._onSceneApplied(parsed.definition);
            runtime.setScene({ definition: parsed.definition, assets });
            if (this.qualityNegotiator) {
                this.qualityNegotiator.refreshRequest(parsed.definition.quality);
            }

            if (events.onload) events.onload({
                name: parsed.definition.meta.name,
                isStatic: parsed.definition.isStatic,
                warnings: parsed.warnings
            });
        } catch (err) {
            if (events.onerror) events.onerror(err);
            else throw err;
        }
        return this;
    }

    play() { this.runtime.start(); return this; }
    pause() { this.runtime.pause(); return this; }
    stop() { this.runtime.stop(); return this; }

    destroy() {
        clearInterval(this._negotiationTimer);
        clearInterval(this._fpsInterval);
        this.runtime.destroy();
        this._events = {};
    }
}

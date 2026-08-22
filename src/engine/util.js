(function attachEngineUtil(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    // Shared engine helpers. Loaded FIRST so every engine IIFE can rely on
    // AMOLED.util existing. Scene/player code must not use this namespace
    // (it is ESM-side and has its own helpers).
    AMOLED.util = Object.freeze({
        clamp01: function (v) {
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0) return 0;
            if (n >= 1) return 1;
            return n;
        },

        clampRange: function (value, min, max, fallback) {
            const n = Number(value);
            if (!Number.isFinite(n)) return fallback;
            return Math.min(Math.max(n, min), max);
        },

        clampInt: function (value, min, max, fallback) {
            const n = Math.round(Number(value));
            if (!Number.isFinite(n)) return fallback;
            return Math.min(Math.max(n, min), max);
        },

        positive: function (v, fallback) {
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : fallback;
        },

        resolveElement: function (explicitElement, selector, fallback) {
            if (explicitElement && explicitElement.nodeType === 1) {
                return explicitElement;
            }
            if (selector && typeof selector === "string") {
                const found = document.querySelector(selector);
                if (found) return found;
            }
            return fallback;
        },

        srgbChannelToLinear: function (c) {
            if (c <= 0.04045) {
                return c / 12.92;
            }
            return Math.pow((c + 0.055) / 1.055, 2.4);
        }
    });
})(window);

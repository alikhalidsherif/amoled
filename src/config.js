(function attachConfig(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    AMOLED.DEFAULT_ENGINE_CONFIG = Object.freeze({
        pixelScale: null,
        autoPixelScale: true,
        minPixelScale: 1,        // allows very fine manual pitches
        maxPixelScale: 24,
        targetLogicalWidth: 300, // auto-density aims for this many columns
        targetLogicalHeight: 180,

        rowPitchFactor: 0.86,
        blackMatrixRatio: 0.22,
        greenSizeRatio: 0.80,
        diamondSizeRatio: 0.90,

        // ---- Physical emitter model (linear-light simulation) ----
        // Emitter response exponent: L = intensity^gamma (§8)
        emitterGamma: 1.8,

        // Fraction of emitter energy in the gaussian optical spill halo (§10).
        // Higher values blend adjacent R/G/B into cleaner whites at the cost
        // of slightly soft subpixel edges.
        opticalSpill: 0.12,

        // Per-channel maximum output, relative (§3 / §17)
        redMaxOutput: 0.70,
        greenMaxOutput: 1.00,
        blueMaxOutput: 0.55,

        // Optical spread sigma in units of pixel pitch (§10 / §17)
        redSigma: 0.55,
        greenSigma: 0.35,
        blueSigma: 0.65,

        // Internal supersampling factor per axis (§13). 1-4.
        supersample: 1,
        maxInternalPixels: 33554432, // hard cap on emission-pass fragments

        // Large-scale bloom (§12) — floor is a fraction of peak luminance
        bloomThreshold: 0.45,
        bloomPower: 2.0,
        bloomRadius: 16,

        inactiveLevel: 0.035,
        activeLevel: 1.0,
        bloomIntensity: 0.0,

        defaultFrameWidth: 220,
        defaultFrameHeight: 132,

        containerSelector: "#display-shell",
        canvasSelector: "#display",
        maxDevicePixelRatio: 2
    });
})(window);

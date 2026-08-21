(function attachConfig(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    AMOLED.DEFAULT_ENGINE_CONFIG = Object.freeze({
        pixelScale: null,
        autoPixelScale: true,
        minPixelScale: 3.5,
        maxPixelScale: 11,
        targetLogicalWidth: 220,
        targetLogicalHeight: 132,

        rowPitchFactor: 0.86,
        blackMatrixRatio: 0.22,
        greenSizeRatio: 0.80,
        diamondSizeRatio: 0.90,

        // ---- Physical emitter model (linear-light simulation) ----
        // Emitter response exponent: L = intensity^gamma (§8)
        emitterGamma: 1.8,

        // Fraction of emitter energy in the gaussian optical spill halo (§10)
        opticalSpill: 0.05,

        // Per-channel maximum output, relative (§3 / §17)
        redMaxOutput: 0.70,
        greenMaxOutput: 1.00,
        blueMaxOutput: 0.55,

        // Optical spread sigma in units of pixel pitch (§10 / §17)
        redSigma: 0.45,
        greenSigma: 0.35,
        blueSigma: 0.55,

        // Internal supersampling factor per axis (§13). 1-4.
        supersample: 2,
        maxInternalPixels: 33554432, // hard cap on emission-pass fragments

        // Large-scale bloom (§12)
        bloomThreshold: 0.70,
        bloomPower: 2.0,
        bloomRadius: 12,

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

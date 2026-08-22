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

        // Fraction of emitter energy in the gaussian optical spill halos
        // (§10). High values blend adjacent R/G/B into clean whites; above
        // ~50% the hard core carries under half the energy and the discrete
        // subpixel structure dissolves.
        opticalSpill: 0.40,

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
        // Phase 10 GPU procedural fast path (expression scenes rendered in
        // their own WebGL2 context). Opt-in until validated across devices;
        // CPU rasterization remains the default reference path.
        gpuRaster: false,
        maxInternalPixels: 33554432, // hard cap on emission-pass fragments

        // Large-scale bloom (§12) — floor is a fraction of peak luminance
        bloomThreshold: 0.45,
        bloomPower: 2.0,
        bloomRadius: 16,

        // Emitter optics (Phase 7 promotion of former GLSL constants).
        coreSoftness: 0.75,      // px of core-edge anti-aliasing softness
        haloNearShare: 0.65,     // spill split: near-blend lobe share
        haloNearSigmaScale: 0.16,// near lobe sigma = sigma^2 * this (in px^2 terms)

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

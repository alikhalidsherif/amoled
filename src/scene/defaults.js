// Single source of normalized default values for .amo scene definitions.
//
// These numbers mirror src/engine/config.js (AMOLED.DEFAULT_ENGINE_CONFIG).
// The scene side must not read `window`, so the values are duplicated here
// deliberately — if you change an engine default, change it here too. A
// comment ties each block to its engine origin.

export const DISPLAY_DEFAULTS = Object.freeze({
    pitch: null,                 // null = "auto" (engine auto-density untouched)
    gamma: 1.8,                  // engine: emitterGamma
    activeLevel: 1.0,            // engine: activeLevel
    inactiveLevel: 0.035,        // engine: inactiveLevel
    spill: 0.40,                 // engine: opticalSpill
    maxOutput: Object.freeze({ r: 0.70, g: 1.00, b: 0.55 }),
    sigma: Object.freeze({ r: 0.55, g: 0.35, b: 0.65 }),
    bloom: Object.freeze({
        intensity: 0.0,
        threshold: 0.45,         // fraction of peak luminance
        power: 2.0,
        radius: 16
    }),
    pentile: Object.freeze({
        rowPitchFactor: 0.86,
        blackMatrixRatio: 0.22,
        greenSizeRatio: 0.80,
        diamondSizeRatio: 0.90
    })
});

export const QUALITY_DEFAULTS = Object.freeze({
    logicalWidth: null,          // null = auto
    logicalHeight: null,
    fps: 30,
    supersample: null            // null = "auto"
});

// Animation classes (PLAN.md §5.6). Paths are dot-prefixed matches against
// timeline keyframe property strings.
export const ANIMATABLE_PREFIXES = [
    "display.gamma",
    "display.brightness.",
    "display.spill",
    "display.emitters.",
    "display.bloom."
];

export const STRUCTURAL_PREFIXES = [
    "display.pitch",
    "display.pentile.",
    "quality.supersample"
];

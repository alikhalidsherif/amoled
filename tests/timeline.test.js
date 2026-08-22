// Phase 4 acceptance: timeline wrapping, interpolation, easings (Node).
// Run: node tests/timeline.test.js   (exit 0 = pass)
import { createTimeline, easeValue, wrapTime } from "../src/player/timeline.js";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
}

function approx(a, b, eps = 1e-6) {
    return Math.abs(a - b) < eps;
}

// --- easings ---
ok("easeValue linear", () => {
    if (!approx(easeValue("linear", 0.25), 0.25)) throw new Error("linear");
});
ok("easeValue smoothstep midpoint", () => {
    if (!approx(easeValue("smoothstep", 0.5), 0.5)) throw new Error("midpoint");
    if (!approx(easeValue("smoothstep", 0.25), 0.15625)) throw new Error("quarter");
});
ok("easeValue easeIn/easeOut", () => {
    if (!approx(easeValue("easeIn", 0.5), 0.25)) throw new Error("in");
    if (!approx(easeValue("easeOut", 0.5), 0.75)) throw new Error("out");
});
ok("easeValue clamps input", () => {
    if (!approx(easeValue("linear", -1), 0)) throw new Error("neg");
    if (!approx(easeValue("linear", 2), 1)) throw new Error("pos");
});

// --- wrapping ---
ok("wrapTime loops into [0,duration)", () => {
    if (!approx(wrapTime(12.5, 10, true), 2.5)) throw new Error("loop");
});
ok("wrapTime clamps when !loop", () => {
    if (!approx(wrapTime(99, 10, false), 10)) throw new Error("clamp");
});

// --- sampling ---
ok("no timeline -> empty patch, not animated", () => {
    const tl = createTimeline(null);
    if (tl.isAnimated) throw new Error("should be static");
    const p = tl.sample(1);
    if (Object.keys(p).length !== 0) throw new Error("patch should be empty");
});

ok("keyframes map to engine config keys", () => {
    const tl = createTimeline({
        duration: 10,
        loop: true,
        keyframes: [{
            property: "display.bloom.intensity",
            keys: [[0, 0.0], [10, 1.0]],
            easing: "linear"
        }]
    });
    const p = tl.sample(2.5);
    if (!approx(p.bloomIntensity, 0.25)) throw new Error(`bloomIntensity=${p.bloomIntensity}`);
});

ok("multi-track sampling (gamma + sigma)", () => {
    const tl = createTimeline({
        duration: 4,
        loop: true,
        keyframes: [
            { property: "display.gamma", keys: [[0, 1], [4, 3]], easing: "linear" },
            { property: "display.emitters.sigma.g", keys: [[0, 0.2], [4, 0.6]], easing: "linear" }
        ]
    });
    const p = tl.sample(2);
    if (!approx(p.emitterGamma, 2)) throw new Error("gamma");
    if (!approx(p.greenSigma, 0.4)) throw new Error("sigma");
});

ok("loop wraps sampled values", () => {
    const tl = createTimeline({
        duration: 4,
        loop: true,
        keyframes: [{ property: "display.gamma", keys: [[0, 1], [4, 3]], easing: "linear" }]
    });
    const p = tl.sample(6); // == t=2 after wrap
    if (!approx(p.emitterGamma, 2)) throw new Error("wrap sample");
});

ok("holds first/last values outside range when !loop", () => {
    const tl = createTimeline({
        duration: 4,
        loop: false,
        keyframes: [{ property: "display.spill", keys: [[1, 0.1], [3, 0.5]], easing: "linear" }]
    });
    if (!approx(tl.sample(0).opticalSpill, 0.1)) throw new Error("before");
    if (!approx(tl.sample(9).opticalSpill, 0.5)) throw new Error("after");
});

ok("smoothstep easing applied between keys", () => {
    const tl = createTimeline({
        duration: 2,
        loop: true,
        keyframes: [{ property: "display.gamma", keys: [[0, 0], [2, 1]], easing: "smoothstep" }]
    });
    // u=0.25 -> smoothstep=0.15625
    if (!approx(tl.sample(0.5).emitterGamma, 0.15625)) throw new Error("smoothstep");
});

// ------------------------------------------------------------------
console.log(`\ntimeline: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log(failures.map(f => "  FAIL " + f).join("\n"));
    process.exit(1);
}

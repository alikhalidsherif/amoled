// Scope rasterization golden tests (signal-lab-spec.md §13).
// Tiny buffers; verify the signal pipeline end to end.
import { parseAmo } from "../src/scene/parser.js";
import { rasterize } from "../src/scene/rasterizer.js";
import assert from "node:assert";

let passed = 0;
let failed = 0;
function ok(cond, name) {
    if (cond) { passed++; }
    else { failed++; console.log("FAIL:", name); }
}

const W = 64, H = 48;
const TAU = Math.PI * 2;

function scopeDef(rows, extra = {}) {
    return parseAmo({
        amo: 1,
        meta: { name: "t" },
        scene: { type: "scope", rows, ...extra }
    }, "http://x/").definition;
}

function render(definition, t, w = W, h = H) {
    return rasterize(definition, t, { width: w, height: h });
}

const SINE = { type: "trace", waveform: "sine", color: "#ff0000",
    amplitude: 0.25, frequency: 2, phaseOffset: 0, offset: 0.5, sweepSpeed: 0, thickness: 0.02 };

/** Peak column index of red in the buffer (argmax of R). */
function peakR(buf, w = W, h = H) {
    let best = -1, bestV = -1;
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            const v = buf[(y * w + x) * 3];
            if (v > bestV) { bestV = v; best = y; }
        }
    }
    return best;
}

function redAt(buf, x, y, w = W) { return buf[(y * w + x) * 3]; }

// 1. Sine trace with known amplitude/offset hits expected pixels.
//    offset 0.5, amplitude 0.25, 2 cycles, sweepSpeed 0. Waveform peak is at
//    x = 1/8 screen (p = pi/2) → y = 0.5 - 0.25 = 0.25 → yPix = H/4.
{
    const def = scopeDef([SINE]);
    const buf = render(def, 0);
    const xEighth = Math.floor(W / 8);
    let colPeak = -1, colV = -1;
    for (let y = 0; y < H; y++) {
        const v = redAt(buf, xEighth, y);
        if (v > colV) { colV = v; colPeak = y; }
    }
    ok(Math.abs(colPeak - H * 0.25) <= 2, `sine peak at y=0.25 (got ${colPeak}, want ~${H / 4})`);

    // Zero-crossing at x = 0: trace passes y = 0.5 (H/2).
    let colZero = -1, zeroV = -1;
    for (let y = 0; y < H; y++) {
        const v = redAt(buf, 0, y);
        if (v > zeroV) { zeroV = v; colZero = y; }
    }
    ok(Math.abs(colZero - H * 0.5) <= 2, `sine zero-crossing at center (got ${colZero}, want ~${H / 2})`);
}

// 2. sin(p) custom ≡ built-in sine (tolerance ±1 LSB).
{
    const builtin = scopeDef([{ ...SINE }]);
    const custom = scopeDef([{ ...SINE, waveform: "custom", expression: "sin(p)" }]);
    const b1 = render(builtin, 0);
    const c1 = render(custom, 0);
    let maxDiff = 0;
    for (let i = 0; i < b1.length; i++) maxDiff = Math.max(maxDiff, Math.abs(b1[i] - c1[i]));
    ok(maxDiff <= 1, `sin(p) matches built-in sine (maxDiff ${maxDiff})`);

    const b2 = render(builtin, 1.3);
    const c2 = render(custom, 1.3);
    let md2 = 0;
    for (let i = 0; i < b2.length; i++) md2 = Math.max(md2, Math.abs(b2[i] - c2[i]));
    ok(md2 <= 1, `sin(p) matches at t=1.3 (maxDiff ${md2})`);
}

// 3. Canonical three-phase: G ≡ R shifted by −2π/3, B by −4π/3.
//    A phase shift of Δp corresponds to a horizontal displacement of
//    Δx = −Δp / (2π·frequency) (fraction of screen width), with the trace
//    profile periodic over the screen (integer cycles). Verify via circular
//    shift invariance, channel-independently.
{
    // W chosen so 2π/3 of phase at f=2 is an exact pixel count:
    // shift = Δp/(2π·f)·W = (1/6)·192 = 32.
    const WS = 192, HS = 96;
    const mk = (phase, color, channel) => ({ ...SINE, color, channel, phaseOffset: phase });
    const profile = (buf, w, h) => {
        const out = [];
        for (let x = 0; x < w; x++) {
            let best = -1, bv = -1;
            for (let y = 0; y < h; y++) {
                const v = Math.max(buf[(y * w + x) * 3], buf[(y * w + x) * 3 + 1], buf[(y * w + x) * 3 + 2]);
                if (v > bv) { bv = v; best = y; }
            }
            out.push(best);
        }
        return out;
    };
    const circShiftDiff = (a, b, shift, w) => {
        let d = 0;
        for (let x = 0; x < w; x++) {
            const xb = ((x + shift) % w + w) % w;
            d = Math.max(d, Math.abs(a[x] - b[xb]));
        }
        return d;
    };
    const pr = profile(render(scopeDef([mk(0, "#ff0000", "r")]), 0.7, WS, HS), WS, HS);
    const pg = profile(render(scopeDef([mk(-TAU / 3, "#00ff00", "g")]), 0.7, WS, HS), WS, HS);
    const pb = profile(render(scopeDef([mk(-2 * TAU / 3, "#0000ff", "b")]), 0.7, WS, HS), WS, HS);
    const shiftG = 32, shiftB = 64;
    ok(circShiftDiff(pr, pg, shiftG, WS) <= 2, `G ≡ R shifted −2pi/3 (diff ${circShiftDiff(pr, pg, shiftG, WS)})`);
    ok(circShiftDiff(pr, pb, shiftB, WS) <= 2, `B ≡ R shifted −4pi/3 (diff ${circShiftDiff(pr, pb, shiftB, WS)})`);
    // Sanity: wrong shift must NOT match.
    ok(circShiftDiff(pr, pg, 8, WS) > 6, "wrong shift does not match (phase is real)");
}

// 4. Square/triangle/saw spot values at x = W/8 where p = pi/2.
//    square(pi/2)=1 → yPix = 0.25*H; triangle(pi/2)=1 → same; saw(pi/2)=0.5 →
//    y = 0.5 - 0.125 = 0.375 → yPix = 0.375*H.
{
    const xP = Math.floor(W / 8);
    const sq = scopeDef([{ ...SINE, waveform: "square" }]);
    const bufSq = render(sq, 0);
    let sqPeak = -1, sqV = -1;
    for (let y = 0; y < H; y++) {
        const v = redAt(bufSq, xP, y);
        if (v > sqV) { sqV = v; sqPeak = y; }
    }
    ok(Math.abs(sqPeak - H * 0.25) <= 2, `square peak at pi/2 (got ${sqPeak}, want ~${H * 0.25})`);

    const saw = scopeDef([{ ...SINE, waveform: "sawtooth" }]);
    const bufSaw = render(saw, 0);
    let sawPeak = -1, sawV = -1;
    for (let y = 0; y < H; y++) {
        const v = redAt(bufSaw, xP, y);
        if (v > sawV) { sawV = v; sawPeak = y; }
    }
    // saw(p) ramps -1..+1: saw(pi/2) = -0.5 → y = 0.5 + 0.125 = 0.625.
    ok(Math.abs(sawPeak - H * 0.625) <= 2, `saw at -0.5 when p=pi/2 (got ${sawPeak}, want ~${H * 0.625})`);

    const tri = scopeDef([{ ...SINE, waveform: "triangle" }]);
    const bufTri = render(tri, 0);
    let triPeak = -1, triV = -1;
    for (let y = 0; y < H; y++) {
        const v = redAt(bufTri, xP, y);
        if (v > triV) { triV = v; triPeak = y; }
    }
    ok(Math.abs(triPeak - H * 0.25) <= 2, `triangle peak at pi/2 (got ${triPeak})`);
}

// 5. Two traces overlap additively (same color, crossing point brighter than either alone).
{
    const a = scopeDef([{ ...SINE, phaseOffset: 0 }]);
    const both = scopeDef([{ ...SINE, phaseOffset: 0 }, { ...SINE, phaseOffset: 0 }]);
    const b1 = render(a, 0);
    const b2 = render(both, 0);
    // Compare peak intensity at the center column.
    const xC = Math.floor(W / 2);
    let v1 = 0, v2 = 0;
    for (let y = 0; y < H; y++) {
        v1 = Math.max(v1, redAt(b1, xC, y));
        v2 = Math.max(v2, redAt(b2, xC, y));
    }
    ok(v2 > v1 * 1.4, `overlap is additive (${v1} -> ${v2})`);
}

// 6. Background row renders under traces.
{
    const def = scopeDef([
        { type: "color", color: "#202020" },
        { ...SINE, sweepSpeed: 0 }
    ]);
    const buf = render(def, 0);
    // A corner pixel far from the trace should be the background, not black.
    const corner = buf[0]; // R at (0,0)
    ok(corner >= 0x1e && corner <= 0x22, `background visible under traces (corner R ${corner})`);
    ok(peakR(buf) !== -1, "trace still present over background");
}

// 7. Disabled trace invisible.
{
    const on = render(scopeDef([{ ...SINE }]), 0);
    const off = render(scopeDef([{ ...SINE, enabled: false }]), 0);
    let maxOn = 0, maxOff = 0;
    for (let i = 0; i < on.length; i++) {
        maxOn = Math.max(maxOn, on[i]);
        maxOff = Math.max(maxOff, off[i]);
    }
    ok(maxOn > 0, "enabled trace draws");
    ok(maxOff === 0, "disabled trace draws nothing");
}

// 8. Thickness scales with resolution (normalized units).
//    Integrated column intensity ∝ stroke radius: doubling the resolution
//    doubles rPx for the same normalized thickness.
{
    function columnSum(buf, w, h) {
        let s = 0;
        for (let y = 0; y < h; y++) s += buf[(y * w + 0) * 3];   // x=0 column
        return s;
    }
    const sSmall = columnSum(render(scopeDef([{ ...SINE }]), 0, 64, 48), 64, 48);
    const sBig = columnSum(render(scopeDef([{ ...SINE }]), 0, 128, 96), 128, 96);
    ok(sBig > sSmall * 1.4 && sBig < sSmall * 2.9,
        `thickness scales ~2x with resolution (${sSmall.toFixed(0)} -> ${sBig.toFixed(0)})`);
}

// 9. Motion: waveform actually travels with t (peak column shifts).
{
    const moving = scopeDef([{ ...SINE, sweepSpeed: 4 }]);
    const t0 = render(moving, 0);
    const t1 = render(moving, 0.2);
    // Compare buffers; they must differ meaningfully.
    let diffs = 0;
    for (let i = 0; i < t0.length; i++) if (Math.abs(t0[i] - t1[i]) > 8) diffs++;
    ok(diffs > 200, `trace moves with t (changed samples ${diffs})`);
}

// 10. verticalScale scales all traces' vertical positions.
{
    const base = render(scopeDef([{ ...SINE }]), 0);
    const scaled = render(scopeDef([{ ...SINE }], { verticalScale: 2 }), 0);
    // At x=W/8 sig=1: base yPix=H/4, scaled yPix = 0 (full deflection to top).
    const xP = Math.floor(W / 8);
    const peakAt = (buf) => {
        let pk = -1, pv = -1;
        for (let y = 0; y < H; y++) {
            const v = redAt(buf, xP, y);
            if (v > pv) { pv = v; pk = y; }
        }
        return pk;
    };
    const pkBase = peakAt(base), pkScaled = peakAt(scaled);
    ok(pkScaled < pkBase - 4, `verticalScale amplifies deflection (${pkBase} -> ${pkScaled})`);
}

// 11. Determinism: same scene + t => identical bytes.
{
    const def = scopeDef([{ ...SINE, sweepSpeed: 2 }]);
    const a = render(def, 1.234);
    const b = render(def, 1.234);
    let same = true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
    ok(same, "deterministic output");
}

// 12. Parameters resolve inside trace E-values and custom expressions.
{
    const def = parseAmo({
        amo: 1,
        meta: { name: "params" },
        parameters: { amp: { value: 0.4 }, fr: { value: 3 } },
        scene: {
            type: "scope",
            rows: [
                { type: "trace", waveform: "custom", expression: "sin(p*fr/2)",
                  color: "#ff0000", amplitude: 0.25, offset: 0.5, sweepSpeed: 0, frequency: 2 }
            ]
        }
    }, "http://x/").definition;
    // fr=3 doubles effective frequency (2*3/2=3): peak at x where
    // p = 2*pi*2*x*(3/2) = pi/2 → x = 1/12 → xPix = W/12.
    const buf = render(def, 0);
    const xPeak = Math.round(W / 12);
    let colPeak = -1, colV = -1;
    for (let y = 0; y < H; y++) {
        const v = redAt(buf, xPeak, y);
        if (v > colV) { colV = v; colPeak = y; }
    }
    ok(Math.abs(colPeak - 12) <= 2, `parameter in custom expression works (peak ${colPeak} at x=W/12)`);
}

console.log(`scope-raster: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

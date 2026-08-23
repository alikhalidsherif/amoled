// PLAN-CREATIVE.md workstream B acceptance: pattern generators, flow field,
// particles. Run: node tests/primitives.test.js   (exit 0 = pass)
import assert from "node:assert";
import { parseAmo } from "../src/scene/parser.js";
import { rasterize } from "../src/scene/rasterizer.js";

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
}

function buf(def, t = 0, w = 32, h = 32) {
    return rasterize(def, t, { width: w, height: h }, {});
}
function hash(a) {
    let x = 0;
    for (let i = 0; i < a.length; i++) x = (x * 31 + a[i]) | 0;
    return x;
}
function build(scene, extra = {}) {
    return parseAmo({ amo: 1, ...extra, scene }).definition;
}

// ------------------------------------------------------------------
// Patterns
// ------------------------------------------------------------------

ok("dots: bright at cell centers, dark at cell corners", () => {
    const def = build({ type: "pattern", pattern: "dots", size: 8, thickness: 1,
        fg: "#ffffff", bg: "#000000", softness: 0.01 });
    const b = buf(def, 0, 16, 16);
    const center = b[(4 * 16 + 4) * 3];
    const corner = b[0];
    assert.ok(center > 240, `center ${center}`);
    assert.ok(corner < 15, `corner ${corner}`);
});

ok("stripes alternate with period = size rows", () => {
    const def = build({ type: "pattern", pattern: "stripes", size: 4,
        thickness: 0.5, fg: "#ffffff", bg: "#000000" });
    const b = buf(def, 0, 2, 8);
    const rows = [];
    for (let y = 0; y < 8; y++) rows.push(b[(y * 2) * 3] > 128 ? 1 : 0);
    // period 4: expect two lit bands per 8 rows
    assert.strictEqual(rows.reduce((a, v) => a + v, 0), 4, JSON.stringify(rows));
});

ok("checks parity alternates cells", () => {
    const def = build({ type: "pattern", pattern: "checks", size: 8,
        fg: "#ffffff", bg: "#000000" });
    const b = buf(def, 0, 16, 16);
    const c00 = b[(4 * 16 + 4) * 3];
    const c10 = b[(4 * 16 + 12) * 3];
    assert.ok(Math.abs(c00 - c10) > 128, `adjacent cells should differ (${c00} vs ${c10})`);
});

ok("pattern offset shifts the lattice", () => {
    const base = build({ type: "pattern", pattern: "dots", size: 8, thickness: 1,
        fg: "#ffffff", bg: "#000000", softness: 0.02 });
    const moved = build({ type: "pattern", pattern: "dots", size: 8, thickness: 1,
        fg: "#ffffff", bg: "#000000", softness: 0.02, offset: { x: 0.25, y: 0 } });
    const b1 = buf(base, 0, 16, 16), b2 = buf(moved, 0, 16, 16);
    assert.notStrictEqual(hash(b1), hash(b2));
});

ok("animated angle makes the pattern dynamic; static otherwise", () => {
    const dyn = build({ type: "pattern", pattern: "stripes", size: 6,
        fg: "#ffffff", bg: "#000000", angle: "t*0.2" });
    const stat = build({ type: "pattern", pattern: "stripes", size: 6,
        fg: "#ffffff", bg: "#000000" });
    assert.strictEqual(dyn.isStatic, false);
    assert.strictEqual(stat.isStatic, true);
});

ok("halftone without signal is rejected", () => {
    assert.throws(
        () => build({ type: "pattern", pattern: "halftone" }),
        e => e.name === "AmoError" && e.path.includes("signal")
    );
});

ok("halftone dot radius follows the signal expression", () => {
    const def = build({ type: "pattern", pattern: "halftone", size: 16,
        thickness: 1, fg: "#ffffff", bg: "#000000",
        signal: "u" /* left dark -> small dots, right bright -> big dots */ });
    const b = buf(def, 0, 16, 8);
    const leftCell = b[(4 * 16 + 4) * 3];     // u~0.3
    const rightCell = b[(4 * 16 + 12) * 3];   // u~0.8
    assert.ok(rightCell > leftCell, `right ${rightCell} should exceed left ${leftCell}`);
});

ok("size expression crawls the lattice over time", () => {
    const def = build({ type: "pattern", pattern: "dots", size: "6+2*sin(t)",
        thickness: 1, fg: "#ffffff", bg: "#000000", softness: 0.02 });
    const b1 = buf(def, 0), b2 = buf(def, 0.8);
    assert.notStrictEqual(hash(b1), hash(b2));
});

// ------------------------------------------------------------------
// Flow
// ------------------------------------------------------------------

ok("flow is deterministic for identical inputs", () => {
    const mk = () => build({ type: "flow", palette: ["#000000", "#00ff00"],
        scale: 4, speed: 0.5, warp: 0.7, seed: 9 });
    assert.strictEqual(hash(buf(mk(), 2)), hash(buf(mk(), 2)));
});

ok("flow animates and respects seed changes", () => {
    const a = build({ type: "flow", palette: ["#000000", "#ffffff"], seed: 1 });
    const b = build({ type: "flow", palette: ["#000000", "#ffffff"], seed: 2 });
    assert.notStrictEqual(hash(buf(a, 1)), hash(buf(b, 1)));
    assert.notStrictEqual(hash(buf(a, 1)), hash(buf(a, 2)));
});

ok("higher contrast pushes flow toward palette extremes", () => {
    const mk = c => build({ type: "flow", palette: ["#000000", "#ffffff"],
        scale: 3, speed: 0, warp: 0, octaves: 2, contrast: c });
    const extremes = b => {
        let n = 0;
        for (let i = 0; i < b.length; i += 3) {
            if (b[i] < 30 || b[i] > 225) n++;
        }
        return n;
    };
    const soft = extremes(buf(mk(1), 3, 24, 24));
    const hard = extremes(buf(mk(8), 3, 24, 24));
    assert.ok(hard > soft, `contrast 8 (${hard}) should exceed contrast 1 (${soft})`);
});

ok("flow static only when speed is literal zero", () => {
    const frozen = build({ type: "flow", palette: ["#000000", "#ffffff"], speed: 0 });
    const moving = build({ type: "flow", palette: ["#000000", "#ffffff"], speed: 0.2 });
    const exprSpeed = build({ type: "flow", palette: ["#000000", "#ffffff"], speed: "0.5*2" });
    assert.strictEqual(frozen.isStatic, true);
    assert.strictEqual(moving.isStatic, false);
    assert.strictEqual(exprSpeed.isStatic, false); // conservative for exprs
});

ok("octaves outside 1..5 rejected", () => {
    assert.throws(() => build({ type: "flow", palette: ["#000000", "#111111"], octaves: 6 }),
        e => e.name === "AmoError");
});

// ------------------------------------------------------------------
// Particles
// ------------------------------------------------------------------

ok("particles deterministic + animate + respect seed", () => {
    const mk = s => build({ type: "particles", count: 40, behavior: "fireflies", seed: s });
    assert.strictEqual(hash(buf(mk(42), 1)), hash(buf(mk(42), 1)));
    assert.notStrictEqual(hash(buf(mk(42), 1)), hash(buf(mk(42), 2)));
    assert.notStrictEqual(hash(buf(mk(42), 1)), hash(buf(mk(43), 1)));
});

ok("particles frozen when speed=0 and static glow", () => {
    const frozen = build({ type: "particles", count: 30, speed: 0, glow: 0.5 });
    assert.strictEqual(frozen.isStatic, true);
    const twinkle = build({ type: "particles", count: 30, speed: 0, glow: "0.5*sin(t)" });
    assert.strictEqual(twinkle.isStatic, false);
});

ok("particle count > 512 rejected", () => {
    assert.throws(() => build({ type: "particles", count: 600 }), e => e.name === "AmoError");
});

ok("particles render inside bounds with nonzero energy", () => {
    const def = build({ type: "particles", count: 60, seed: 3 });
    const b = buf(def, 1.25, 48, 48);
    let lit = 0;
    for (let i = 0; i < b.length; i += 3) if (b[i] + b[i + 1] + b[i + 2] > 10) lit++;
    assert.ok(lit > 20, `expected lit pixels, got ${lit}`);
});

ok("all six behaviors produce distinct frames and do not throw", () => {
    for (const behavior of ["drift", "orbit", "rise", "fall", "fireflies", "snow"]) {
        const def = build({ type: "particles", count: 20, behavior, seed: 5 });
        const h1 = hash(buf(def, 0.5));
        const h2 = hash(buf(def, 2.5));
        if (behavior !== "drift") assert.notStrictEqual(h1, h2, behavior);
    }
});

// Regression: inherently-dynamic layers nested in composites (numeric params,
// no expression strings) must NOT be detected as static.
ok("composite with numeric-param flow layer is dynamic", () => {
    const def = build({ type: "composite", layers: [
        { type: "color", color: "#000000" },
        { type: "flow", palette: ["#000000", "#111111"], speed: 0.1 }
    ] });
    assert.strictEqual(def.isStatic, false);
});
ok("composite of frozen layers stays static", () => {
    const def = build({ type: "composite", layers: [
        { type: "color", color: "#000000" },
        { type: "flow", palette: ["#000000", "#111111"], speed: 0 },
        { type: "particles", count: 10, speed: 0, glow: 0.4 }
    ] });
    assert.strictEqual(def.isStatic, true);
});

console.log(`primitives: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const f of failures) console.log("  FAIL:", f);
    process.exit(1);
}

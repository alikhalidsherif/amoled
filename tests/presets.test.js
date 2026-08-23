// PLAN-CREATIVE.md Workstream C acceptance: motion presets.
// Run: node tests/presets.test.js   (exit 0 = pass)
import assert from "node:assert";
import { applyPreset, listPresets } from "../src/scene/presets.js";
import { parseAmo } from "../src/scene/parser.js";
import { rasterize } from "../src/scene/rasterizer.js";

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
}

ok("listPresets exposes name/description/params for every preset", () => {
    const all = listPresets();
    assert.ok(all.length >= 10, `expected >=10 presets, got ${all.length}`);
    for (const p of all) {
        assert.ok(p.name && p.description && p.params, JSON.stringify(p.name));
        assert.ok(Array.isArray(p.targets));
    }
});

ok("pulse generates a valid animating opacity expression", () => {
    const f = applyPreset({ type: "color", color: "#ffffff" }, "pulse",
        { base: 0.6, amp: 0.3, rate: 2 });
    assert.strictEqual(typeof f.opacity, "string");
    const def = parseAmo({
        amo: 1,
        scene: { type: "composite", layers: [
            { type: "color", color: "#000000" },
            { ...f, blend: "add" }
        ] }
    }).definition;
    const b = (t) => rasterize(def, t, { width: 4, height: 4 }, {});
    assert.notStrictEqual(hash(b(0)), hash(b(1)));
    // idempotence: applying twice does not stack
    const g = applyPreset(f, "pulse", { base: 0.6, amp: 0.3, rate: 2 });
    assert.strictEqual(g.opacity, f.opacity);
});

ok("orbit writes paired x/y offset expressions", () => {
    const f = applyPreset({}, "orbit", { radius: 0.05, rate: 1 });
    assert.strictEqual(typeof f.offset.x, "string");
    assert.ok(f.offset.x.includes("sin"));
    assert.ok(f.offset.y.includes("cos"));
});

ok("sway drives rotation", () => {
    const f = applyPreset({}, "sway", {});
    assert.strictEqual(typeof f.rotation, "string");
    assert.ok(f.rotation.includes("sin(t"));
});

ok("wave targets livingGradient wobble", () => {
    const frag = {
        type: "livingGradient",
        stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#ffffff" }]
    };
    const f = applyPreset(frag, "wave", {});
    assert.strictEqual(typeof f.wobble, "string");
    // still parses + renders
    const def = parseAmo({ amo: 1, scene: f }).definition;
    rasterize(def, 0.5, { width: 8, height: 8 }, {});
});

ok("shimmer wraps expression-layer channels with noise", () => {
    const f = applyPreset({ type: "expression", r: "u", g: "v", b: "0.5" },
        "shimmer", { amount: 0.1 });
    for (const c of ["r", "g", "b"]) {
        assert.ok(typeof f[c] === "string" && f[c].includes("noise"), c);
        assert.ok(f[c].startsWith("clamp("), "wrapped in clamp");
    }
    // renders through the real pipeline
    const def = parseAmo({ amo: 1, scene: f }).definition;
    rasterize(def, 1, { width: 16, height: 16 }, {});
    assert.strictEqual(def.isStatic, false);
});

ok("flicker multiplies opacity within clamp", () => {
    const f = applyPreset({ type: "color", color: "#ffffff" }, "flicker", {});
    assert.ok(f.opacity.startsWith("clamp("));
});

ok("hueDrift converts hex stops to channel expressions on gradients", () => {
    const f = applyPreset({
        type: "gradient", from: "#ff0000", to: "#00ff00"
    }, "hueDrift", { depth: 0.2, rate: 0.5 });
    assert.strictEqual(typeof f.from.r, "string");
    assert.ok(f.from.r.startsWith("1.0000 - "), `red stop should start from its own value, got ${f.from.r}`);
    const def = parseAmo({ amo: 1, scene: f }).definition;
    const b = rasterize(def, 0.7, { width: 4, height: 4 }, {});
    assert.ok(b.length === 48);
});

ok("unknown preset and unknown params throw", () => {
    assert.throws(() => applyPreset({}, "nope"));
    assert.throws(() => applyPreset({}, "pulse", { bogus: 1 }));
});

ok("every preset output parses+validates through the real pipeline", () => {
    const samples = [
        ["pulse", { type: "color", color: "#fff" }],
        ["breathe", { type: "color", color: "#fff", rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }],
        ["driftX", { type: "color", color: "#fff" }],
        ["driftY", { type: "color", color: "#fff" }],
        ["orbit", { type: "color", color: "#fff" }],
        ["sway", { type: "color", color: "#fff" }],
        ["scan", { type: "pattern", pattern: "dots", size: 6 }],
        ["zoomPulse", { type: "color", color: "#fff" }]
    ];
    for (const [name, frag] of samples) {
        const layer = applyPreset(JSON.parse(JSON.stringify(frag)), name, {});
        const def = parseAmo({
            amo: 1,
            scene: { type: "composite", layers: [{ type: "color", color: "#000000" }, layer] }
        }).definition;
        rasterize(def, 1.3, { width: 12, height: 12 }, {});
    }
});

function hash(a) {
    let x = 0;
    for (let i = 0; i < a.length; i++) x = (x * 31 + a[i]) | 0;
    return x;
}

console.log(`presets: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const f of failures) console.log("  FAIL:", f);
    process.exit(1);
}

// PLAN-CREATIVE.md workstream A acceptance: E-value slots, rotation,
// livingGradient, animated gradients, centralized static detection.
// Run: node tests/evalue.test.js   (exit 0 = pass)
import assert from "node:assert";
import { parseAmo } from "../src/scene/parser.js";
import { rasterize } from "../src/scene/rasterizer.js";
import { compileColorSlot, collectExpressions, treeReferencesTime } from "../src/scene/evalue.js";

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
}

const px = (def, x, y, w = 4, h = 4) => {
    const buf = rasterize(def, def.__t || 0, { width: w, height: h }, {});
    const i = (y * w + x) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
};

// ------------------------------------------------------------------
// E-value color slots
// ------------------------------------------------------------------

ok("gradient channel expression animates over time", () => {
    const def = parseAmo({
        amo: 1,
        scene: { type: "gradient", from: { r: 0, g: 0, b: 0 },
                 to: { r: "0.5+0.5*sin(t)", g: 0, b: 0 } }
    }).definition;
    // vertical gradient: bottom row (y=3) is tt≈1
    // t=3*pi/2 -> sin=-1 -> channel 0 (black); t=pi/2 -> channel 1 (max)
    const atLow = px({ ...def, __t: 3 * Math.PI / 2 }, 0, 3)[0];
    const atHigh = px({ ...def, __t: Math.PI / 2 }, 0, 3)[0];
    assert.ok(atLow < 40, `sin=-1 should be near black, got ${atLow}`);
    assert.ok(atHigh > 200, `sin=1 should be near max, got ${atHigh}`);
});

ok("mixed constant+expression gradient channels clamp", () => {
    const c = compileColorSlot({ r: "2", g: -1, b: "0.25" });
    const v = c.eval(0, 0, { t: 0 });
    assert.strictEqual(v.r, 1);   // clamped high
    assert.strictEqual(v.g, 0);   // literal clamped low
    assert.strictEqual(v.b, 0.25);
});

ok("color type accepts channel expressions", () => {
    const def = parseAmo({
        amo: 1,
        scene: { type: "color", color: { r: "0.5+0.5*sin(t*1.5707963)", g: 0.1, b: 0 } }
    }).definition;
    assert.ok(px({ ...def, __t: 3 }, 1, 1)[0] < 40);
    assert.ok(px({ ...def, __t: 1 }, 1, 1)[0] > 200);
});

ok("constant expressions do NOT force animation (static stays static)", () => {
    const def = parseAmo({
        amo: 1,
        scene: { type: "color", color: { r: "2+2", g: 0, b: 0 } }
    }).definition;
    assert.strictEqual(def.isStatic, true);
});

// ------------------------------------------------------------------
// livingGradient
// ------------------------------------------------------------------

ok("livingGradient interpolates stops", () => {
    const def = parseAmo({
        amo: 1,
        scene: {
            type: "livingGradient",
            stops: [
                { at: 0, color: "#000000" },
                { at: 0.5, color: "#808080" },
                { at: 1, color: "#ffffff" }
            ]
        }
    }).definition;
    const buf = rasterize(def, 0, { width: 4, height: 8 }, {});
    const top = buf[0];                    // y=0 -> stop0
    const mid = buf[(3 * 4) * 3];          // y=3 (~0.43) between stops
    const bot = buf[(7 * 4) * 3];          // y=7 -> last stop
    assert.ok(top <= 2, `top ${top}`);
    assert.ok(bot >= 253, `bottom ${bot}`);
    assert.ok(mid > 60 && mid < 190, `mid ${mid}`);
});

ok("livingGradient unsorted stops are sorted with a warning", () => {
    const { definition, warnings } = parseAmo({
        amo: 1,
        scene: {
            type: "livingGradient",
            stops: [
                { at: 1, color: "#ffffff" },
                { at: 0, color: "#000000" }
            ]
        }
    });
    assert.ok(warnings.some(w => w.includes("unsorted")), warnings.join(";"));
    const top = rasterize(definition, 0, { width: 2, height: 2 }, {})[0];
    assert.ok(top <= 2, "sorted first stop should be black at top");
});

ok("livingGradient wobble displaces the axis", () => {
    const base = parseAmo({
        amo: 1, scene: { type: "livingGradient",
            stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#ffffff" }] }
    }).definition;
    const wob = parseAmo({
        amo: 1, scene: { type: "livingGradient",
            stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#ffffff" }],
            wobble: 0.2 }
    }).definition;
    // At the exact middle column of a tall buffer wobble shifts brightness.
    const bMid = rasterize(base, 0, { width: 2, height: 64 }, {})[(32 * 2) * 3];
    const wMid = rasterize(wob, 0, { width: 2, height: 64 }, {})[(32 * 2) * 3];
    assert.notStrictEqual(bMid, wMid, "wobble should change mid brightness");
});

ok("animated livingGradient is detected as dynamic; constant one static", () => {
    const dyn = parseAmo({
        amo: 1, scene: { type: "livingGradient",
            stops: [{ at: 0, color: "#000000" },
                    { at: 1, color: { r: "sin(t)", g: 0, b: 0 } }] }
    }).definition;
    const stat = parseAmo({
        amo: 1, scene: { type: "livingGradient",
            stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#ffffff" }] }
    }).definition;
    assert.strictEqual(dyn.isStatic, false);
    assert.strictEqual(stat.isStatic, true);
});

// ------------------------------------------------------------------
// Layer E-values + rotation
// ------------------------------------------------------------------

ok("layer opacity expression pulses", () => {
    const mk = () => parseAmo({
        amo: 1,
        scene: {
            type: "composite",
            layers: [
                { type: "color", color: "#000000" },
                { type: "color", color: "#ffffff", blend: "add",
                  opacity: "0.5+0.5*sin(t*1.5707963)" }
            ]
        }
    }).definition;
    // t=3 -> sin(3*pi/2) = -1 -> opacity clamps to 0
    assert.ok(px({ ...mk(), __t: 3 }, 2, 2)[0] < 10);
    // t=1 -> sin(pi/2) = 1 -> opacity 1
    assert.ok(px({ ...mk(), __t: 1 }, 2, 2)[0] > 200);
});

ok("90-degree layer rotation maps the band correctly", () => {
    // Left-half red rect rotated +pi/2 becomes a horizontal band across
    // the vertical middle (forward transform R(+theta) about center).
    const def = parseAmo({
        amo: 1,
        scene: {
            type: "composite",
            layers: [
                { type: "color", color: "#000000" },
                { type: "color", color: "#ff0000", rect: { x: 0, y: 0, w: 0.5, h: 1 },
                  rotation: 1.5707963267948966 }
            ]
        }
    }).definition;
    const buf = rasterize(def, 0, { width: 4, height: 4 }, {});
    const mid = (1 * 4 + 1) * 3;   // inside rotated band
    const tl = buf[0], br = buf[(3 * 4 + 3) * 3];
    assert.ok(buf[mid] > 200, `band pixel should be red (got ${buf[mid]})`);
    assert.ok(tl > 200, `top-left inside rotated band should be red (got ${tl})`);
    assert.ok(br < 20, `bottom-right corner should be black (got ${br})`);
});

ok("layer scale expression breathes without error", () => {
    const def = parseAmo({
        amo: 1,
        scene: {
            type: "composite",
            layers: [
                { type: "color", color: "#202020" },
                { type: "color", color: "#ff8000", rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
                  scale: "1 + 0.5*sin(t)" }
            ]
        }
    }).definition;
    rasterize(def, 0, { width: 8, height: 8 }, {});
    rasterize(def, 1.57, { width: 8, height: 8 }, {});
});

ok("offset expression drifts a layer", () => {
    const def = parseAmo({
        amo: 1,
        scene: {
            type: "composite",
            layers: [
                { type: "color", color: "#000000" },
                { type: "color", color: "#00ff00", rect: { x: "0.75*t*0.6366", y: 0, w: 0.25, h: 1 } }
            ]
        }
    }).definition;
    // t=pi/2 -> offset.x ~0.75 -> green lands on right quarter.
    const buf = rasterize({ ...def, __t: Math.PI / 2 }, Math.PI / 2, { width: 8, height: 4 }, {});
    const left = buf[(2 * 8) * 3 + 1], right = buf[(2 * 8 + 6) * 3 + 1];
    assert.ok(left < 20, `left black (got ${left})`);
    assert.ok(right > 200, `right green (got ${right})`);
});

// ------------------------------------------------------------------
// Static detection centralization
// ------------------------------------------------------------------

ok("static matrix across types", () => {
    const cases = [
        [{ type: "color", color: "#123456" }, true],
        [{ type: "gradient", from: "#000000", to: "#ffffff" }, true],
        [{ type: "image", asset: "x" }, true],
        [{ type: "pattern", pattern: "dots" }, true],
        [{ type: "expression", r: "u", g: "v", b: "0.1" }, true],
        [{ type: "expression", r: "sin(t)", g: "0", b: "0" }, false],
        [{ type: "gif", asset: "x" }, false],
        [{ type: "video", asset: "x" }, false],
        [{ type: "composite", layers: [
            { type: "color", color: "#111111" },
            { type: "color", color: "#222222", opacity: "0.5*sin(t)" }
        ] }, false]
    ];
    for (const [scene, expect] of cases) {
        const assets = { x: "file:///x.png" };
        if (scene.asset) assets[scene.asset] = "file:///x.png";
        const def = parseAmo({ amo: 1, scene, assets }).definition;
        assert.strictEqual(def.isStatic, expect, JSON.stringify(scene));
    }
});

// ------------------------------------------------------------------
// collectExpressions walker
// ------------------------------------------------------------------

ok("collectExpressions finds nested strings, skips hex and meta fields", () => {
    const found = collectExpressions({
        type: "composite",
        layers: [{
            type: "gradient", direction: "vertical",
            from: { r: "sin(t)", g: "#00ff00", b: 0 },
            to: "#ffffff"
        }]
    });
    const sources = found.map(f => f.source);
    assert.ok(sources.includes("sin(t)"), JSON.stringify(found));
    assert.strictEqual(sources.length, 1, JSON.stringify(found));
});

ok("treeReferencesTime false for pure constants", () => {
    assert.strictEqual(treeReferencesTime({ opacity: "2+2", scale: "3*4" }), false);
});

// ------------------------------------------------------------------
// Validation rejections
// ------------------------------------------------------------------

ok("invalid expression string in numeric slot is rejected with path context", () => {
    assert.throws(
        () => parseAmo({ amo: 1, scene: { type: "composite", layers: [
            { type: "color", color: "#000000", opacity: "sin(" } ] } }),
        e => e.name === "AmoError" && e.path.includes("opacity")
    );
});

ok("invalid channel expression rejected with path context", () => {
    assert.throws(
        () => parseAmo({ amo: 1, scene: { type: "gradient",
            from: { r: "bogus(", g: 0, b: 0 }, to: "#fff" } }),
        e => e.name === "AmoError" && e.path.includes("from.r")
    );
});

console.log(`evalue: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const f of failures) console.log("  FAIL:", f);
    process.exit(1);
}

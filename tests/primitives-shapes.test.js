// Visual primitives acceptance (PLAN_GENERATOR_OVERHAUL.md §9/§10/§14):
// shape (circle/ring/rect/line as moving emitters), conicGradient, waves,
// grid pattern variant. Golden-value style checks on small logical grids.

import { strict as assert } from "node:assert";
import { validateAndNormalize } from "../src/scene/validator.js";
import { rasterize } from "../src/scene/rasterizer.js";

let passed = 0, failed = 0;
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

function makeDef(scene, params) {
    const raw = {
        amo: 1,
        quality: { logicalResolution: { width: 64, height: 64 }, fps: 30 },
        scene
    };
    if (params) raw.parameters = params;
    return validateAndNormalize(raw).definition;
}

function probe(def, w, h, x, y, t = 0) {
    const out = rasterize(def, t, { width: w, height: h });
    const i = (y * w + x) * 3;
    return [out[i], out[i + 1], out[i + 2]];
}

ok("circle: bright center, dark corner, aspect-correct", () => {
    const def = makeDef({ type: "shape", kind: "circle", cx: 0.5, cy: 0.5, r: 0.25, softness: 0.01 });
    const [r] = probe(def, 64, 32, 32, 16);
    assert.ok(r > 240, `center r=${r}`);
    const [rc] = probe(def, 64, 32, 2, 2);
    assert.ok(rc < 10, `corner r=${rc}`);
});

ok("ring: dark hole, bright band, dark outside", () => {
    const def = makeDef({ type: "shape", kind: "ring", cx: 0.5, cy: 0.5, innerR: 0.15, outerR: 0.25 });
    const [, , bHole] = probe(def, 80, 40, 40, 20);
    assert.ok(bHole < 10, `hole b=${bHole}`);
    const [rBand] = probe(def, 80, 40, 40 + Math.round(0.2 * 40), 20);
    assert.ok(rBand > 200, `band r=${rBand}`);
    const [rOut] = probe(def, 80, 40, 4, 2);
    assert.ok(rOut < 10, `outside r=${rOut}`);
});

ok("rect: inside/outside", () => {
    const def = makeDef({ type: "shape", kind: "rect", cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 });
    const [rin] = probe(def, 64, 64, 32, 32);
    assert.ok(rin > 240);
    const [rout] = probe(def, 64, 64, 4, 4);
    assert.ok(rout < 10);
});

ok("line: bright on segment, dark away", () => {
    const def = makeDef({ type: "shape", kind: "line", x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5, thickness: 0.02 });
    // 65x65 grid so u,v hit 0.25/0.5 exactly
    const out = rasterize(def, 0, { width: 65, height: 65 });
    const rmid = out[(32 * 65 + 32) * 3];
    assert.ok(rmid > 220, `mid=${rmid}`);
    const rfar = out[(8 * 65 + 32) * 3];
    assert.ok(rfar < 10, `far=${rfar}`);
});

ok("moving emitter: animated cx makes scene dynamic and deterministic", () => {
    const def = makeDef({
        type: "shape", kind: "circle", cx: "0.5 + 0.25*cos(t*2)", cy: 0.5, r: 0.1
    });
    assert.equal(def.isStatic, false);
    const a = rasterize(def, 1.234, { width: 48, height: 24 });
    const b = rasterize(def, 1.234, { width: 48, height: 24 });
    assert.deepEqual([...b], [...a]);
    // emitter actually moved: frame at t differs from t+pi/2
    const c = rasterize(def, 1.234 + Math.PI / 4, { width: 48, height: 24 });
    assert.ok(JSON.stringify([...a]) !== JSON.stringify([...c]));
});

ok("conic gradient: sweep from +u axis counterclockwise in math terms", () => {
    const def = makeDef({ type: "conicGradient", cx: 0.5, cy: 0.5, angle: 0, from: "#000000", to: "#ffffff" });
    const [rright] = probe(def, 96, 48, 92, 24);   // u≈0.97,v=0.5 -> ang≈0 -> ~black
    assert.ok(rright < 30, `right r=${rright}`);
    const [rleft] = probe(def, 96, 48, 4, 24);     // ang≈±pi -> |tt|≈0.5 or wrap -> grayish/white
    assert.ok(rleft > 60, `left r=${rleft}`);
});

ok("waves: zero amplitude flattens to half mix; analytic value matches", () => {
    const flat = makeDef({ type: "waves", wavelength: 0.25, amplitude: 0, speed: 0, color: "#ffffff", bg: "#000000" });
    const [rv] = probe(flat, 64, 64, 10, 10);
    assert.ok(Math.abs(rv - 128) <= 2, `flat=${rv}`);

    const def = makeDef({ type: "waves", wavelength: 1, amplitude: 1, speed: 0, angle: 0, phase: 0, color: "#ffffff", bg: "#000000" });
    // height-normalized: proj = u*(w/h). At u=0.25 (x=16 on 65-wide grid): proj=0.25
    const out = rasterize(def, 0, { width: 65, height: 65 });
    const expected = Math.round(255 * (0.5 + 0.5 * Math.sin(0.25 * Math.PI * 2)));
    assert.ok(Math.abs(out[(16 * 65 + 16) * 3] - expected) <= 2,
        `${out[(16 * 65 + 16) * 3]} vs ${expected}`);
});

ok("grid pattern variant: border lines bright, cell centers dark", () => {
    const def = makeDef({ type: "pattern", pattern: "grid", size: 16, thickness: 0.2, fg: "#ffffff", bg: "#000000" });
    const out = rasterize(def, 0, { width: 64, height: 64 });
    const border = out[(0 * 64 + 0) * 3];          // corner = intersection of two lines
    assert.ok(border > 200, `border=${border}`);
    const center = out[(8 * 64 + 8) * 3];          // cell interior
    assert.ok(center < 10, `center=${center}`);
});

ok("shape with parameters drives geometry", () => {
    const def = makeDef(
        { type: "shape", kind: "circle", cx: "cxp", cy: 0.5, r: "rad", softness: 0.01 },
        { cxp: { value: 0.25 }, rad: { value: 0.2 } }
    );
    const [ron] = probe(def, 64, 64, 16, 32);
    assert.ok(ron > 240, `on-circle=${ron}`);
    const [roff] = probe(def, 64, 64, 48, 32);
    assert.ok(roff < 10, `off-circle=${roff}`);
});

console.log(`primitives-shapes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Named scene parameters (PLAN_GENERATOR_OVERHAUL.md §7/§8).
// Covers: format validation, expression resolution, static detection,
// CPU rasterization equivalence, round-trip serialization, GLSL mapping.

import { strict as assert } from "node:assert";
import { validateAndNormalize } from "../src/scene/validator.js";
import { compileToGLSL, isReservedName, isValidParamName } from "../src/scene/expression.js";
import { resolveParameterValues, makeEnv } from "../src/scene/evalue.js";
import { rasterize } from "../src/scene/rasterizer.js";

let passed = 0, failed = 0;
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

const BASE = {
    amo: 1,
    meta: { name: "params-test" },
    quality: { logicalResolution: { width: 64, height: 64 }, fps: 30 },
    timeline: { duration: 4, loop: true },
    scene: {
        type: "expression",
        r: "0",
        g: "0",
        b: "0"
    }
};

ok("shorthand numeric parameter resolves in expressions", () => {
    const def = validateAndNormalize({
        ...BASE,
        parameters: { amp: 0.5 },
        scene: { type: "expression", r: "amp", g: "0", b: "0" }
    }).definition;
    assert.equal(def.isStatic, true);
    const out = rasterize(def, 0, { width: 4, height: 2 });
    // amp=0.5 -> byte ~127.5 (float path rounds via Uint8ClampedArray)
    assert.ok(out[0] >= 126 && out[0] <= 129, `expected ~128, got ${out[0]}`);
});

ok("parameter expressions evaluate per frame", () => {
    const def = validateAndNormalize({
        ...BASE,
        parameters: { amp: "0.5 + 0.5*sin(t)" },
        scene: { type: "expression", r: "amp", g: "0", b: "0" }
    }).definition;
    // animated parameter => non-static even though scene expr has no t
    assert.equal(def.isStatic, false);
    const env = makeEnv(0.5 * Math.PI, 4, 2, 30, 4);
    const vals = resolveParameterValues(def.parameters, env);
    assert.ok(Math.abs(vals.amp - 1) < 1e-9);
});

ok("unknown identifier still rejected when not declared", () => {
    assert.throws(() => validateAndNormalize({
        ...BASE,
        scene: { type: "expression", r: "amp", g: "0", b: "0" }
    }), /unknown identifier "amp"/);
});

ok("reserved / malformed parameter names rejected", () => {
    assert.throws(() => validateAndNormalize({ ...BASE, parameters: { t: 1 } }), /reserved/);
    assert.throws(() => validateAndNormalize({ ...BASE, parameters: { sin: 1 } }), /reserved/);
    assert.throws(() => validateAndNormalize({ ...BASE, parameters: { "2bad": 1 } }), /identifier/);
});

ok("invalid parameter value expression rejected", () => {
    assert.throws(() => validateAndNormalize({
        ...BASE, parameters: { amp: "1 +" }
    }), /invalid expression/);
});

ok("slider metadata (min/max/step) normalized", () => {
    const def = validateAndNormalize({
        ...BASE,
        parameters: { amp: { value: 0.5, min: 0, max: 1, step: 0.05 } }
    }).definition;
    assert.deepEqual({ ...def.parameters.amp }, { value: 0.5, min: 0, max: 1, step: 0.05 });
});

ok("parameters usable across slot kinds (layer opacity + color channel)", () => {
    const raw = {
        ...BASE,
        parameters: { lvl: 0.25, amt: 0.5 },
        scene: {
            type: "composite",
            layers: [
                { type: "color", color: "#101010" },
                { type: "gradient", from: { r: "amt", g: 0, b: 0 }, to: "#000000", opacity: "lvl*4" }
            ]
        }
    };
    const { definition: def } = validateAndNormalize(raw);
    const out = rasterize(def, 0, { width: 4, height: 2 });
    // top gradient layer at opacity 1: red ≈ amt=0.5 -> ~128
    assert.ok(out[0] > 100, `expected bright red blend, got ${out[0]}`);
});

ok("round-trip serialize->parse->serialize preserves semantics", () => {
    const raw = {
        amo: 1,
        parameters: { amp: { value: 0.5, min: 0, max: 1 } },
        scene: { type: "expression", r: "amp*sin(2*pi*t)", g: "0", b: "0" }
    };
    const first = validateAndNormalize(raw).definition;
    const second = validateAndNormalize(JSON.parse(JSON.stringify(raw))).definition;
    assert.equal(second.parameters.amp.value, first.parameters.amp.value);
    assert.equal(second.scene.r, first.scene.r);
    assert.equal(second.isStatic, first.isStatic);
    const o1 = rasterize(first, 1.3, { width: 8, height: 4 });
    const o2 = rasterize(second, 1.3, { width: 8, height: 4 });
    assert.deepEqual([...o2], [...o1]);
});

ok("coordinate invariance: same normalized field across resolutions", () => {
    const raw = {
        amo: 1,
        parameters: { k: 6 },
        scene: { type: "expression", r: "0.5+0.5*sin(k*u)", g: "v", b: "0" }
    };
    const def = validateAndNormalize(raw).definition;
    // sample the exact same normalized point (u,v)=(0.25,0.75) on both grids
    // (resolutions chosen so u=x/(w-1) and v=y/(h-1) hit the target exactly)
    function probe(w, h) {
        const out = rasterize(def, 0, { width: w, height: h });
        const x = Math.round(0.25 * (w - 1));
        const y = Math.round(0.75 * (h - 1));
        const i = (y * w + x) * 3;
        return [out[i], out[i + 1]];
    }
    const [r1, g1] = probe(33, 33);
    const [r2, g2] = probe(97, 97);
    assert.ok(Math.abs(r1 - r2) <= 2, `r drift ${r1} vs ${r2}`);
    assert.equal(g1, g2);
});

ok("determinism: same x,y,t -> same output", () => {
    const raw = {
        amo: 1,
        parameters: { amp: "0.5 + 0.1*sin(t*3)" },
        scene: { type: "expression", r: "amp*abs(sin(u*10+t))", g: "noise(x,y)", b: "0" }
    };
    const def = validateAndNormalize(raw).definition;
    const a = rasterize(def, 2.7, { width: 24, height: 12 });
    const b = rasterize(def, 2.7, { width: 24, height: 12 });
    assert.deepEqual([...b], [...a]);
});

ok("GLSL backend maps parameters to uP_ uniforms", () => {
    const glsl = compileToGLSL("amp*sin(t)", new Set(["amp"]));
    assert.ok(glsl.includes("uP_amp"), glsl);
});

ok("helpers: isReservedName / isValidParamName", () => {
    for (const n of ["x", "y", "t", "p", "sin", "clamp"]) assert.ok(isReservedName(n), n);
    assert.ok(!isReservedName("amplitude"));
    assert.ok(isValidParamName("_a1"));
    assert.ok(!isValidParamName("1a"));
    assert.ok(!isValidParamName("a-b"));
});

console.log(`parameters: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

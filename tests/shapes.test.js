// Shape presets (PLAN_ADVANCED_MATH_POLISH.md §2.5): every preset must
// validate through the full .amo pipeline and rasterize *visibly* — the
// whole point is "insert a shape, see a shape" (u,v equations; x,y are
// pixel coordinates in this engine, so external 0..1 snippets paint black).
import { parseAmo } from "../src/scene/parser.js";
import { rasterize } from "../src/scene/rasterizer.js";
import { SHAPE_PRESETS, shapeFragment } from "../src/scene/shape-presets.js";

let passed = 0, failed = 0;
function ok(cond, name) {
    if (cond) { passed++; }
    else { failed++; console.log("FAIL:", name); }
}

const W = 96, H = 54;

function renderPreset(preset, t = 0) {
    const raw = { amo: 1, meta: { name: preset.id }, scene: shapeFragment(preset) };
    if (Object.keys(preset.params).length) raw.parameters = preset.params;
    const def = parseAmo(raw).definition;
    return rasterize(def, t, { width: W, height: H });
}

/** lit = pixels with any channel > 8; center = max channel near (0.5,0.5). */
function stats(buf) {
    let lit = 0;
    for (let i = 0; i < buf.length; i += 3) {
        if (Math.max(buf[i], buf[i + 1], buf[i + 2]) > 8) lit++;
    }
    let center = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const x = Math.round(0.5 * (W - 1)) + dx;
            const y = Math.round(0.5 * (H - 1)) + dy;
            const i = (y * W + x) * 3;
            center = Math.max(center, buf[i], buf[i + 1], buf[i + 2]);
        }
    }
    return { lit, center };
}

ok("shape preset inventory: circle ring square cross ripples", () => {
    const ids = SHAPE_PRESETS.map(p => p.id).join(",");
    if (ids !== "circle,ring,square,cross,ripples") throw new Error(`inventory drifted: ${ids}`);
});

for (const preset of SHAPE_PRESETS) {
    let buf = null;
    ok(`${preset.id}: validates + rasterizes`, () => {
        buf = renderPreset(preset);
        if (!buf || buf.length !== W * H * 3) throw new Error("bad buffer");
    });
    ok(`${preset.id}: >2% lit pixels`, () => {
        const s = stats(buf);
        if (s.lit < W * H * 0.02) throw new Error(`lit=${s.lit}/${W * H}`);
    });
    ok(`${preset.id}: center pixel bright`, () => {
        const s = stats(buf);
        if (s.center < 128) throw new Error(`center=${s.center}`);
    });
    ok(`${preset.id}: param specs are usable sliders`, () => {
        for (const [name, spec] of Object.entries(preset.params)) {
            if (!(spec.min < spec.value && spec.value < spec.max)) {
                throw new Error(`${name}: value ${spec.value} outside (${spec.min},${spec.max})`);
            }
            if (!(spec.step > 0)) throw new Error(`${name}: bad step`);
        }
    });
}

// Circle sanity vs the "x,y ∈ 0..1" trap: corners must stay dark, and an
// x,y-written version of the same math must paint nothing (regression guard
// for the silent-black failure mode users hit with external snippets).
ok("circle: corners dark", () => {
    const buf = renderPreset(SHAPE_PRESETS[0]);
    for (const [x, y] of [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]]) {
        const i = (y * W + x) * 3;
        const m = Math.max(buf[i], buf[i + 1], buf[i + 2]);
        if (m > 8) throw new Error(`corner (${x},${y}) = ${m}`);
    }
});

ok("x,y-as-0..1 circle (the external-snippet trap) paints black", () => {
    const raw = {
        amo: 1,
        scene: {
            type: "expression",
            r: "1/(1+exp(400*((x-0.5)*(x-0.5)+(y-0.5)*(y-0.5)-0.18*0.18)))",
            g: "0", b: "0"
        }
    };
    const buf = rasterize(parseAmo(raw).definition, 0, { width: W, height: H });
    let lit = 0;
    for (let i = 0; i < buf.length; i += 3) {
        if (Math.max(buf[i], buf[i + 1], buf[i + 2]) > 8) lit++;
    }
    if (lit > 4) throw new Error(`expected ~black, lit=${lit}`);
});

ok("shape preset: deterministic + static in t", () => {
    const a = renderPreset(SHAPE_PRESETS[0], 0);
    const b = renderPreset(SHAPE_PRESETS[0], 1.5);
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) throw new Error(`pixel ${i} differs across t`);
    }
});

console.log(`shapes: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

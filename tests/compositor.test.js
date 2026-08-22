// Phase 6 acceptance: blend-mode golden bytes on 4x4 fixtures.
// Run: node tests/compositor.test.js   (exit 0 = pass)
import { parseAmo } from "../src/scene/parser.js";
import { rasterize } from "../src/scene/rasterizer.js";

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
}

// Base: rgb(0.5, 0.25, 0.75); Top: rgb(0.8, 0.8, 0.2).
function build(blend, opacity) {
    return parseAmo({
        amo: 1,
        display: { gamma: 1 },          // bypass emitter response for byte math
        scene: {
            type: "composite",
            layers: [
                { type: "color", color: "#8040c0" },
                { type: "color", color: "#cccc33", blend, opacity }
            ]
        }
    }).definition;
}

function centerPixel(def) {
    const buf = rasterize(def, 0, { width: 4, height: 4 }, {});
    // sample pixel (2,2)
    const i = (2 * 4 + 2) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
}

function expectRGB(name, blend, opacity, expected) {
    ok(`${name} @${opacity}`, () => {
        const got = centerPixel(build(blend, opacity));
        for (let c = 0; c < 3; c++) {
            if (Math.abs(got[c] - expected[c]) > 1.01) {
                throw new Error(`channel ${c}: got ${got[c]}, expected ~${expected[c]}`);
            }
        }
    });
}

expectRGB("normal", "normal", 1, [204, 204, 51]);
ok("normal alpha-over @0.5", () => {
    const got = centerPixel(build("normal", 0.5));
    const expected = [
        Math.round(0.5 * 204 + 0.5 * 128),
        Math.round(0.5 * 204 + 0.5 * 64),
        Math.round(0.5 * 51 + 0.5 * 192)
    ];
    for (let c = 0; c < 3; c++) {
        if (Math.abs(got[c] - expected[c]) > 1.01) throw new Error(`ch ${c}: ${got[c]} vs ${expected[c]}`);
    }
});
expectRGB("add", "add", 1, [255, 255, Math.round(0.95 * 255)]);
expectRGB("multiply", "multiply", 1, [Math.round(0.5 * 0.8 * 255), Math.round(0.25 * 0.8 * 255), Math.round(0.75 * 0.2 * 255)]);
expectRGB("screen", "screen", 1, [
    Math.round((1 - (1 - 128 / 255) * (1 - 204 / 255)) * 255),   // ~230
    Math.round((1 - (1 - 64 / 255) * (1 - 204 / 255)) * 255),    // ~102
    Math.round((1 - (1 - 192 / 255) * (1 - 51 / 255)) * 255)     // ~205
]);
expectRGB("overlay", "overlay", 1, [
    Math.round((1 - 2 * 0.5 * 0.2) * 255),           // a=0.5 -> upper branch
    Math.round((2 * 0.25 * 0.8) * 255),              // a=0.25 -> lower branch
    Math.round((1 - 2 * 0.25 * 0.8) * 255)
]);

// opacity=0 leaves base untouched
expectRGB("add zero-opacity keeps base", "add", 0, [128, 64, 191]);

// clip rect: right half only
ok("clip rect limits blending to right half", () => {
    const def = parseAmo({
        amo: 1,
        display: { gamma: 1 },
        scene: {
            type: "composite",
            layers: [
                { type: "color", color: "#8040c0" },
                { type: "color", color: "#00ff00", blend: "normal", rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }
            ]
        }
    }).definition;
    const buf = rasterize(def, 0, { width: 4, height: 4 }, {});
    const left = buf.slice((1 * 4 + 0) * 3, (1 * 4 + 0) * 3 + 3);
    const right = buf.slice((1 * 4 + 3) * 3, (1 * 4 + 3) * 3 + 3);
    if (!(right[1] > left[1])) throw new Error(`right g=${right[1]} should exceed left g=${left[1]}`);
    if (right[1] < 200) throw new Error(`right not green: ${right}`);
});

// static detection through layers
ok("composite of static layers is static", () => {
    const { definition } = parseAmo({
        amo: 1,
        scene: {
            type: "composite",
            layers: [{ type: "color", color: "#000" }, { type: "gradient", from: "#000", to: "#fff" }]
        }
    });
    if (!definition.isStatic) throw new Error("should be static");
});
ok("composite with animated layer is animated", () => {
    const { definition } = parseAmo({
        amo: 1,
        scene: {
            type: "composite",
            layers: [{ type: "color", color: "#000" }, { type: "expression", r: "sin(t)", g: "0", b: "0" }]
        }
    });
    if (definition.isStatic) throw new Error("should be animated");
});

// ------------------------------------------------------------------
console.log(`\ncompositor: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log(failures.map(f => "  FAIL " + f).join("\n"));
    process.exit(1);
}

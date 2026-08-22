// Phase 5 acceptance: expression grammar, errors, determinism, NaN guards,
// AST static-walk. Run: node tests/expression.test.js
import { compileExpression, expressionReferencesTime } from "../src/scene/expression.js";
import { rasterize } from "../src/scene/rasterizer.js";
import { parseAmo } from "../src/scene/parser.js";

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
}
function expectError(name, src) {
    ok(name, () => {
        try { compileExpression(src); }
        catch (e) { return; }
        throw new Error("expected compile error");
    });
}

function approx(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }

// --- spot values ---
ok("arithmetic + precedence", () => {
    const p = compileExpression("2 + 3 * 4");
    if (!approx(p.eval(0, 0, {}), 14)) throw new Error("precedence");
});
ok("power is right-associative", () => {
    const p = compileExpression("2 ^ 3 ^ 2");
    if (!approx(p.eval(0, 0, {}), 512)) throw new Error("assoc");
});
ok("negative base with integer exponent", () => {
    const p = compileExpression("(-2) ^ 3");
    if (!approx(p.eval(0, 0, {}), -8)) throw new Error("neg pow");
});
ok("unary minus", () => {
    const p = compileExpression("-x");
    if (!approx(p.eval(3, 0, { x: 3 }), -3)) throw new Error("unary");
});
ok("ternary", () => {
    const p = compileExpression("x > 5 ? 10 : -1");
    if (!approx(p.eval(6, 0, { x: 6 }), 10)) throw new Error("then");
    if (!approx(p.eval(1, 0, { x: 1 }), -1)) throw new Error("else");
});
ok("modulo semantics match GLSL-style", () => {
    const p = compileExpression("mod(-1, 4)");
    if (!approx(p.eval(0, 0, {}), 3)) throw new Error(`mod=${p.eval(0, 0, {})}`);
});
ok("fract/clamp/mix/smoothstep/step", () => {
    const E = {};
    if (!approx(compileExpression("fract(2.75)").eval(0, 0, E), 0.75)) throw new Error("fract");
    if (!approx(compileExpression("clamp(5, 0, 3)").eval(0, 0, E), 3)) throw new Error("clamp");
    if (!approx(compileExpression("mix(0, 10, 0.2)").eval(0, 0, E), 2)) throw new Error("mix");
    if (!approx(compileExpression("smoothstep(0, 2, 1)").eval(0, 0, E), 0.5)) throw new Error("smoothstep");
    if (!approx(compileExpression("step(1, 0.5)").eval(0, 0, E), 0)) throw new Error("step");
});
ok("variables x/y/u/v/width/height", () => {
    const p = compileExpression("u * width == x ? 1 : 0");
    if (!approx(p.eval(7, 0, { x: 7, u: 7 / 20, width: 20 }), 1)) throw new Error("vars");
});
ok("t/frame come from env", () => {
    const p = compileExpression("t + frame");
    if (!approx(p.eval(0, 0, { t: 1.5, frame: 3 }), 4.5)) throw new Error("env time");
});

// --- noise determinism ---
ok("noise deterministic from seed", () => {
    const p = compileExpression("noise(x*0.1, y*0.1)");
    const a = p.eval(3.3, 4.4, { seed: 42 });
    const b = p.eval(3.3, 4.4, { seed: 42 });
    const c = p.eval(3.3, 4.4, { seed: 43 });
    if (!approx(a, b)) throw new Error("nondeterministic");
    if (approx(a, c)) throw new Error("seed has no effect");
    if (a < 0 || a >= 1) throw new Error("range [0,1)");
});

// --- NaN guards ---
ok("division by zero -> defined result", () => {
    const p = compileExpression("1 / x");
    const v = p.eval(0, 0, {});
    if (v !== Infinity && !Number.isNaN(v)) throw new Error(`v=${v}`);
});
ok("mod by zero -> finite", () => {
    const p = compileExpression("mod(5, x)");
    const v = p.eval(0, 0, { x: 0 });
    if (Number.isNaN(v)) throw new Error("NaN from mod-by-zero");
});

// --- parse errors ---
expectError("unknown identifier", "x + hackery");
expectError("unknown function", "frobnicate(x)");
expectError("arity mismatch", "min(1)");
expectError("trailing garbage", "x y");
expectError("unclosed paren", "(x + 1");
expectError("empty expression", "");
expectError("bare operator", "* 4");

// --- static detection walk ---
ok("expressionReferencesTime", () => {
    if (!expressionReferencesTime("sin(t)")) throw new Error("t missed");
    if (!expressionReferencesTime("frame")) throw new Error("frame missed");
    if (expressionReferencesTime("x*y*u*v")) throw new Error("false positive");
    // even inside ternaries
    if (!expressionReferencesTime("t > 1 ? a : b")) throw new Error("cond t missed");
});

// --- rasterizer integration + determinism hash ---
const DEF_TEXT = JSON.stringify({
    amo: 1,
    quality: { fps: 30 },
    scene: {
        type: "expression",
        seed: 9,
        r: "0.5 + 0.4*sin(x*8 + t*2)",
        g: "0.3 + 0.3*noise(u*4, v*4)",
        b: "u"
    }
});
const parsed = parseAmo(DEF_TEXT);

function bufferHash(buf) {
    let h = 0x811c9dc5;
    for (let i = 0; i < buf.length; i += 7) {
        h ^= buf[i]; h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

ok("rasterize expression scene: deterministic per (t, size)", () => {
    const a = rasterize(parsed.definition, 1.25, { width: 48, height: 32 }, {});
    const b = rasterize(parsed.definition, 1.25, { width: 48, height: 32 }, {});
    if (bufferHash(a) !== bufferHash(b)) throw new Error("nondeterministic output");
});

ok("rasterize advances with t (animated)", () => {
    const a = rasterize(parsed.definition, 0.0, { width: 48, height: 32 }, {});
    const b = rasterize(parsed.definition, 1.0, { width: 48, height: 32 }, {});
    if (bufferHash(a) === bufferHash(b)) throw new Error("output identical across time");
});

ok("rasterize output is BYTE-scaled (mean ~127 for mid-gray expression)", () => {
    const def = parseAmo({
        amo: 1,
        scene: {
            type: "expression",
            r: "0.5", g: "0.5 + 0.5*sin(y*0.3)", b: "u"
        }
    }).definition;
    const buf = rasterize(def, 5, { width: 32, height: 16 }, {});
    let sumR = 0, n = 32 * 16;
    for (let i = 0; i < buf.length; i += 3) sumR += buf[i];
    const meanR = sumR / n;
    if (Math.abs(meanR - 127.5) > 1) throw new Error(`meanR=${meanR}, expected ~127.5`);
});

ok("rasterize output clamped to byte range (no NaN)", () => {
    const def = parseAmo({
        amo: 1,
        scene: { type: "expression", r: "x/(x-10)*999", g: "-1/x", b: "sqrt(-2)" }
    }).definition;
    const buf = rasterize(def, 0, { width: 24, height: 16 }, {});
    for (let i = 0; i < buf.length; i++) {
        if (!(buf[i] >= 0 && buf[i] <= 255)) throw new Error(`out-of-range at ${i}: ${buf[i]}`);
    }
});

ok("static expression scene detected via parser", () => {
    const { definition } = parseAmo({ amo: 1, scene: { type: "expression", r: "x", g: "y", b: "u+v" } });
    if (!definition.isStatic) throw new Error("should be static");
});

// ------------------------------------------------------------------
console.log(`\nexpression: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log(failures.map(f => "  FAIL " + f).join("\n"));
    process.exit(1);
}

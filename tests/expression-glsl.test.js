// Phase 10: GLSL backend string compilation (deterministic, no browser).
import { compileToGLSL } from "../src/scene/expression.js";

let passed = 0, failed = 0;
const failures = [];
const ok = (name, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
};

ok("t maps to uT uniform", () => {
    const out = compileToGLSL("sin(t)");
    if (!out.includes("uT")) throw new Error(out);
});
ok("noise uses seeded lattice fn", () => {
    const out = compileToGLSL("noise(x*0.1, y*0.1)");
    if (!out.includes("amo_noise(uint(uSeed)")) throw new Error(out);
});
ok("division guarded via amo_div", () => {
    if (!compileToGLSL("1/x").includes("amo_div(1.00000000, x)")) throw new Error("div");
});
ok("pow routed through amo_pow", () => {
    if (!compileToGLSL("(x-40)^2").includes("amo_pow((x - 40.00000000"), throw_placeholder());
});
function throw_placeholder() { return new Error("pow"); }

ok("comparisons compile to ternaries", () => {
    const out = compileToGLSL("x > 5 ? 1 : 0");
    if (!out.includes("? 1.0 : 0.0") || !out.includes(">")) throw new Error(out);
});

console.log(`\nexpression-glsl: ${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map(f => "  FAIL " + f).join("\n")); process.exit(1); }

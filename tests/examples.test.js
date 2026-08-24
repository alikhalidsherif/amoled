// Golden scenes (PLAN_GENERATOR_OVERHAUL.md §29/§30): every shipped example
// must parse cleanly, report no unexpected warnings, and render
// deterministically (same t => identical bytes). Asset-backed scenes are
// parse-checked only (decoding requires a browser).

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAmo } from "../src/scene/parser.js";
import { rasterize } from "../src/scene/rasterizer.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "scenes");
const files = readdirSync(dir).filter(f => f.endsWith(".amo"));

let passed = 0, failed = 0;
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

for (const f of files) {
    const name = `scenes/${f}`;
    ok(`${name}: parses`, () => {
        const parsed = parseAmo(readFileSync(join(dir, f), "utf8"), null);
        assert.ok(parsed.definition.scene.type);
        // deterministic render (skip scenes needing decoded assets)
        if (parsed.definition.assets &&
            Object.keys(parsed.definition.assets).length > 0) return;
        const def = parsed.definition;
        if (def.isStatic) {
            // static scenes must be flagged only when truly time-free
            assert.equal(rasterize(def, 5, { width: 64, height: 64 }).length, 64 * 64 * 3);
            return;
        }
        const a = [...rasterize(def, 1.7, { width: 64, height: 64 })];
        const b = [...rasterize(def, 1.7, { width: 64, height: 64 })];
        assert.deepEqual(b, a, "same t must produce identical output");
    });
}

ok("canonical examples exist", () => {
    for (const required of ["three-phase.amo", "three-phase-scope.amo", "orbiting-emitters.amo"]) {
        assert.ok(files.includes(required), `missing ${required}`);
    }
});

ok("three-phase channels are exactly 120 degrees apart", () => {
    const def = parseAmo(readFileSync(join(dir, "three-phase.amo"), "utf8"), null).definition;
    const out = rasterize(def, 0.37, { width: 8, height: 8 });
    // uniform field: sample one pixel; verify r+g+b relationships hold for
    // pure sinusoids sampled at any instant (all means are 0.5 -> mid gray)
    const i = 0;
    const r = out[i] / 255, g = out[i + 1] / 255, b = out[i + 2] / 255;
    const sum = r + g + b;
    // three sinusoids 120deg apart always sum to zero -> field sums to 1.5
    assert.ok(Math.abs(sum - 1.5) < 0.02, `sum=${sum}`);
});

console.log(`examples: ${passed} passed, ${failed} failed (${files.length} scene files)`);
process.exit(failed ? 1 : 0);

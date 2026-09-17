// Scope scene validation tests (signal-lab-spec.md §13).
import { parseAmo } from "../src/scene/parser.js";
import assert from "node:assert";

let passed = 0;
let failed = 0;
function ok(cond, name) {
    if (cond) { passed++; }
    else { failed++; console.log("FAIL:", name); }
}

const BASE = {
    amo: 1,
    meta: { name: "scope test" },
    scene: {
        type: "scope",
        rows: [
            { type: "trace", name: "R", waveform: "sine", color: "#ff0000",
              channel: "r", amplitude: 0.35, frequency: 2, phaseOffset: 0,
              offset: 0.5, sweepSpeed: 4, thickness: 0.02, enabled: true }
        ]
    }
};

function validate(sceneOverrides, rest = {}) {
    return parseAmo({ ...BASE, ...rest, scene: { ...BASE.scene, ...sceneOverrides } }, "http://x/");
}

// 1. Valid scene round-trips with canonical defaults applied.
{
    const { definition, warnings } = validate({});
    ok(definition.scene.type === "scope", "type preserved");
    ok(definition.scene.rows.length === 1, "row count");
    const tr = definition.scene.rows[0];
    ok(tr.type === "trace", "row is trace");
    ok(tr.waveform === "sine", "waveform default explicit");
    ok(tr.amplitude === 0.35 && tr.frequency === 2 && tr.offset === 0.5, "trace defaults");
    ok(tr.sweepSpeed === 4, "sweepSpeed default 4 (rad/s)");
    ok(tr.thickness === 0.02, "thickness default");
    ok(tr.enabled === true, "enabled default");
    ok(tr.channel === "r", "channel preserved");
    ok(warnings.length === 0, `no warnings (got ${JSON.stringify(warnings)})`);
}

// 2. Canonical three-phase offsets survive untouched.
{
    const { definition } = validate({
        rows: [
            { type: "trace", waveform: "sine", color: "#ff0000", channel: "r", phaseOffset: 0 },
            { type: "trace", waveform: "sine", color: "#00ff00", channel: "g", phaseOffset: -2.0944 },
            { type: "trace", waveform: "sine", color: "#0000ff", channel: "b", phaseOffset: -4.1888 }
        ]
    });
    const offs = definition.scene.rows.map(r => r.phaseOffset);
    assert.deepStrictEqual(offs, [0, -2.0944, -4.1888]);
}

// 3. Unknown waveform rejected.
try {
    validate({ rows: [{ type: "trace", waveform: "noise" }] });
    ok(false, "unknown waveform should fail");
} catch (e) {
    ok(/waveform/.test(e.message), "unknown waveform rejected: " + e.message);
}

// 4. Custom expression: valid signal-space expression accepted.
{
    const { definition } = validate({
        rows: [{ type: "trace", waveform: "custom", expression: "sin(p) + 0.3*sin(3*p)" }]
    });
    ok(definition.scene.rows[0].expression === "sin(p) + 0.3*sin(3*p)", "custom expression kept");
}

// 5. Custom expression referencing pixel-space y/v rejected WITH guidance.
{
    let msg = "";
    try {
        validate({ rows: [{ type: "trace", waveform: "custom", expression: "sin(y)" }] });
    } catch (e) { msg = e.message; }
    ok(/pixel-space/.test(msg) && /offset/.test(msg), "y rejected with guidance: " + msg);
}
{
    let msg = "";
    try {
        validate({ rows: [{ type: "trace", waveform: "custom", expression: "v*2" }] });
    } catch (e) { msg = e.message; }
    ok(/pixel-space/.test(msg), "v rejected with guidance");
}

// 6. Custom expression may use x, t, p, and knob names.
{
    const { definition } = validate({
        rows: [{ type: "trace", waveform: "custom",
                 expression: "sin(p) * clamp(frequency/2, 0, 2) + 0.1*sin(t*tau*sweepSpeed/8 + phaseOffset)" }]
    });
    ok(!!definition.scene.rows[0].expression, "signal env idents accepted");
}

// 7. Custom expression without expression string rejected.
try {
    validate({ rows: [{ type: "trace", waveform: "custom" }] });
    ok(false, "custom without expression should fail");
} catch (e) {
    ok(/expression/.test(e.message), "custom without expression rejected");
}

// 8. Bad channel rejected.
try {
    validate({ rows: [{ type: "trace", channel: "x" }] });
    ok(false, "bad channel should fail");
} catch (e) {
    ok(/channel/.test(e.message), "bad channel rejected");
}

// 9. Unbound traces legal; same color twice legal.
{
    const { definition } = validate({
        rows: [
            { type: "trace", color: "#ff0000" },
            { type: "trace", color: "#ff0000" }
        ]
    });
    ok(definition.scene.rows.length === 2, "two same-color unbound traces");
    ok(definition.scene.rows.every(r => r.channel === undefined), "unbound stays unbound");
}

// 10. Numeric clamping with warning (amplitude out of range).
{
    const { definition, warnings } = validate({
        rows: [{ type: "trace", amplitude: 99 }]
    });
    ok(definition.scene.rows[0].amplitude === 2, "amplitude clamped to 2");
    ok(warnings.some(w => /amplitude/.test(w)), "clamp warning emitted");
}

// 11. Background field row (color) coexists under traces.
{
    const { definition } = validate({
        rows: [
            { type: "color", color: "#010a08" },
            { type: "trace", color: "#ff0000" }
        ]
    });
    ok(definition.scene.rows[0].type === "color", "color row preserved");
    ok(definition.scene.rows[1].type === "trace", "trace row preserved");
}

// 12. E-value trace slots (animated phaseOffset) accepted.
{
    const { definition } = validate({
        rows: [{ type: "trace", phaseOffset: "t*0.5" }]
    });
    ok(definition.scene.rows[0].phaseOffset === "t*0.5", "E-value phaseOffset kept");
}

// 13. verticalScale E-value.
{
    const { definition } = validate({ verticalScale: 1.5 });
    ok(definition.scene.verticalScale === 1.5, "verticalScale number");
}
{
    const { definition } = validate({ verticalScale: "0.5 + 0.5*sin(t)" });
    ok(definition.scene.verticalScale === "0.5 + 0.5*sin(t)", "verticalScale expression kept");
}

// 14. Static detection: sweepSpeed 0 + static slots => static; sweepSpeed 4 => animated.
{
    const { definition } = validate({
        rows: [{ type: "trace", sweepSpeed: 0 }]
    });
    ok(definition.isStatic === true, "static scope (sweepSpeed 0)");
}
{
    const { definition } = validate({
        rows: [{ type: "trace", sweepSpeed: 4 }]
    });
    ok(definition.isStatic === false, "animated scope (sweepSpeed 4)");
}
{
    const { definition } = validate({
        rows: [{ type: "trace", sweepSpeed: 0, phaseOffset: "t" }]
    });
    ok(definition.isStatic === false, "animated scope (E-value references t)");
}
{
    const { definition } = validate({
        rows: [
            { type: "color", color: "#010a08" },
            { type: "trace", sweepSpeed: 0 }
        ]
    });
    ok(definition.isStatic === true, "static scope with static background row");
}

// 15. Empty rows rejected.
try {
    validate({ rows: [] });
    ok(false, "empty rows should fail");
} catch (e) {
    ok(/rows/.test(e.message), "empty rows rejected");
}

// 16. Unknown fields on trace rows warn but do not fail.
{
    const { definition, warnings } = validate({
        rows: [{ type: "trace", nonsense: 1 }]
    });
    ok(definition.scene.rows.length === 1, "unknown field tolerated");
    ok(warnings.some(w => /nonsense/.test(w)), "unknown field warning");
}

console.log(`scope-scene: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Phase 2 acceptance: .amo parser/validator fixtures (PLAN.md §Phase 2).
// Run: node tests/amo-parser.test.js   (exit 0 = pass)
import { parseAmo, AmoError } from "../src/scene/parser.js";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        failures.push(`${name}: ${e.message}`);
    }
}

function expectReject(name, raw, pathHint) {
    ok(name, () => {
        try {
            parseAmo(raw);
        } catch (e) {
            if (!(e instanceof AmoError)) throw new Error(`threw non-AmoError: ${e}`);
            if (pathHint && !e.message.includes(pathHint)) {
                throw new Error(`expected hint "${pathHint}", got "${e.message}"`);
            }
            return;
        }
        throw new Error("expected rejection but parse succeeded");
    });
}

function expectWarning(name, raw, needle) {
    ok(name, () => {
        const { warnings } = parseAmo(raw);
        if (!warnings.some(w => w.includes(needle))) {
            throw new Error(`expected warning containing "${needle}", got [${warnings.join("; ")}]`);
        }
    });
}

const VALID_MIN = { amo: 1, scene: { type: "color", color: "#000000" } };

// ------------------------------------------------------------------
// Valid parses
// ------------------------------------------------------------------

ok("minimal valid scene parses", () => {
    const { definition } = parseAmuSafe(VALID_MIN);
    if (definition.version !== 1) throw new Error("version");
    if (!definition.isStatic) throw new Error("color must be static");
});

function parseAmuSafe(raw) { return parseAmo(raw); }

ok("string input equals object input (idempotent)", () => {
    const a = parseAmo(VALID_MIN).definition;
    const b = parseAmo(JSON.stringify(VALID_MIN)).definition;
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("divergent results");
});

ok("full display section normalizes", () => {
    const { definition } = parseAmo({
        amo: 1,
        display: {
            pitch: 8,
            gamma: 1.6,
            brightness: { active: 0.9, inactive: 0.02 },
            spill: 0.4,
            emitters: { maxOutput: { r: 0.6, g: 1, b: 0.5 }, sigma: { r: 0.5, g: 0.4, b: 0.7 } },
            bloom: { intensity: 0.3, threshold: 0.4, power: 2.2, radius: 20 },
            pentile: { rowPitchFactor: 0.9, blackMatrixRatio: 0.2, greenSizeRatio: 0.8, diamondSizeRatio: 0.9 }
        },
        scene: { type: "color", color: "#102030" }
    });
    const d = definition.display;
    if (d.pitch !== 8 || d.gamma !== 1.6 || d.spill !== 0.4) throw new Error("display scalars");
    if (d.maxOutput.g !== 1 || d.sigma.b !== 0.7) throw new Error("channels");
    if (d.bloom.radius !== 20 || d.pentile.rowPitchFactor !== 0.9) throw new Error("nested");
});

ok("#rgb hex expands", () => {
    const { definition } = parseAmo({ amo: 1, scene: { type: "color", color: "#f00" } });
    if (definition.scene.color.r !== 1 || definition.scene.color.g !== 0) throw new Error("expansion");
});

ok("{r,g,b} floats accepted and clamped", () => {
    const { definition } = parseAmo({
        amo: 1,
        scene: { type: "color", color: { r: 1.5, g: -0.2, b: 0.5 } }
    });
    const c = definition.scene.color;
    if (c.r !== 1 || c.g !== 0 || c.b !== 0.5) throw new Error("clamp");
});

ok("asset URLs resolve against baseUrl", () => {
    const { definition } = parseAmo({
        amo: 1,
        assets: { still: "img/sample.png" },
        scene: { type: "image", asset: "still" }
    }, "https://example.com/scenes/");
    if (definition.assets.still !== "https://example.com/scenes/img/sample.png") {
        throw new Error(`got ${definition.assets.still}`);
    }
});

ok("gradient defaults direction=vertical, isStatic=true", () => {
    const { definition } = parseAmo({ amo: 1, scene: { type: "gradient", from: "#000", to: "#fff" } });
    if (definition.scene.direction !== "vertical") throw new Error("direction default");
    if (!definition.isStatic) throw new Error("static");
});

ok("timeline keyframes make scene animated + interpolate fields present", () => {
    const { definition } = parseAmo({
        amo: 1,
        timeline: {
            duration: 5,
            loop: true,
            keyframes: [{ property: "display.bloom.intensity", keys: [[0, 0], [2, 0.5], [5, 0.15]] }]
        },
        scene: { type: "color", color: "#000" }
    });
    if (definition.isStatic) throw new Error("must be animated");
    if (definition.timeline.keyframes[0].keys.length !== 3) throw new Error("keys");
    if (definition.timeline.duration !== 5 || definition.timeline.loop !== true) throw new Error("tl fields");
});

// ------------------------------------------------------------------
// Rejections
// ------------------------------------------------------------------

expectReject("missing version", { scene: { type: "color" } }, "amo");
expectReject("unknown version", { amo: 2, scene: { type: "color" } }, "amo");
expectReject("non-object input", "just a string", "");
expectReject("invalid JSON text", "{not json", "");
expectReject("missing scene", { amo: 1 }, "scene");
expectReject("unknown scene type", { amo: 1, scene: { type: "holodeck" } }, "scene.type");
expectReject("invalid hex color", { amo: 1, scene: { type: "color", color: "#zzzzzz" } }, "scene.color");
expectReject("NaN in display", { amo: 1, display: { gamma: NaN }, scene: { type: "color" } }, "display.gamma");
expectReject("Infinity in quality", { amo: 1, quality: { fps: Infinity }, scene: { type: "color" } }, "quality.fps");
expectReject("gamma as string", { amo: 1, display: { gamma: "1.6" }, scene: { type: "color" } }, "display.gamma");
expectReject("resolution below 64", { amo: 1, quality: { logicalResolution: { width: 32, height: 180 } }, assets: { x: "x.png" }, scene: { type: "image", asset: "x" } }, "width");
expectReject("resolution above 1280", { amo: 1, quality: { logicalResolution: { height: 2000 } }, scene: { type: "color" } }, "height");
expectReject("invalid supersample value", { amo: 1, quality: { supersample: 5 }, scene: { type: "color" } }, "supersample");
expectReject("invalid gradient direction", { amo: 1, scene: { type: "gradient", from: "#000", to: "#111", direction: "sideways" } }, "scene.direction");
expectReject("invalid fit mode", { amo: 1, assets: { a: "a.png" }, scene: { type: "image", asset: "a", fit: "zoom" } }, "scene.fit");
expectReject("undeclared asset reference", { amo: 1, scene: { type: "image", asset: "ghost" } }, "scene.asset");
expectReject("keyframes on structural pitch", {
    amo: 1,
    timeline: { duration: 4, keyframes: [{ property: "display.pitch", keys: [[0, 4], [4, 10]] }] },
    scene: { type: "color" }
}, "structural");
expectReject("keyframes on structural pentile", {
    amo: 1,
    timeline: { duration: 4, keyframes: [{ property: "display.pentile.blackMatrixRatio", keys: [[0, 0.2], [4, 0.3]] }] },
    scene: { type: "color" }
}, "structural");
expectReject("keyframes on unknown property", {
    amo: 1,
    timeline: { duration: 4, keyframes: [{ property: "display.hackery", keys: [[0, 0], [4, 1]] }] },
    scene: { type: "color" }
}, "animatable");
expectReject("descending keyframe times", {
    amo: 1,
    timeline: { duration: 4, keyframes: [{ property: "display.gamma", keys: [[0, 1.5], [3, 1.7], [2, 1.6]] }] },
    scene: { type: "color" }
}, "ascending");
expectReject("keyframes need >= 2 keys", {
    amo: 1,
    timeline: { duration: 4, keyframes: [{ property: "display.gamma", keys: [[0, 1.5]] }] },
    scene: { type: "color" }
}, "at least 2");

// ------------------------------------------------------------------
// Clamping warnings
// ------------------------------------------------------------------

expectWarning("gamma clamped into [0.5, 4]", { amo: 1, display: { gamma: 12 }, scene: { type: "color" } }, "clamped");
expectWarning("spill clamped into [0, 0.6]", { amo: 1, display: { spill: 0.95 }, scene: { type: "color" } }, "clamped");
expectWarning("bloom radius clamped into [2, 40]", { amo: 1, display: { bloom: { radius: 100 } }, scene: { type: "color" } }, "clamped");
expectWarning("fps clamped into [1, 60]", { amo: 1, quality: { fps: 120 }, scene: { type: "color" } }, "clamped");
expectWarning("unknown top-level field warns", { amo: 1, frobnicate: true, scene: { type: "color" } }, "frobnicate");

// ------------------------------------------------------------------
// Static detection matrix
// ------------------------------------------------------------------

ok("static matrix: color/image/pattern static; gif/video/expression not", () => {
    const cases = [
        [{ type: "color", color: "#123456" }, true],
        [{ type: "pattern", pattern: "dots" }, true],
        // Phase 5 AST walk: expressions WITHOUT time references are static
        [{ type: "expression", r: "0.5", g: "x*0.5", b: "y" }, true],
        [{ type: "expression", r: "sin(t)", g: "0", b: "0" }, false],
        [{ type: "expression", r: "0", g: "0", b: "y+frame" }, false]
    ];
    for (const [scene, expected] of cases) {
        const { definition } = parseAmo({ amo: 1, scene });
        if (definition.isStatic !== expected) {
            throw new Error(`${scene.type}: expected ${expected}`);
        }
    }
    for (const t of ["gif"]) {
        const { definition } = parseAmo({
            amo: 1, assets: { x: "x.gif" }, scene: { type: t, asset: "x" }
        });
        if (definition.isStatic !== false) throw new Error(`${t} should be animated`);
    }
});

// ------------------------------------------------------------------
console.log(`\namo-parser: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log(failures.map(f => "  FAIL " + f).join("\n"));
    process.exit(1);
}

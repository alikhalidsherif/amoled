// .amo v1 validation and normalization (PLAN.md §5).
//
// Everything untrusted passes through here. Rejects structural problems,
// clamps out-of-range numerics (with diagnostics), enforces animation
// classes, and produces the frozen normalized SceneDefinition.

import { DISPLAY_DEFAULTS, QUALITY_DEFAULTS, ANIMATABLE_PREFIXES, STRUCTURAL_PREFIXES } from "./defaults.js";
import { expressionReferencesTime, compileExpression } from "./expression.js";
import { treeReferencesTime, expressionReferencesSpace } from "./evalue.js";

export class AmoError extends Error {
    constructor(path, message) {
        super(path ? `${path}: ${message}` : message);
        this.name = "AmoError";
        this.path = path || "";
    }
}

const KNOWN_TOP_LEVEL = new Set(["amo", "meta", "display", "quality", "assets", "scene", "timeline"]);
const KNOWN_DISPLAY = new Set(["pitch", "gamma", "brightness", "spill", "emitters", "bloom", "pentile"]);
const KNOWN_SCENE_TYPES = new Set(["color", "gradient", "livingGradient", "image", "gif", "video", "pattern", "expression", "composite"]);
const KNOWN_FIT = new Set(["cover", "contain", "stretch"]);
const KNOWN_DIRECTIONS = new Set(["vertical", "horizontal", "diagonal", "radial"]);
const KNOWN_EASINGS = new Set(["linear", "smoothstep", "easeIn", "easeOut"]);

function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}

function fail(path, message) {
    throw new AmoError(path, message);
}

// Deep guard: NaN/Infinity anywhere in the raw object is a rejection.
function assertNoPoison(value, path) {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) fail(path, "NaN/Infinity is not allowed");
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) assertNoPoison(value[i], `${path}[${i}]`);
        return;
    }
    if (value && typeof value === "object") {
        for (const k of Object.keys(value)) assertNoPoison(value[k], `${path}.${k}`);
    }
}

function num(raw, path, min, max, fallback, warnings, clampable = true) {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw)) fail(path, `expected number, got ${typeof raw}`);
    if (raw < min || raw > max) {
        if (!clampable) fail(path, `value ${raw} outside [${min}, ${max}]`);
        warnings.push(`${path}: clamped ${raw} into [${min}, ${max}]`);
        return Math.min(Math.max(raw, min), max);
    }
    return raw;
}

// Numeric E-value slot (PLAN-CREATIVE.md §A0): finite number (clamped like
// num()) OR an expression string (validated to compile; range-clamped at
// evaluation time by the rasterizer/compositor).
function evalueNum(raw, path, min, max, fallback, warnings) {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw === "string") {
        try {
            compileExpression(raw);
        } catch (e) {
            fail(path, `invalid expression: ${e.message}`);
        }
        return raw;
    }
    return num(raw, path, min, max, fallback, warnings);
}

// Accepts "#rgb"/"#rrggbb", or {r,g,b} where each channel is a finite number
// 0-1 OR an expression string (E-value color slot, PLAN-CREATIVE.md §A0).
// Hex strings are constants; channel expressions are validated to compile
// and preserved verbatim for the rasterizer.
export function normalizeColorE(raw, path, warnings) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string") return normalizeColor(raw, path);
    if (typeof raw === "object" && !Array.isArray(raw)) {
        const out = {};
        for (const c of ["r", "g", "b"]) {
            const v = raw[c];
            if (typeof v === "string") {
                try {
                    compileExpression(v);
                } catch (e) {
                    fail(`${path}.${c}`, `invalid channel expression: ${e.message}`);
                }
                out[c] = v;
            } else {
                out[c] = num(v ?? 0, `${path}.${c}`, 0, 1, 0, warnings);
            }
        }
        return Object.freeze(out);
    }
    fail(path, `expected hex color or {r,g,b}, got ${typeof raw}`);
}

// Accepts "#rgb"/"#rrggbb" hex only (constant color).
export function normalizeColor(raw, path) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string") {
        let hex = raw.trim();
        if (hex[0] !== "#") fail(path, `expected hex color or {r,g,b}, got "${raw}"`);
        hex = hex.slice(1);
        if (/^[0-9a-fA-F]{3}$/.test(hex)) {
            hex = hex.split("").map(c => c + c).join("");
        }
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) fail(path, `invalid hex color "${raw}"`);
        return Object.freeze({
            r: parseInt(hex.slice(0, 2), 16) / 255,
            g: parseInt(hex.slice(2, 4), 16) / 255,
            b: parseInt(hex.slice(4, 6), 16) / 255
        });
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
        const out = {};
        for (const c of ["r", "g", "b"]) {
            const v = raw[c];
            if (!isFiniteNumber(v)) fail(`${path}.${c}`, `expected number 0-1, got ${JSON.stringify(v)}`);
            out[c] = Math.min(1, Math.max(0, v));
        }
        return Object.freeze(out);
    }
    fail(path, `expected hex color or {r,g,b}, got ${typeof raw}`);
}

function channelTriple(raw, path, min, max, defaults, warnings) {
    if (raw === undefined || raw === null) return defaults;
    if (typeof raw !== "object" || Array.isArray(raw)) fail(path, "expected object");
    const out = {};
    for (const c of ["r", "g", "b"]) {
        out[c] = num(raw[c], `${path}.${c}`, min, max, defaults[c], warnings);
    }
    for (const k of Object.keys(raw)) {
        if (!(k in defaults)) warnings.push(`${path}.${k}: unknown field ignored`);
    }
    return Object.freeze(out);
}

function isAnimatable(propertyPath) {
    return ANIMATABLE_PREFIXES.some(p => propertyPath === p || propertyPath.startsWith(p));
}

function isStructural(propertyPath) {
    return STRUCTURAL_PREFIXES.some(p => propertyPath === p || propertyPath.startsWith(p));
}

// ------------------------------------------------------------------

// Known fields per content type (for unknown-field warnings).
const KNOWN_FIELDS_FOR_TYPE = {
    color: ["type", "color"],
    gradient: ["type", "from", "to", "direction"],
    livingGradient: ["type", "stops", "direction", "wobble", "seed"],
    image: ["type", "asset", "fit"],
    gif: ["type", "asset", "fit"],
    video: ["type", "asset", "fit", "muted"],
    pattern: ["type", "pattern"],
    expression: ["type", "r", "g", "b", "seed"],
    composite: ["type", "layers"]
};

// Layer-only compositing fields.
const KNOWN_LAYER_FIELDS = ["opacity", "blend", "rect", "offset", "scale", "rotation"];
const KNOWN_BLENDS = new Set(["normal", "add", "multiply", "screen", "overlay"]);

/**
 * Normalizes a scene CONTENT object (top-level scene or composite layer).
 * Returns frozen { type, ...fields }. Recurses into composite layers.
 */
function normalizeSceneContent(s, path, warnings, assets) {
    if (!s || typeof s !== "object") fail(path, "scene object is required");
    if (!KNOWN_SCENE_TYPES.has(s.type)) {
        fail(`${path}.type`, `unknown scene type ${JSON.stringify(s.type)}`);
    }

    const knownForType = [...(KNOWN_FIELDS_FOR_TYPE[s.type] || []), ...KNOWN_LAYER_FIELDS];
    for (const k of Object.keys(s)) {
        if (!knownForType.includes(k)) {
            warnings.push(`${path}.${k}: unknown field for type "${s.type}" ignored`);
        }
    }

    const scene = { type: s.type };

    if (s.type === "color") {
        scene.color = normalizeColorE(s.color ?? "#000000", `${path}.color`, warnings) ?? { r: 0, g: 0, b: 0 };
    } else if (s.type === "gradient") {
        scene.from = normalizeColorE(s.from ?? "#000000", `${path}.from`, warnings) ?? { r: 0, g: 0, b: 0 };
        scene.to = normalizeColorE(s.to ?? "#ffffff", `${path}.to`, warnings) ?? { r: 1, g: 1, b: 1 };
        if (s.direction !== undefined && !KNOWN_DIRECTIONS.has(s.direction)) {
            fail(`${path}.direction`, `expected one of ${[...KNOWN_DIRECTIONS].join("|")}, got "${s.direction}"`);
        }
        scene.direction = s.direction || "vertical";
    } else if (s.type === "livingGradient") {
        if (!Array.isArray(s.stops) || s.stops.length < 2) {
            fail(`${path}.stops`, "livingGradient needs at least 2 stops");
        }
        let lastAt = -Infinity;
        scene.stops = s.stops.map((st, i) => {
            const sp = `${path}.stops[${i}]`;
            if (!st || typeof st !== "object" || Array.isArray(st)) fail(sp, "expected {at, color}");
            const at = num(st.at, `${sp}.at`, 0, 1, i / (s.stops.length - 1), warnings);
            if (at < lastAt) warnings.push(`${sp}.at: stops are unsorted; they will be sorted automatically`);
            lastAt = at;
            const color = normalizeColorE(st.color, `${sp}.color`, warnings) ?? { r: 0, g: 0, b: 0 };
            return Object.freeze({ at, color });
        });
        if (s.wobble !== undefined && s.wobble !== null) {
            if (typeof s.wobble === "string") {
                try {
                    compileExpression(s.wobble);
                } catch (e) {
                    fail(`${path}.wobble`, `invalid expression: ${e.message}`);
                }
                scene.wobble = s.wobble;
            } else {
                scene.wobble = num(s.wobble, `${path}.wobble`, -1, 1, 0, warnings);
            }
        }
        if (s.seed !== undefined && isFiniteNumber(s.seed)) scene.seed = s.seed;
        if (s.direction !== undefined && !KNOWN_DIRECTIONS.has(s.direction)) {
            fail(`${path}.direction`, `expected one of ${[...KNOWN_DIRECTIONS].join("|")}, got "${s.direction}"`);
        }
        scene.direction = s.direction || "vertical";
    } else if (s.type === "image" || s.type === "gif") {
        if (typeof s.asset !== "string") fail(`${path}.asset`, "expected asset name string");
        if (!(s.asset in (assets || {}))) fail(`${path}.asset`, `references unknown asset "${s.asset}"`);
        scene.asset = s.asset;
        if (s.fit !== undefined && !KNOWN_FIT.has(s.fit)) {
            fail(`${path}.fit`, `expected one of ${[...KNOWN_FIT].join("|")}, got "${s.fit}"`);
        }
        scene.fit = s.fit || "cover";
    } else if (s.type === "video") {
        if (typeof s.asset !== "string") fail(`${path}.asset`, "expected asset name string");
        if (!(s.asset in (assets || {}))) fail(`${path}.asset`, `references unknown asset "${s.asset}"`);
        scene.asset = s.asset;
        scene.muted = s.muted !== false;
    } else if (s.type === "pattern") {
        scene.pattern = typeof s.pattern === "string" ? s.pattern : "dots";
    } else if (s.type === "expression") {
        for (const c of ["r", "g", "b"]) {
            if (typeof s[c] !== "string") fail(`${path}.${c}`, "expression scenes require string expressions for r/g/b");
            scene[c] = s[c];
        }
        scene.seed = isFiniteNumber(s.seed) ? s.seed : 1;
    } else if (s.type === "composite") {
        if (!Array.isArray(s.layers)) fail(`${path}.layers`, "expected array");
        if (s.layers.length === 0) fail(`${path}.layers`, "composite needs at least one layer");
        scene.layers = s.layers.map((l, i) => normalizeLayer(l, `${path}.layers[${i}]`, warnings, assets));
    }

    return Object.freeze(scene);
}

function normalizeLayer(l, path, warnings, assets) {
    if (!l || typeof l !== "object") fail(path, "layer must be an object");

    // Compositing fields first (warnings reference layer path). All numeric
    // slots are E-values: number or expression string (§A0).
    const layerMeta = {};
    layerMeta.opacity = evalueNum(l.opacity, `${path}.opacity`, 0, 1, 1, warnings);
    if (l.blend !== undefined && !KNOWN_BLENDS.has(l.blend)) {
        fail(`${path}.blend`, `expected one of ${[...KNOWN_BLENDS].join("|")}, got "${l.blend}"`);
    }
    layerMeta.blend = l.blend || "normal";

    let rect = null;
    if (l.rect !== undefined && l.rect !== null) {
        if (typeof l.rect !== "object") fail(`${path}.rect`, "expected {x,y,w,h}");
        rect = Object.freeze({
            x: evalueNum(l.rect.x, `${path}.rect.x`, -1, 1, 0, warnings),
            y: evalueNum(l.rect.y, `${path}.rect.y`, -1, 1, 0, warnings),
            w: evalueNum(l.rect.w, `${path}.rect.w`, 0.01, 2, 1, warnings),
            h: evalueNum(l.rect.h, `${path}.rect.h`, 0.01, 2, 1, warnings)
        });
    }
    if (rect) layerMeta.rect = rect;

    let offset = null;
    if (l.offset !== undefined && l.offset !== null) {
        if (typeof l.offset !== "object") fail(`${path}.offset`, "expected {x,y}");
        offset = Object.freeze({
            x: evalueNum(l.offset.x, `${path}.offset.x`, -1, 1, 0, warnings),
            y: evalueNum(l.offset.y, `${path}.offset.y`, -1, 1, 0, warnings)
        });
    }
    if (offset) layerMeta.offset = offset;
    if (l.scale !== undefined && l.scale !== null) {
        layerMeta.scale = evalueNum(l.scale, `${path}.scale`, 0.01, 8, 1, warnings);
    }
    if (l.rotation !== undefined && l.rotation !== null) {
        layerMeta.rotation = evalueNum(l.rotation, `${path}.rotation`, -64, 64, 0, warnings);
        if (typeof l.rotation === "string" && expressionReferencesSpace(l.rotation)) {
            warnings.push(`${path}.rotation: layer transforms do not vary per-pixel; x/y/u/v are ignored here`);
        }
    }

    const content = normalizeSceneContent(l, path, warnings, assets);

    // Merge compositing fields into the frozen content copy.
    const merged = Object.assign({}, content, layerMeta);
    return Object.freeze(merged);
}

/**
 * Static detection (PLAN-CREATIVE.md §A4 — centralized rule).
 * A scene is STATIC iff:
 *  - no collected expression anywhere in the scene tree references t/frame,
 *  - no timeline keyframes exist, AND
 *  - the type is not inherently animated (gif/video).
 */
function sceneIsStatic(scene) {
    switch (scene.type) {
        case "gif":
        case "video":
            return false;
        default:
            return !treeReferencesTime(scene);
    }
}

export function validateAndNormalize(raw, baseUrl) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        fail("", "scene must be a JSON object");
    }
    assertNoPoison(raw, "");

    const warnings = [];

    // --- version ---
    if (raw.amo !== 1) {
        fail("amo", `unsupported version (${JSON.stringify(raw.amo)}); only 1 is supported`);
    }

    // --- unknown top-level fields → warning ---
    for (const k of Object.keys(raw)) {
        if (!KNOWN_TOP_LEVEL.has(k)) warnings.push(`.${k}: unknown field ignored`);
    }

    // --- meta ---
    const metaRaw = raw.meta || {};
    const meta = Object.freeze({
        name: typeof metaRaw.name === "string" ? metaRaw.name : "untitled",
        author: typeof metaRaw.author === "string" ? metaRaw.author : ""
    });

    // --- display ---
    const d = raw.display || {};
    for (const k of Object.keys(d)) {
        if (!KNOWN_DISPLAY.has(k)) warnings.push(`display.${k}: unknown field ignored`);
    }

    let pitch = null;
    if (d.pitch !== undefined && d.pitch !== null) {
        if (d.pitch === "auto") {
            pitch = null;
        } else if (isFiniteNumber(d.pitch)) {
            pitch = num(d.pitch, "display.pitch", 1, 24, null, warnings);
        } else {
            fail("display.pitch", `expected number or "auto", got ${JSON.stringify(d.pitch)}`);
        }
    }

    const brightnessRaw = d.brightness || {};
    const emittersRaw = d.emitters || {};
    const bloomRaw = d.bloom || {};
    const pentileRaw = d.pentile || {};

    const display = Object.freeze({
        pitch,
        gamma: num(d.gamma, "display.gamma", 0.5, 4, DISPLAY_DEFAULTS.gamma, warnings),
        activeLevel: num(brightnessRaw.active, "display.brightness.active", 0, 1, DISPLAY_DEFAULTS.activeLevel, warnings),
        inactiveLevel: num(brightnessRaw.inactive, "display.brightness.inactive", 0, 0.5, DISPLAY_DEFAULTS.inactiveLevel, warnings),
        spill: num(d.spill, "display.spill", 0, 0.6, DISPLAY_DEFAULTS.spill, warnings),
        maxOutput: channelTriple(emittersRaw.maxOutput, "display.emitters.maxOutput", 0, 1, DISPLAY_DEFAULTS.maxOutput, warnings),
        sigma: channelTriple(emittersRaw.sigma, "display.emitters.sigma", 0.001, 2, DISPLAY_DEFAULTS.sigma, warnings),
        bloom: (() => {
            const b = {
                intensity: num(bloomRaw.intensity, "display.bloom.intensity", 0, 1, DISPLAY_DEFAULTS.bloom.intensity, warnings),
                threshold: num(bloomRaw.threshold, "display.bloom.threshold", 0, 1, DISPLAY_DEFAULTS.bloom.threshold, warnings),
                power: num(bloomRaw.power, "display.bloom.power", 0.1, 8, DISPLAY_DEFAULTS.bloom.power, warnings),
                radius: num(bloomRaw.radius, "display.bloom.radius", 2, 40, DISPLAY_DEFAULTS.bloom.radius, warnings)
            };
            return Object.freeze(b);
        })(),
        pentile: Object.freeze({
            rowPitchFactor: num(pentileRaw.rowPitchFactor, "display.pentile.rowPitchFactor", 0.25, 2, DISPLAY_DEFAULTS.pentile.rowPitchFactor, warnings),
            blackMatrixRatio: num(pentileRaw.blackMatrixRatio, "display.pentile.blackMatrixRatio", 0, 0.6, DISPLAY_DEFAULTS.pentile.blackMatrixRatio, warnings),
            greenSizeRatio: num(pentileRaw.greenSizeRatio, "display.pentile.greenSizeRatio", 0.05, 1.5, DISPLAY_DEFAULTS.pentile.greenSizeRatio, warnings),
            diamondSizeRatio: num(pentileRaw.diamondSizeRatio, "display.pentile.diamondSizeRatio", 0.05, 1.5, DISPLAY_DEFAULTS.pentile.diamondSizeRatio, warnings)
        })
    });

    // --- quality ---
    const q = raw.quality || {};
    const logicalWidth = q.logicalResolution?.width;
    const logicalHeight = q.logicalResolution?.height;
    // Resolution is a hard constraint (reject, not clamp) per PLAN.md §5.3.
    const quality = Object.freeze({
        logicalWidth:
            logicalWidth === undefined || logicalWidth === null
                ? null
                : num(logicalWidth, "quality.logicalResolution.width", 64, 1280, null, warnings, false),
        logicalHeight:
            logicalHeight === undefined || logicalHeight === null
                ? null
                : num(logicalHeight, "quality.logicalResolution.height", 64, 1280, null, warnings, false),
        fps: num(q.fps, "quality.fps", 1, 60, QUALITY_DEFAULTS.fps, warnings),
        supersample: (() => {
            if (q.supersample === undefined || q.supersample === null || q.supersample === "auto") return null;
            if (![1, 2, 3, 4].includes(q.supersample)) {
                fail("quality.supersample", `expected "auto" | 1 | 2 | 3 | 4, got ${JSON.stringify(q.supersample)}`);
            }
            return q.supersample;
        })()
    });

    // --- assets ---
    const assets = {};
    if (raw.assets !== undefined && raw.assets !== null) {
        if (typeof raw.assets !== "object" || Array.isArray(raw.assets)) {
            fail("assets", "expected object of name -> url");
        }
        for (const name of Object.keys(raw.assets)) {
            const url = raw.assets[name];
            if (typeof url !== "string" || !url) fail(`assets.${name}`, "expected non-empty URL string");
            try {
                assets[name] = new URL(url, baseUrl || "file:///").href;
            } catch (e) {
                fail(`assets.${name}`, `unresolvable URL "${url}"`);
            }
        }
    }

    // --- scene ---
    const scene = normalizeSceneContent(raw.scene, "scene", warnings, assets);

    // --- timeline ---
    let timeline = null;
    const tl = raw.timeline;
    if (tl !== undefined && tl !== null) {
        if (typeof tl !== "object" || Array.isArray(tl)) fail("timeline", "expected object");

        const duration = num(tl.duration, "timeline.duration", 0.01, 3600, 8, warnings);
        const loop = tl.loop !== false;
        const easing = tl.easing || "smoothstep";
        if (!KNOWN_EASINGS.has(easing)) {
            fail("timeline.easing", `expected one of ${[...KNOWN_EASINGS].join("|")}, got "${easing}"`);
        }

        const keyframes = [];
        if (tl.keyframes !== undefined && tl.keyframes !== null) {
            if (!Array.isArray(tl.keyframes)) fail("timeline.keyframes", "expected array");
            for (let i = 0; i < tl.keyframes.length; i++) {
                const kf = tl.keyframes[i];
                const p = `timeline.keyframes[${i}]`;
                if (!kf || typeof kf !== "object") fail(p, "expected object");
                if (typeof kf.property !== "string") fail(`${p}.property`, "expected string");

                if (!isAnimatable(kf.property)) {
                    if (isStructural(kf.property)) {
                        fail(`${p}.property`, `"${kf.property}" is structural and cannot be keyframed (v1)`);
                    }
                    fail(`${p}.property`, `"${kf.property}" is not an animatable property`);
                }

                if (!Array.isArray(kf.keys) || kf.keys.length < 2) {
                    fail(`${p}.keys`, "expected array of at least 2 [time, value] pairs");
                }
                let lastT = -Infinity;
                const keys = kf.keys.map((pair, j) => {
                    if (!Array.isArray(pair) || pair.length !== 2) {
                        fail(`${p}.keys[${j}]`, "expected [time, value]");
                    }
                    if (!isFiniteNumber(pair[0]) || !isFiniteNumber(pair[1])) {
                        fail(`${p}.keys[${j}]`, "expected finite numbers");
                    }
                    if (pair[0] < lastT) fail(`${p}.keys[${j}]`, "times must be ascending");
                    lastT = pair[0];
                    return [pair[0], pair[1]];
                });

                keyframes.push(Object.freeze({ property: kf.property, keys, easing: kf.easing || easing }));
            }
        }

        timeline = Object.freeze({ duration, loop, keyframes });
    }

    // --- static detection (§5.8, extended to composite layers in Phase 6) ---
    let isStatic =
        sceneIsStatic(scene) &&
        (timeline === null || timeline.keyframes.length === 0);

    // Budget guardrail §3.5: warn above the guaranteed-smooth budget.
    if ((scene.type === "expression" ||
         (scene.type === "composite" && scene.layers.some(l => l.type === "expression"))) &&
        ((quality.logicalWidth || 0) > 480 || (quality.logicalHeight || 0) > 270)) {
        warnings.push("quality.logicalResolution: expression scene above the 480x270 smooth budget; may need the Phase 10 GPU path");
    }

    return {
        definition: {
            version: 1,
            meta,
            display,
            quality,
            assets: Object.freeze(assets),
            scene: Object.freeze(scene),
            timeline,
            isStatic
        },
        warnings
    };
}

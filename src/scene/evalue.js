// E-value infrastructure (PLAN-CREATIVE.md §A0/A1).
//
// An "E-value" is a property slot that accepts either a literal number or an
// expression STRING evaluating to a number. This module is the single choke
// point for parsing, compiling, caching, and evaluating such slots, plus the
// deep expression walker used for static detection.
//
// Slot evaluation contexts (documented contract):
//   - layer-level slots (opacity/scale/offset/rect/rotation): evaluated ONCE
//     per layer per frame with env {t, frame, width, height, progress, seed}.
//     x/y/u/v are NOT provided — layer transforms do not vary per-pixel.
//   - pixel-level slots (gradient/livingGradient channel colors, pattern
//     params): full env including x y u v, evaluated per pixel.
//
// DOM-free: safe to import in Node tests.

import { compileExpression, expressionReferencesTime } from "./expression.js";

// ------------------------------------------------------------------
// Slot compilation + caching
// ------------------------------------------------------------------

/**
 * Compile one slot spec into {kind:"const", value} or {kind:"expr", eval}.
 * Numbers (finite) are constants; anything else must be a string expression.
 */
export function compileSlot(spec) {
    if (typeof spec === "number" && Number.isFinite(spec)) {
        return { kind: "const", value: spec };
    }
    // Expression string.
    return { kind: "expr", eval: compileExpression(String(spec)).eval };
}

/** True when the slot spec is an expression string referencing t/frame. */
export function slotIsDynamic(spec) {
    return typeof spec === "string" && expressionReferencesTime(spec);
}

/** True when the spec is an expression string at all (vs literal). */
export function slotIsExpression(spec) {
    return typeof spec === "string";
}

const slotCache = new WeakMap(); // owner -> Map(key -> compiled slot)

/**
 * Resolve a named slot on an owner object, compiling+cached on first use.
 * @param {object} owner - frozen-ish scene/layer object (WeakMap key).
 * @param {string} key   - slot name on owner (e.g. "opacity").
 * @param {*} fallback   - value used when owner[key] == null.
 */
export function resolveNamed(owner, key, fallback, env) {
    let slots = slotCache.get(owner);
    if (!slots) {
        slots = new Map();
        slotCache.set(owner, slots);
    }
    let compiled = slots.get(key);
    if (compiled === undefined) {
        const raw = owner[key] === undefined || owner[key] === null ? fallback : owner[key];
        compiled = compileSlot(raw);
        slots.set(key, compiled);
    }
    if (compiled.kind === "const") return compiled.value;
    return compiled.eval(0, 0, env);
}

// ------------------------------------------------------------------
// Color slots
// ------------------------------------------------------------------

/**
 * Compile a color slot spec into an evaluator.
 * Accepts: {r,g,b} where each channel is a finite number OR expression
 * string. Returns { dynamic, eval(env, x, y) -> {r,g,b} floats } where
 * `dynamic` is true if any channel expression references time (caller still
 * evaluates per-frame either way; `dynamic` feeds static detection).
 */
export function compileColorSlot(spec) {
    const channels = {};
    let dynamic = false;
    let allConst = true;
    const constVals = { r: 0, g: 0, b: 0 };
    for (const c of ["r", "g", "b"]) {
        const raw = spec ? spec[c] : undefined;
        if (typeof raw === "string") {
            allConst = false;
            channels[c] = { kind: "expr", eval: compileExpression(raw).eval };
            if (expressionReferencesTime(raw)) dynamic = true;
        } else {
            const v = typeof raw === "number" && Number.isFinite(raw)
                ? Math.min(1, Math.max(0, raw)) : 0;
            channels[c] = { kind: "const", value: v };
            constVals[c] = v;
        }
    }
    if (allConst) {
        return {
            dynamic: false,
            allConst: true,
            r: constVals.r, g: constVals.g, b: constVals.b,
            eval: () => ({ ...constVals })
        };
    }
    const R = channels.r, G = channels.g, B = channels.b;
    return {
        dynamic,
        allConst: false,
        eval(x, y, env) {
            return {
                r: clamp01(R.kind === "const" ? R.value : R.eval(x, y, env)),
                g: clamp01(G.kind === "const" ? G.value : G.eval(x, y, env)),
                b: clamp01(B.kind === "const" ? B.value : B.eval(x, y, env))
            };
        }
    };
}

function clamp01(v) {
    return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

// ------------------------------------------------------------------
// Shared environment construction
// ------------------------------------------------------------------

/**
 * Build the shared evaluation env for time t. Pixel-level callers then set
 * x/y/u/v per pixel on the returned object.
 */
export function makeEnv(t, width, height, fps, duration, seed) {
    const fpsSafe = Math.max(1, fps || 30);
    return {
        t,
        frame: Math.floor(t * fpsSafe),
        width,
        height,
        u: 0, v: 0, x: 0, y: 0,
        seed: seed | 0,
        progress: duration > 0 ? Math.min(1, t / duration) : 0
    };
}

// ------------------------------------------------------------------
// Deep expression collection (static detection + tooling)
// ------------------------------------------------------------------

/**
 * Deep-walk any scene/layer/definition subtree collecting expression strings.
 * Strings are treated as expressions ONLY in numeric/color-channel slots;
 * since distinguishing "expression" from "color hex" requires slot knowledge,
 * this walker reports every string EXCEPT those starting with "#" and except
 * known non-expression string fields listed in SKIP_FIELDS.
 *
 * @returns {{path: string, source: string}[]}
 */
export function collectExpressions(root) {
    const out = [];
    visit(root, "", out);
    return out;
}

const SKIP_FIELDS = new Set(["type", "asset", "fit", "blend", "direction", "pattern", "behavior", "property", "easing"]);

function visit(node, path, out) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) visit(node[i], `${path}[${i}]`, out);
        return;
    }
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node)) {
        const v = node[k];
        const p = path ? `${path}.${k}` : k;
        if (typeof v === "string") {
            if (SKIP_FIELDS.has(k)) continue;
            if (v[0] !== "#") out.push({ path: p, source: v });
            continue;
        }
        if (v && typeof v === "object") visit(v, p, out);
    }
}

/**
 * Static-detection helper: does ANY collected expression in this tree
 * reference time?
 */
export function treeReferencesTime(root) {
    const exprs = collectExpressions(root);
    for (const e of exprs) {
        if (expressionReferencesTime(e.source)) return true;
    }
    return false;
}

/**
 * Does ONE expression source reference pixel coordinates (x|y|u|v)?
 * Used to warn when a layer-level transform slot would be spatially ignored.
 */
export function expressionReferencesSpace(source) {
    try {
        const { ast } = compileExpression(source);
        return astHasIdent(ast, SPACE_IDENTS);
    } catch (err) { /* reported at compile time elsewhere */ return false; }
}

const SPACE_IDENTS = new Set(["x", "y", "u", "v"]);

/** Any collected expression referencing space? */
export function treeReferencesSpace(root) {
    const exprs = collectExpressions(root);
    for (const e of exprs) {
        if (expressionReferencesSpace(e.source)) return true;
    }
    return false;
}

function astHasIdent(node, names) {
    if (!node || typeof node !== "object") return false;
    if (node.kind === "ident" && names.has(node.name)) return true;
    for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === "object") {
            if (astHasIdent(v, names)) return true;
        } else if (Array.isArray(v)) {
            for (const item of v) {
                if (item && typeof item === "object" && astHasIdent(item, names)) return true;
            }
        }
    }
    return false;
}

// Layered compositing (PLAN.md §Phase 6; extended by PLAN-CREATIVE.md §A2).
//
// Ordered layers composited bottom-up in a Float32 workspace, quantized
// ONCE to RGB bytes at the end (avoids repeated byte-rounding banding).
// Blend modes operate on normalized floats:
//   normal   : b
//   add      : a + b
//   multiply : a * b
//   screen   : 1 - (1-a)(1-b)
//   overlay  : a < .5 ? 2ab : 1 - 2(1-a)(1-b)
// All clamped on write.
//
// Layer-level properties (opacity/scale/rotation/offset/rect) are E-value
// slots (PLAN-CREATIVE.md §A0): number OR expression string. They are
// resolved ONCE per layer per frame with a time env — they do not vary
// per-pixel (validator warns if such an expression references x/y/u/v).

import { rasterizeScene } from "../scene/rasterizer.js";
import { resolveNamed, makeEnv, applyParameters } from "./evalue.js";

const BLEND = {
    normal: (a, b) => b,
    add: (a, b) => a + b,
    multiply: (a, b) => a * b,
    screen: (a, b) => 1 - (1 - a) * (1 - b),
    overlay: (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b))
};

// Stable zero defaults so WeakMap slot caches have a consistent key.
const ZERO_OFFSET = Object.freeze({ x: 0, y: 0 });
const FULL_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/**
 * @param {object[]} layers - normalized layer list (bottom-up).
 * @param {object} definition - full SceneDefinition (fps/duration/seed for env).
 * @param {number} t - scene time seconds.
 * @param {{width:number,height:number}} size
 * @param {object} assets - decoded assets.
 * @param {Uint8ClampedArray} [out] - reusable output.
 * @param {object} [workspaces] - reusable {f32:Float32Array, tmp:Uint8ClampedArray}.
 */
export function compositeLayers(layers, definition, t, size, assets, out, workspaces) {
    const w = size.width | 0;
    const h = size.height | 0;
    const n = w * h * 3;

    if (!out || out.length !== n) out = new Uint8ClampedArray(n);
    if (!workspaces || workspaces.f32.length !== n) {
        workspaces = { f32: new Float32Array(n), tmp: new Uint8ClampedArray(n) };
    }
    const ws = workspaces.f32;
    // Start from black.
    ws.fill(0);

    const q = definition && definition.quality ? definition.quality : {};
    const tl = definition && definition.timeline ? definition.timeline : {};
    const env = makeEnv(t, w, h, q.fps, tl.duration,
        definition && definition.scene && definition.scene.seed);
    applyParameters(env, definition && definition.parameters);

    for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        rasterizeScene(layer, definition, t, size, assets, workspaces.tmp);
        blendLayer(ws, workspaces.tmp, layer, w, h, env);
    }

    // Single quantization pass.
    for (let i = 0; i < n; i++) {
        const v = ws[i];
        out[i] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
    }
    return out;
}

function blendLayer(ws, src, layer, w, h, env) {
    const blendName = layer.blend || "normal";
    const isNormal = blendName === "normal";
    const fn = BLEND[blendName];

    // E-value layer slots: resolved once per frame.
    const opacity = clamp01(resolveNamed(layer, "opacity", 1, env));
    const scale = Math.max(0.01, resolveNamed(layer, "scale", 1, env));
    const rotation = resolveNamed(layer, "rotation", 0, env); // radians
    const offset = layer.offset || ZERO_OFFSET;
    const offX = resolveNamed(offset, "x", 0, env);
    const offY = resolveNamed(offset, "y", 0, env);
    const rect = layer.rect || FULL_RECT;

    // Normalized clip rect.
    const x0 = Math.max(0, Math.round(clampNum(resolveNamed(rect, "x", 0, env)) * w));
    const y0 = Math.max(0, Math.round(clampNum(resolveNamed(rect, "y", 0, env)) * h));
    const rw = clampNum(resolveNamed(rect, "w", 1, env));
    const rh = clampNum(resolveNamed(rect, "h", 1, env));
    const x1 = Math.min(w, Math.round((clampNum(resolveNamed(rect, "x", 0, env)) + rw) * w));
    const y1 = Math.min(h, Math.round((clampNum(resolveNamed(rect, "y", 0, env)) + rh) * h));

    const invScale = 1 / scale;
    const useTransform = scale !== 1 || offX !== 0 || offY !== 0 || rotation !== 0;

    if (useTransform && rotation !== 0) {
        blendTransformed(ws, src, layer, w, h, opacity, isNormal, fn,
            x0, y0, x1, y1, invScale, offX, offY, Math.cos(rotation), Math.sin(rotation));
        return;
    }
    if (useTransform) {
        blendScaled(ws, src, layer, w, h, opacity, isNormal, fn,
            x0, y0, x1, y1, invScale, offX, offY);
        return;
    }
    for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 3;
        for (let x = x0; x < x1; x++, i += 3) {
            blendPixel(ws, i, src, i, isNormal, fn, opacity);
        }
    }
}

function clampNum(v) {
    return Number.isFinite(v) ? v : 0;
}

// Full transform path: dest -> rotate^-1 -> scale^-1 -> center -> offset.
// With rotation === 0 this reduces exactly to the legacy scale+offset math.
function blendTransformed(ws, src, layer, w, h, opacity, isNormal, fn,
    x0, y0, x1, y1, invScale, offX, offY, cosR, sinR) {
    for (let y = y0; y < y1; y++) {
        const dy = (y + 0.5) / h - 0.5;
        for (let x = x0; x < x1; x++) {
            const dx = (x + 0.5) / w - 0.5;
            const sxn = (cosR * dx + sinR * dy) * invScale + 0.5 - offX;
            const syn = (-sinR * dx + cosR * dy) * invScale + 0.5 - offY;
            const sx = Math.round(sxn * w - 0.5);
            const sy = Math.round(syn * h - 0.5);
            if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
            blendPixel(ws, (y * w + x) * 3, src, (sy * w + sx) * 3, isNormal, fn, opacity);
        }
    }
}

// Legacy fast path: uniform scale around center + normalized offset.
function blendScaled(ws, src, layer, w, h, opacity, isNormal, fn,
    x0, y0, x1, y1, invScale, offX, offY) {
    const cx = 0.5;
    for (let y = y0; y < y1; y++) {
        const ny = ((y + 0.5) / h - cx) * invScale + cx - offY;
        const sy = Math.round(ny * h - 0.5);
        if (sy < 0 || sy >= h) continue;
        let i = (y * w + x0) * 3;
        for (let x = x0; x < x1; x++, i += 3) {
            const nx = ((x + 0.5) / w - cx) * invScale + cx - offX;
            const sx = Math.round(nx * w - 0.5);
            if (sx < 0 || sx >= w) continue;
            blendPixel(ws, i, src, (sy * w + sx) * 3, isNormal, fn, opacity);
        }
    }
}

function blendPixel(ws, i, src, j, isNormal, fn, opacity) {
    if (opacity === 0) return;
    const a0 = ws[i], a1 = ws[i + 1], a2 = ws[i + 2];
    // src is byte-encoded; normalize into the float workspace.
    let b0 = src[j] / 255, b1 = src[j + 1] / 255, b2 = src[j + 2] / 255;

    if (isNormal && opacity === 1) {
        ws[i] = b0; ws[i + 1] = b1; ws[i + 2] = b2;
        return;
    }
    if (isNormal) {
        // Alpha-over: out = top*op + base*(1-op).
        ws[i] = clamp01(b0 * opacity + a0 * (1 - opacity));
        ws[i + 1] = clamp01(b1 * opacity + a1 * (1 - opacity));
        ws[i + 2] = clamp01(b2 * opacity + a2 * (1 - opacity));
        return;
    }

    if (opacity !== 1) { b0 *= opacity; b1 *= opacity; b2 *= opacity; }
    ws[i] = clamp01(fn(a0, b0));
    ws[i + 1] = clamp01(fn(a1, b1));
    ws[i + 2] = clamp01(fn(a2, b2));
}

function clamp01(v) {
    return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

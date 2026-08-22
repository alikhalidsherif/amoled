// Layered compositing (PLAN.md §Phase 6).
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

import { rasterizeScene } from "../scene/rasterizer.js";

const BLEND = {
    normal: (a, b) => b,
    add: (a, b) => a + b,
    multiply: (a, b) => a * b,
    screen: (a, b) => 1 - (1 - a) * (1 - b),
    overlay: (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b))
};

/**
 * @param {object[]} layers - normalized layer list (bottom-up).
 * @param {number} t - scene time seconds.
 * @param {{width:number,height:number}} size
 * @param {object} assets - decoded assets.
 * @param {Uint8ClampedArray} [out] - reusable output.
 * @param {object} [workspaces] - reusable {f32:Float32Array, tmp:Uint8ClampedArray}.
 */
export function compositeLayers(layers, t, size, assets, out, workspaces) {
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

    for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        rasterizeScene(layer, null, t, size, assets, workspaces.tmp);
        blendLayer(ws, workspaces.tmp, layer, w, h);
    }

    // Single quantization pass.
    for (let i = 0; i < n; i++) {
        const v = ws[i];
        out[i] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
    }
    return out;
}

function blendLayer(ws, src, layer, w, h) {
    const blendName = layer.blend || "normal";
    const opacity = typeof layer.opacity === "number" ? layer.opacity : 1;

    // Normal blend with opacity is conventional alpha-over; additive-family
    // blends scale the layer's emitted energy by opacity instead.
    const isNormal = blendName === "normal";
    const fn = BLEND[blendName];

    // Normalized clip rect (defaults to full canvas).
    const clip = layer.rect || { x: 0, y: 0, w: 1, h: 1 };
    const x0 = Math.max(0, Math.round(clip.x * w));
    const y0 = Math.max(0, Math.round(clip.y * h));
    const x1 = Math.min(w, Math.round((clip.x + clip.w) * w));
    const y1 = Math.min(h, Math.round((clip.y + clip.h) * h));

    // v1 transform: uniform scale around center + normalized offset.
    const scale = typeof layer.scale === "number" && layer.scale > 0 ? layer.scale : 1;
    const offX = layer.offset && layer.offset.x ? layer.offset.x : 0;
    const offY = layer.offset && layer.offset.y ? layer.offset.y : 0;
    const useTransform = scale !== 1 || offX !== 0 || offY !== 0;
    const invScale = 1 / scale;
    const cx = 0.5;

    const skipBlend = opacity === 0;

    // Pixel loop shared by both paths.
    if (!useTransform) {
        for (let y = y0; y < y1; y++) {
            let i = (y * w + x0) * 3;
            for (let x = x0; x < x1; x++, i += 3) {
                blendPixel(ws, i, src, i, isNormal, fn, opacity);
            }
        }
        return;
    }

    for (let y = y0; y < y1; y++) {
        const ny = ((y + 0.5) / h - cx) * invScale + cx - offY;
        const sy = Math.round(ny * h - 0.5);
        if (sy < 0 || sy >= h) continue;
        let i = (y * w + x0) * 3;
        for (let x = x0; x < x1; x++, i += 3) {
            const nx = ((x + 0.5) / w - cx) * invScale + cx - offX;
            const sx = Math.round(nx * w - 0.5);
            if (sx < 0 || sx >= w) continue;
            blendPixel(ws, i, src, j(sx, sy), isNormal, fn, opacity);
        }
    }

    function j(sx, sy) { return (sy * w + sx) * 3; }
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

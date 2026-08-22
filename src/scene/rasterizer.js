// Scene rasterizer (PLAN.md §Phase 3): SceneDefinition + t → RGB buffer.
// CPU-only in v1. Steady-state per-frame paths allocate nothing when the
// caller supplies a reusable output buffer.

// Shared offscreen canvas for image fitting, cached per size.
let fitCanvas = null;
let fitCtx = null;

function ensureFitCanvas(w, h) {
    if (!fitCanvas || fitCanvas.width !== w || fitCanvas.height !== h) {
        if (typeof OffscreenCanvas === "function") {
            fitCanvas = new OffscreenCanvas(w, h);
        } else {
            fitCanvas = document.createElement("canvas");
            fitCanvas.width = w;
            fitCanvas.height = h;
        }
        fitCtx = fitCanvas.getContext("2d", { willReadFrequently: true });
    }
    return fitCtx;
}

function writeColor(out, r, g, b) {
    for (let i = 0, j = 0; j < out.length; i += 3) {
        out[j++] = r; out[j++] = g; out[j++] = b;
    }
    return out;
}

function rasterizeGradient(scene, w, h, out) {
    const from = scene.from;
    const to = scene.to;
    const dir = scene.direction || "vertical";
    const dr = to.r - from.r;
    const dg = to.g - from.g;
    const db = to.b - from.b;

    let i = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let t;
            switch (dir) {
                case "horizontal":
                    t = x / Math.max(1, w - 1);
                    break;
                case "diagonal":
                    t = (x / Math.max(1, w - 1) + y / Math.max(1, h - 1)) * 0.5;
                    break;
                case "radial": {
                    const cx = (x / Math.max(1, w - 1)) * 2 - 1;
                    const cy = (y / Math.max(1, h - 1)) * 2 - 1;
                    t = Math.min(1, Math.sqrt(cx * cx + cy * cy) * 0.7071);
                    break;
                }
                default: // vertical
                    t = y / Math.max(1, h - 1);
            }
            out[i++] = Math.round((from.r + dr * t) * 255);
            out[i++] = Math.round((from.g + dg * t) * 255);
            out[i++] = Math.round((from.b + db * t) * 255);
        }
    }
    return out;
}

// fit math shared with tests: returns {dx,dy,dw,dh} for drawing source into
// a w×h destination with cover/contain/stretch semantics.
export function computeFit(srcW, srcH, dstW, dstH, fit) {
    const srcAR = srcW / Math.max(1, srcH);
    const dstAR = dstW / Math.max(1, dstH);
    if (fit === "stretch") {
        return { dx: 0, dy: 0, dw: dstW, dh: dstH };
    }
    if (fit === "contain") {
        let dw = dstW, dh = Math.round(dstW / srcAR);
        if (dh > dstH) { dh = dstH; dw = Math.round(dstH * srcAR); }
        return { dx: Math.round((dstW - dw) / 2), dy: Math.round((dstH - dh) / 2), dw: Math.max(1, dw), dh: Math.max(1, dh) };
    }
    // cover
    let dw = dstW, dh = Math.round(dstW / srcAR);
    if (dh < dstH) { dh = dstH; dw = Math.round(dstH * srcAR); }
    return { dx: Math.round((dstW - dw) / 2), dy: Math.round((dstH - dh) / 2), dw: dw, dh: dh };
}

function rasterizeImage(scene, w, h, assets, out) {
    const bitmap = assets[scene.asset];
    if (!bitmap) throw new Error(`rasterize: asset "${scene.asset}" not loaded`);

    const ctx = ensureFitCanvas(w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const f = computeFit(bitmap.width, bitmap.height, w, h, scene.fit || "cover");
    ctx.drawImage(bitmap, f.dx, f.dy, f.dw, f.dh);

    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0, j = 0, n = w * h; i < n; i++) {
        out[j++] = data[i * 4];
        out[j++] = data[i * 4 + 1];
        out[j++] = data[i * 4 + 2];
    }
    return out;
}

/**
 * @param {object} definition - normalized SceneDefinition.
 * @param {number} _t - timeline time in seconds (unused by v1 static types).
 * @param {{width:number,height:number}} size - logical resolution.
 * @param {object} assets - name -> decoded asset (ImageBitmap).
 * @param {Uint8ClampedArray} [out] - reusable output buffer.
 * @returns {Uint8ClampedArray} packed RGB, length w*h*3.
 */
export function rasterize(definition, _t, size, assets, out) {
    const w = size.width | 0;
    const h = size.height | 0;
    const needed = w * h * 3;
    if (!out || out.length !== needed) {
        out = new Uint8ClampedArray(needed);
    }

    const scene = definition.scene;
    switch (scene.type) {
        case "color": {
            const c = scene.color;
            return writeColor(out,
                Math.round(c.r * 255),
                Math.round(c.g * 255),
                Math.round(c.b * 255));
        }
        case "gradient":
            return rasterizeGradient(scene, w, h, out);
        case "image":
            return rasterizeImage(scene, w, h, assets, out);
        default:
            throw new Error(`rasterize: unsupported scene type "${scene.type}"`);
    }
}

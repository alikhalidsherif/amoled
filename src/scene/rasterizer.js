// Scene rasterizer (PLAN.md §Phase 3/5): SceneDefinition + t → RGB buffer.
// CPU-only in v1. Steady-state per-frame paths allocate nothing when the
// caller supplies a reusable output buffer.

import { compileExpression } from "./expression.js";
import { compileColorSlot, resolveNamed, makeEnv } from "./evalue.js";

// Compiled expression programs, cached per scene object (WeakMap: frozen
// scene objects are valid keys; GC-friendly).
const programCache = new WeakMap();

function getProgram(scene) {
    let prog = programCache.get(scene);
    if (!prog) {
        prog = {
            r: compileExpression(scene.r),
            g: compileExpression(scene.g),
            b: compileExpression(scene.b)
        };
        programCache.set(scene, prog);
    }
    return prog;
}

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

function rasterizeGradient(scene, w, h, t, definition, out) {
    const from = compileColorSlot(scene.from);
    const to = compileColorSlot(scene.to);
    const dir = scene.direction || "vertical";

    if (from.allConst && to.allConst) {
        // Fast path: both stops constant.
        return rasterizeGradientConst(from.r, from.g, from.b, to.r, to.g, to.b, dir, w, h, out);
    }

    // Animated path: evaluate channel expressions per pixel.
    const env = sceneEnv(definition, t, w, h, scene.seed);
    let i = 0;
    for (let y = 0; y < h; y++) {
        env.y = y;
        env.v = h > 1 ? y / (h - 1) : 0;
        for (let x = 0; x < w; x++) {
            env.x = x;
            env.u = w > 1 ? x / (w - 1) : 0;
            const tt = axisCoord(dir, env.u, env.v);
            const a = from.eval(env.x, env.y, env);
            const b = to.eval(env.x, env.y, env);
            out[i++] = Math.round((a.r + (b.r - a.r) * tt) * 255);
            out[i++] = Math.round((a.g + (b.g - a.g) * tt) * 255);
            out[i++] = Math.round((a.b + (b.b - a.b) * tt) * 255);
        }
    }
    return out;
}

function rasterizeGradientConst(fr, fg, fb, tr, tg, tb, dir, w, h, out) {
    const dr = tr - fr, dg = tg - fg, db = tb - fb;
    let i = 0;
    for (let y = 0; y < h; y++) {
        const v = h > 1 ? y / (h - 1) : 0;
        for (let x = 0; x < w; x++) {
            const u = w > 1 ? x / (w - 1) : 0;
            const tt = axisCoord(dir, u, v);
            out[i++] = Math.round((fr + dr * tt) * 255);
            out[i++] = Math.round((fg + dg * tt) * 255);
            out[i++] = Math.round((fb + db * tt) * 255);
        }
    }
    return out;
}

/** Normalized [0,1] coordinate along the gradient direction. */
function axisCoord(dir, u, v) {
    switch (dir) {
        case "horizontal": return u;
        case "diagonal": return (u + v) * 0.5;
        case "radial": {
            const cx = u * 2 - 1, cy = v * 2 - 1;
            return Math.min(1, Math.sqrt(cx * cx + cy * cy) * 0.7071);
        }
        default: return v; // vertical
    }
}

// ------------------------------------------------------------------
// livingGradient — multi-stop animated gradient with wobble
// ------------------------------------------------------------------

const livingCache = new WeakMap();

function getLivingProgram(scene) {
    let prog = livingCache.get(scene);
    if (!prog) {
        const stops = [...scene.stops]
            .sort((a, b) => a.at - b.at)
            .map(s => ({ at: s.at, color: compileColorSlot(s.color) }));
        prog = { stops, dir: scene.direction || "vertical" };
        livingCache.set(scene, prog);
    }
    return prog;
}

function rasterizeLivingGradient(scene, w, h, t, definition, out) {
    const prog = getLivingProgram(scene);
    const env = sceneEnv(definition, t, w, h, scene.seed);
    const ampSlot = typeof scene.wobble === "string"
        ? compileExpression(scene.wobble).eval
        : null;
    const ampConst = typeof scene.wobble === "number" ? scene.wobble : 0;

    const stops = prog.stops;
    const n = stops.length;
    let i = 0;
    for (let y = 0; y < h; y++) {
        env.y = y;
        env.v = h > 1 ? y / (h - 1) : 0;
        for (let x = 0; x < w; x++) {
            env.x = x;
            env.u = w > 1 ? x / (w - 1) : 0;

            let tt = axisCoord(prog.dir, env.u, env.v);
            if (ampSlot !== null) {
                const amp = ampSlot(env.x, env.y, env);
                if (amp !== 0) {
                    tt += amp * Math.sin(tt * 6.28318 + env.t * 1.5);
                }
            } else if (ampConst !== 0) {
                tt += ampConst * Math.sin(tt * 6.28318 + env.t * 1.5);
            }
            if (tt < 0) tt = 0; else if (tt > 1) tt = 1;

            // Piecewise-linear stop interpolation.
            let r, g, b;
            if (tt <= stops[0].at) {
                ({ r, g, b } = stops[0].color.eval(env.x, env.y, env));
            } else if (tt >= stops[n - 1].at) {
                ({ r, g, b } = stops[n - 1].color.eval(env.x, env.y, env));
            } else {
                let k = 1;
                while (k < n && stops[k].at < tt) k++;
                const A = stops[k - 1], B = stops[k];
                const f = B.at === A.at ? 0 : (tt - A.at) / (B.at - A.at);
                const ca = A.color.eval(env.x, env.y, env);
                const cb = B.color.eval(env.x, env.y, env);
                r = ca.r + (cb.r - ca.r) * f;
                g = ca.g + (cb.g - ca.g) * f;
                b = ca.b + (cb.b - ca.b) * f;
            }
            out[i++] = Math.round(r * 255);
            out[i++] = Math.round(g * 255);
            out[i++] = Math.round(b * 255);
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

function rasterizeExpression(definition, scene, w, h, t, out) {
    const prog = getProgram(scene);
    const fps = definition && definition.quality ? definition.quality.fps : 30;
    const E = {
        t,
        frame: Math.floor(t * Math.max(1, fps || 30)),
        width: w,
        height: h,
        u: 0, v: 0,
        seed: scene.seed | 0,
        progress: 0
    };
    if (definition.timeline && definition.timeline.duration > 0) {
        E.progress = Math.min(1, t / definition.timeline.duration);
    }

    const { eval: evalR } = prog.r;
    const { eval: evalG } = prog.g;
    const { eval: evalB } = prog.b;

    let i = 0;
    for (let y = 0; y < h; y++) {
        E.y = y;
        E.v = h > 1 ? y / (h - 1) : 0;
        for (let x = 0; x < w; x++) {
            E.x = x;
            E.u = w > 1 ? x / (w - 1) : 0;
            // Expressions yield normalized floats [0,1]; scale to bytes.
            // Uint8ClampedArray clamps overflow and rounds NaN -> 0.
            out[i++] = evalR(x, y, E) * 255;
            out[i++] = evalG(x, y, E) * 255;
            out[i++] = evalB(x, y, E) * 255;
        }
    }
    return out;
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

/** Shared per-frame env for pixel-level E-value evaluation. */
function sceneEnv(definition, t, w, h, seed) {
    const q = definition && definition.quality ? definition.quality : {};
    const tl = definition && definition.timeline ? definition.timeline : {};
    return makeEnv(t, w, h, q.fps, tl.duration, seed);
}

/**
 * @param {object} definition - normalized SceneDefinition.
 * @param {number} t - timeline time in seconds.
 * @param {{width:number,height:number}} size - logical resolution.
 * @param {object} assets - name -> decoded asset (ImageBitmap).
 * @param {Uint8ClampedArray} [out] - reusable output buffer.
 * @returns {Uint8ClampedArray} packed RGB, length w*h*3.
 */
export function rasterize(definition, t, size, assets, out) {
    if (definition.scene.type === "composite") {
        return compositeLayers(definition.scene.layers, definition, t, size, assets, out);
    }
    return rasterizeScene(definition.scene, definition, t, size, assets, out);
}

/**
 * Rasterize ONE scene content object (no compositing). Exported for the
 * compositor, which calls it per layer.
 */
export function rasterizeScene(scene, definition, t, size, assets, out) {
    const w = size.width | 0;
    const h = size.height | 0;
    const needed = w * h * 3;
    if (!out || out.length !== needed) {
        out = new Uint8ClampedArray(needed);
    }

    switch (scene.type) {
        case "color": {
            const c = compileColorSlot(scene.color);
            if (c.allConst) {
                return writeColor(out,
                    Math.round(c.r * 255),
                    Math.round(c.g * 255),
                    Math.round(c.b * 255));
            }
            // Animated color: evaluate channel expressions per pixel.
            const env = sceneEnv(definition, t, w, h, scene.seed);
            let k = 0;
            for (let y = 0; y < h; y++) {
                env.y = y;
                env.v = h > 1 ? y / (h - 1) : 0;
                for (let x = 0; x < w; x++) {
                    env.x = x;
                    env.u = w > 1 ? x / (w - 1) : 0;
                    const v = c.eval(env.x, env.y, env);
                    out[k++] = Math.round(v.r * 255);
                    out[k++] = Math.round(v.g * 255);
                    out[k++] = Math.round(v.b * 255);
                }
            }
            return out;
        }
        case "gradient":
            return rasterizeGradient(scene, w, h, t, definition, out);
        case "livingGradient":
            return rasterizeLivingGradient(scene, w, h, t, definition, out);
        case "expression":
            return rasterizeExpression(definition || { quality: { fps: 30 } }, scene, w, h, t, out);
        case "image":
            return rasterizeImage(scene, w, h, assets, out);
        default:
            throw new Error(`rasterize: unsupported scene type "${scene.type}"`);
    }
}

// Late-bound to avoid circular import at module evaluation time.
import { compositeLayers } from "./compositor.js";

// Scene rasterizer (PLAN.md §Phase 3/5): SceneDefinition + t → RGB buffer.
// CPU-only in v1. Steady-state per-frame paths allocate nothing when the
// caller supplies a reusable output buffer.

import { compileRuntimeExpr } from "./evalue.js";
import { compileColorSlot, resolveNamed, makeEnv, applyParameters } from "./evalue.js";

// Compiled expression programs, cached per scene object (WeakMap: frozen
// scene objects are valid keys; GC-friendly). Programs are parameter-agnostic:
// declared parameter identifiers resolve from the env at evaluation time.
const programCache = new WeakMap();

function getProgram(scene) {
    let prog = programCache.get(scene);
    if (!prog) {
        prog = {
            r: compileRuntimeExpr(scene.r),
            g: compileRuntimeExpr(scene.g),
            b: compileRuntimeExpr(scene.b)
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
// Pattern generators (PLAN-CREATIVE.md §B1)
// ------------------------------------------------------------------

const PATTERN_VARIANTS = new Set(["dots", "checks", "stripes", "scanlines", "halftone"]);
const patternCache = new WeakMap();

function getPatternProgram(scene) {
    let prog = patternCache.get(scene);
    if (!prog) {
        prog = {
            fg: compileColorSlot(scene.fg),
            bg: compileColorSlot(scene.bg),
            signal: typeof scene.signal === "string"
                ? compileRuntimeExpr(scene.signal) : null
        };
        patternCache.set(scene, prog);
    }
    return prog;
}

function smoothCov(edge, softness, d) {
    // 1 inside (d < edge), 0 outside; `softness` feathers the boundary.
    const hi = edge + softness, lo = edge - softness;
    if (hi <= lo) return d < edge ? 1 : 0;
    if (d >= hi) return 0;
    if (d <= lo) return 1;
    const u = (hi - d) / (hi - lo);
    return u * u * (3 - 2 * u);
}

function rasterizePattern(scene, w, h, t, definition, out) {
    const prog = getPatternProgram(scene);
    const env = sceneEnv(definition, t, w, h, scene.seed);
    const variant = scene.pattern || "dots";

    // Per-frame resolution of scalar slots when they are constants (common);
    // expression slots fall into the per-pixel path below.
    const numOrExpr = spec => (typeof spec === "number" ? () => spec : null);
    const sizeF = numOrExpr(scene.size) || compileRuntimeExpr(String(scene.size));
    const thickF = scene.thickness === undefined ? null
        : (numOrExpr(scene.thickness) || compileRuntimeExpr(String(scene.thickness)));
    const softF = scene.softness === undefined ? null
        : (numOrExpr(scene.softness) || compileRuntimeExpr(String(scene.softness)));
    const angleF = scene.angle === undefined ? null
        : (numOrExpr(scene.angle) || compileRuntimeExpr(String(scene.angle)));
    const offXF = scene.offset && scene.offset.x !== undefined && typeof scene.offset.x !== "number"
        ? compileRuntimeExpr(scene.offset.x) : null;
    const offYF = scene.offset && scene.offset.y !== undefined && typeof scene.offset.y !== "number"
        ? compileRuntimeExpr(scene.offset.y) : null;

    let i = 0;
    for (let y = 0; y < h; y++) {
        env.y = y;
        env.v = h > 1 ? y / (h - 1) : 0;
        for (let x = 0; x < w; x++) {
            env.x = x;
            env.u = w > 1 ? x / (w - 1) : 0;

            const size = Math.max(1, sizeF(env.x, env.y, env));
            const thickness = thickF ? clampf(thickF(env.x, env.y, env)) : 0.5;
            const softness = softF ? Math.max(0, softF(env.x, env.y, env)) : 0;
            const angle = angleF ? angleF(env.x, env.y, env) : 0;
            const offX = offXF ? offXF(env.x, env.y, env) * w : (scene.offset ? (scene.offset.x || 0) * w : 0);
            const offY = offYF ? offYF(env.x, env.y, env) * h : (scene.offset ? (scene.offset.y || 0) * h : 0);

            // Rotate sample point about canvas center, after translation.
            const px = x + 0.5 - offX - w / 2;
            const py = y + 0.5 - offY - h / 2;
            let sx = px, sy = py;
            if (angle !== 0) {
                const c = Math.cos(angle), s = Math.sin(angle);
                sx = c * px - s * py;
                sy = s * px + c * py;
            }
            sx += w / 2;
            sy += h / 2;

            const fx = (sx % size + size) % size / size;   // [0,1)
            const fy = (sy % size + size) % size / size;
            const cellX = Math.floor(sx / size);
            const cellY = Math.floor(sy / size);

            let cov = 0;
            switch (variant) {
                case "dots": {
                    const dxp = fx - 0.5, dyp = fy - 0.5;
                    cov = smoothCov(thickness * 0.5, softness, Math.hypot(dxp, dyp));
                    break;
                }
                case "checks": {
                    const parity = (Math.abs(cellX % 2) + Math.abs(cellY % 2)) % 2;
                    const d = Math.min(fx, 1 - fx, fy, 1 - fy) * 2;   // distance to cell border
                    cov = parity === 0 ? smoothCov(1, softness * 2 + 1e-6, d) : 0;
                    break;
                }
                case "stripes": {
                    cov = smoothCov(thickness * 0.5, softness, Math.abs(fy - 0.5));
                    break;
                }
                case "scanlines": {
                    // Horizontal lines with size counted in logical rows.
                    const rowPhase = ((sy % 1) + 1) % 1;
                    cov = smoothCov(thickness * 0.5, softness, Math.abs(rowPhase - 0.5));
                    break;
                }
                case "halftone": {
                    let sig = 0.5;
                    if (prog.signal) sig = clampf(prog.signal(env.x, env.y, env));
                    const dxp = fx - 0.5, dyp = fy - 0.5;
                    cov = smoothCov(thickness * 0.5 * sig, softness, Math.hypot(dxp, dyp));
                    break;
                }
            }

            let col;
            if (cov <= 0) col = bgColor(prog, env.x, env.y, env);
            else if (cov >= 1) col = fgColor(prog, env.x, env.y, env);
            else {
                const f = fgColor(prog, env.x, env.y, env);
                const b = bgColor(prog, env.x, env.y, env);
                col = {
                    r: b.r + (f.r - b.r) * cov,
                    g: b.g + (f.g - b.g) * cov,
                    b: b.b + (f.b - b.b) * cov
                };
            }
            out[i++] = Math.round(col.r * 255);
            out[i++] = Math.round(col.g * 255);
            out[i++] = Math.round(col.b * 255);
        }
    }
    return out;
}

function clampf(v) {
    return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}
function bgColor(prog, x, y, env) {
    return prog.bg.allConst ? prog.bg : prog.bg.eval(x, y, env);
}
function fgColor(prog, x, y, env) {
    return prog.fg.allConst ? prog.fg : prog.fg.eval(x, y, env);
}

// ------------------------------------------------------------------
// Particles (PLAN-CREATIVE.md §B3) — stateless, deterministic.
// Position of particle i at time t is a closed-form function of hashed
// constants, so scrubbing/seeking is exact and output is reproducible.
// ------------------------------------------------------------------

import { mulberry32 } from "./prng.js";

function rasterizeParticles(scene, w, h, t, definition, out) {
    out.fill(0);
    const count = scene.count | 0;
    if (count <= 0) return out;

    const env = sceneEnv(definition, t, w, h, scene.seed);
    const seed = scene.seed | 0;
    const behavior = scene.behavior || "drift";
    const glow = typeof scene.glow === "number" ? scene.glow
        : (typeof scene.glow === "string"
            ? clampf(compileRuntimeExpr(scene.glow)(env.x, env.y, env)) : 0.6);
    const baseSpeed = typeof scene.speed === "number" ? scene.speed
        : (typeof scene.speed === "string"
            ? Math.max(0, compileRuntimeExpr(String(scene.speed))(env.x, env.y, env)) : 0.2);
    const palette = Array.isArray(scene.color) ? scene.color : [scene.color];

    for (let i = 0; i < count; i++) {
        const rnd = mulberry32((seed * 7919 + i * 2654435761) >>> 0);
        const px0 = rnd(), py0 = rnd(), ph = rnd() * Math.PI * 2;
        const jit = 0.4 + rnd() * 1.2;          // per-particle speed jitter
        const sizeFrac = rnd();
        const col = palette[i % palette.length];

        // Per-particle position (normalized coords), by behavior.
        let x, y, brightness = 1;
        const sp = baseSpeed * jit;
        switch (behavior) {
            case "orbit": {
                const cxp = 0.2 + px0 * 0.6, cyp = 0.2 + py0 * 0.6;
                const rr = 0.05 + sizeFrac * 0.25;
                x = cxp + Math.cos(ph + sp * t / Math.max(0.02, rr)) * rr;
                y = cyp + Math.sin(ph + sp * t / Math.max(0.02, rr)) * rr * 0.7;
                break;
            }
            case "rise":
                x = wrap01(px0 + 0.03 * Math.sin(t * sp * 3 + ph));
                y = wrap01(py0 - sp * 0.25 * t);
                break;
            case "fall":
            case "snow":
                x = wrap01(px0 + (behavior === "snow" ? 0.06 : 0.02) * Math.sin(t * sp * 2 + ph));
                y = wrap01(py0 + sp * (behavior === "snow" ? 0.08 : 0.18) * t);
                break;
            case "fireflies": {
                x = wrap01(px0 + 0.05 * Math.sin(t * sp + ph) );
                y = wrap01(py0 + 0.04 * Math.cos(t * sp * 0.8 + ph * 2));
                brightness = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (1 + sp * 3) + ph * 6));
                break;
            }
            default: { // drift
                x = wrap01(px0 + sp * 0.06 * t);
                y = wrap01(py0 + sp * 0.015 * Math.sin(t * 0.7 + ph));
                break;
            }
        }

        // Splat a soft disc.
        const rNorm = scene.size.min + (scene.size.max - scene.size.min) * sizeFrac;
        const rPx = Math.max(0.75, rNorm * h);
        const falloff = 1 + 3 * (1 - glow);   // higher = harder edge
        const cxp = x * w, cyp = y * h;
        const x0 = Math.max(0, Math.floor(cxp - rPx * 2));
        const x1 = Math.min(w - 1, Math.ceil(cxp + rPx * 2));
        const y0 = Math.max(0, Math.floor(cyp - rPx * 2));
        const y1 = Math.min(h - 1, Math.ceil(cyp + rPx * 2));

        for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
                const d = Math.hypot(xx + 0.5 - cxp, yy + 0.5 - cyp);
                if (d >= rPx * 2) continue;
                let k = 1 - d / (rPx * 2);        // 1 center -> 0 edge
                k = Math.pow(k, falloff);
                const I = k * brightness;
                const j = (yy * w + xx) * 3;
                out[j] += col.r * 255 * I;
                out[j + 1] += col.g * 255 * I;
                out[j + 2] += col.b * 255 * I;
            }
        }
    }
    return out;
}

function wrap01(v) {
    return v - Math.floor(v);
}

// ------------------------------------------------------------------
// Parametric curves (PLAN-CREATIVE.md — math art: Lissajous, harmonographs,
// roses, spirographs). Expressions x(p)/y(p) with p ∈ [0,1] map to screen
// space (−1..1 scaled by height, aspect-correct); strokes accumulate
// additively so crossings glow like neon silk.
// CPU-only (the GLSL backend targets per-pixel expression scenes).
// ------------------------------------------------------------------

const curveCache = new WeakMap();

function getCurveProgram(scene) {
    let prog = curveCache.get(scene);
    if (!prog) {
        prog = {
            x: compileRuntimeExpr(String(scene.x)),
            y: compileRuntimeExpr(String(scene.y)),
            color: scene.color ?? { r: 0, g: 1, b: 0.8 },
            bg: compileColorSlot(scene.bg ?? "#000000")
        };
        curveCache.set(scene, prog);
    }
    return prog;
}

function rasterizeCurve(scene, w, h, t, definition, out) {
    const prog = getCurveProgram(scene);
    const env = sceneEnv(definition, t, w, h, scene.seed);

    // Background fill.
    if (prog.bg.allConst) {
        writeColor(out,
            Math.round(prog.bg.r * 255),
            Math.round(prog.bg.g * 255),
            Math.round(prog.bg.b * 255));
    } else {
        let i = 0;
        for (let y = 0; y < h; y++) {
            env.y = y; env.v = h > 1 ? y / (h - 1) : 0;
            for (let x = 0; x < w; x++) {
                env.x = x; env.u = w > 1 ? x / (w - 1) : 0;
                const c = prog.bg.eval(env.x, env.y, env);
                out[i++] = Math.round(c.r * 255);
                out[i++] = Math.round(c.g * 255);
                out[i++] = Math.round(c.b * 255);
            }
        }
    }

    const samples = Math.max(16, scene.samples | 0 || 800);
    const thickness = typeof scene.thickness === "number" ? scene.thickness : 0.012;
    const rPx = Math.max(0.6, thickness * h * 0.5);
    const glow = typeof scene.glow === "number"
        ? scene.glow
        : (typeof scene.glow === "string" ? clampf(compileRuntimeExpr(scene.glow)(0, 0, env)) : 0.6);
    const falloff = 1 + 3 * (1 - glow);
    const decay = typeof scene.decay === "number" ? scene.decay : 0;
    const col = prog.color;
    const colR = col.r * 255, colG = col.g * 255, colB = col.b * 255;

    // Scale by height so circles stay circular on any aspect.
    const scale = h / 2;
    const cx = w / 2, cy = h / 2;

    let prevX = null, prevY = null;
    for (let i = 0; i <= samples; i++) {
        const p = i / samples;
        env.p = p;
        env.u = p;
        let px = prog.x(0, 0, env);
        let py = prog.y(0, 0, env);
        if (!Number.isFinite(px)) px = 0;
        if (!Number.isFinite(py)) py = 0;
        if (decay > 0) {
            const amp = Math.exp(-decay * p * 6.28318);
            px *= amp; py *= amp;
        }
        const sxp = cx + px * scale;
        const syp = cy - py * scale;   // math y-up

        if (prevX !== null) {
            splatSegment(out, w, h, prevX, prevY, sxp, syp, rPx, falloff, colR, colG, colB);
        }
        prevX = sxp; prevY = syp;
    }
    return out;
}

/** Additive soft stroke between two points. */
function splatSegment(out, w, h, ax, ay, bx, by, rPx, falloff, cr, cg, cb) {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - rPx));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + rPx));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - rPx));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by) + rPx));
    if (minX > maxX || minY > maxY) return;

    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5 - ax, py = y + 0.5 - ay;
            let tt = lenSq > 0 ? (px * dx + py * dy) / lenSq : 0;
            tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
            const qx = ax + dx * tt, qy = ay + dy * tt;
            const d = Math.hypot(x + 0.5 - qx, y + 0.5 - qy);
            if (d >= rPx * 2) continue;
            let k = 1 - d / (rPx * 2);
            k = Math.pow(k, falloff);
            const j = (y * w + x) * 3;
            out[j] += cr * k;
            out[j + 1] += cg * k;
            out[j + 2] += cb * k;
        }
    }
}

// ------------------------------------------------------------------
// Flow field / living noise (PLAN-CREATIVE.md §B2)
// ------------------------------------------------------------------

import { fbm } from "./prng.js";

function rasterizeFlow(scene, w, h, t, definition, out) {
    const env = sceneEnv(definition, t, w, h, scene.seed);
    const pal = scene.palette;                       // frozen [{r,g,b}] consts
    const segs = pal.length - 1;
    const oct = scene.octaves | 0;
    const seed = scene.seed | 0;

    const scalar = (spec, fallback) => {
        if (spec === undefined || spec === null) return () => fallback;
        return typeof spec === "number" ? () => spec : compileRuntimeExpr(String(spec));
    };
    const scaleF = scalar(scene.scale, 3.5);
    const speedF = scalar(scene.speed, 0.12);
    const warpF = scalar(scene.warp, 0.5);
    const contrastF = scalar(scene.contrast, 1);

    let i = 0;
    for (let y = 0; y < h; y++) {
        env.y = y;
        env.v = h > 1 ? y / (h - 1) : 0;
        for (let x = 0; x < w; x++) {
            env.x = x;
            env.u = w > 1 ? x / (w - 1) : 0;

            const sc = Math.max(0.05, scaleF(env.x, env.y, env));
            const sp = speedF(env.x, env.y, env);
            const wp = Math.max(0, warpF(env.x, env.y, env));
            let p;
            if (wp > 0) {
                // Domain warping: fbm(p + w * vec(fbm(p+a), fbm(p+b))).
                const nx = env.u * sc, ny = env.v * sc;
                const wx = fbm(seed + 7777, nx * 0.7 + 5.2, ny * 0.7 + 1.3, oct);
                const wy = fbm(seed + 8888, nx * 0.7 - 3.1, ny * 0.7 + 4.7, oct);
                p = fbm(seed, nx + wp * wx * 2, ny + wp * wy * 2 + sp * env.t, oct);
            } else {
                p = fbm(seed, env.u * sc, env.v * sc + sp * env.t, oct);
            }

            const contrast = contrastF(env.x, env.y, env);
            p = Math.min(1, Math.max(0, 0.5 + (p - 0.5) * contrast));

            // Palette ramp with smoothstep between stops.
            const pos = p * segs;
            let k = Math.floor(pos);
            if (k >= segs) k = segs - 1;
            let f = pos - k;
            f = f * f * (3 - 2 * f);
            const A = pal[k], B = pal[k + 1];
            out[i++] = Math.round((A.r + (B.r - A.r) * f) * 255);
            out[i++] = Math.round((A.g + (B.g - A.g) * f) * 255);
            out[i++] = Math.round((A.b + (B.b - A.b) * f) * 255);
        }
    }
    return out;
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
        ? compileRuntimeExpr(scene.wobble)
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
    applyParameters(E, definition.parameters);

    const evalR = prog.r;
    const evalG = prog.g;
    const evalB = prog.b;

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
    const env = makeEnv(t, w, h, q.fps, tl.duration, seed);
    applyParameters(env, definition && definition.parameters);
    return env;
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
        case "pattern":
            return rasterizePattern(scene, w, h, t, definition, out);
        case "flow":
            return rasterizeFlow(scene, w, h, t, definition, out);
        case "particles":
            return rasterizeParticles(scene, w, h, t, definition, out);
        case "curve":
            return rasterizeCurve(scene, w, h, t, definition, out);
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

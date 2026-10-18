(function attachAttract(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});
    const TAU = Math.PI * 2;

    // Small deterministic PRNG (mulberry32) — butterfly layout must be
    // stable across frames for a given seed.
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

    function hslToRgb(h, s, l) {
        const a = s * Math.min(l, 1 - l);
        const f = n => {
            const k = (n + h * 12) % 12;
            return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        };
        return [f(0), f(8), f(4)];
    }

    // Squared distance from point (px,py) to segment A-B.
    function segDistSq(px, py, ax, ay, bx, by) {
        const vx = bx - ax, vy = by - ay;
        const wx = px - ax, wy = py - ay;
        const len = vx * vx + vy * vy;
        const t = len > 0 ? clamp01((wx * vx + wy * vy) / len) : 0;
        const dx = wx - vx * t, dy = wy - vy * t;
        return dx * dx + dy * dy;
    }

    // Wing lobes in body-local units (span ≈ 1): cx/rot already mirrored
    // per side; cy is the same for both sides. Indices 0..1 = right wing,
    // 2..3 = left wing, 4..5 = swallowtail extensions. Per-butterfly
    // jitter in makeButterfly perturbs these so no two silhouettes match.
    const WING_LOBES = [
        { cx: 0.46, cy: -0.32, a: 0.50, b: 0.44, rot: -0.50, kind: 0 },
        { cx: 0.40, cy: 0.32, a: 0.36, b: 0.33, rot: 0.36, kind: 0 },
        { cx: -0.46, cy: -0.32, a: 0.50, b: 0.44, rot: 0.50, kind: 0 },
        { cx: -0.40, cy: 0.32, a: 0.36, b: 0.33, rot: -0.36, kind: 0 },
        { cx: 0.44, cy: 0.58, a: 0.13, b: 0.25, rot: 0.30, kind: 1 },
        { cx: -0.44, cy: 0.58, a: 0.13, b: 0.25, rot: -0.30, kind: 1 }
    ];

    function makeButterfly(rand, w, h, index, count) {
        // Stratified horizontal placement so butterflies spread evenly;
        // inset by the butterfly's own reach so nothing clips the edges.
        const size = Math.min(w, h) * (0.12 + 0.11 * rand());
        const reach = size * 0.85;
        const colW = w / count;
        const px = Math.min(
            Math.max((index + 0.15 + 0.7 * rand()) * colW, reach + 2),
            w - reach - 2
        );
        const py = Math.min(
            Math.max((0.16 + 0.68 * rand()) * h, reach + 2),
            h - reach - 2
        );

        const hue = (index / count + 0.08 * rand() + 0.04) % 1;
        // Iridescent gradient: brighter, hue-shifted near the body; deeper
        // toward the rim. Slight per-butterfly luminance variance keeps the
        // flock from reading as one flat palette.
        const lum = 0.50 + 0.13 * rand();
        const hShift = (rand() - 0.5) * 0.11;

        return {
            baseX: px,
            baseY: py,
            size,
            hue,
            phase: rand() * TAU,
            driftA: 0.02 + 0.035 * rand(),
            driftT: 13 + 9 * rand(),
            bobT: 9 + 7 * rand(),
            bobPhase: rand() * TAU,
            angle0: -0.22 + 0.44 * rand(),
            angleT: 11 + 8 * rand(),
            anglePhase: rand() * TAU,
            flapHz: 1.7 + 1.5 * rand(),
            flapPhase: rand() * TAU,
            brightness: 0.72 + 0.28 * rand(),
            // Wing-edge ripple (scalloped silhouette) + per-butterfly lobe jitter.
            scallop: 0.045 + 0.035 * rand(),
            scallopPhase: rand() * TAU,
            lobes: WING_LOBES.map(L => ({
                cx: L.cx * (0.94 + 0.12 * rand()),
                cy: L.cy + (rand() - 0.5) * 0.06,
                a: L.a * (0.92 + 0.16 * rand()),
                b: L.b * (0.90 + 0.20 * rand()),
                rot: L.rot + (rand() - 0.5) * 0.16,
                kind: L.kind
            })),
            cIn: hslToRgb((hue + hShift + 1) % 1, 0.86, Math.min(0.68, lum + 0.14)),
            cOut: hslToRgb(hue, 0.85, lum)
        };
    }

    /**
     * Ambient attract frame: multicolored butterflies drifting over black.
     * Pure procedural content for the landing page — not part of the .amo
     * scene system. Output matches the engine framebuffer format
     * (Uint8ClampedArray, RGB, sRGB values).
     */
    function createButterflyFrame(width, height, t, opts) {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        const count = Math.max(1, (opts && opts.count) | 0 || 8);
        const seed = (opts && opts.seed) | 0 || 7;
        const data = new Uint8ClampedArray(w * h * 3);

        const time = Number.isFinite(t) ? t : 0;
        const rand = mulberry32(seed);

        for (let i = 0; i < count; i++) {
            const b = makeButterfly(rand, w, h, i, count);

            // Drift: a fast sine layered over a slow one so the path
            // meanders instead of tracing a perfect Lissajous loop.
            const w1 = TAU / b.driftT;
            const w2 = TAU / (b.driftT * 2.6);
            const wander = 0.68 * Math.sin(w1 * time + b.phase)
                + 0.32 * Math.sin(w2 * time + b.phase * 1.7);
            const x = b.baseX + wander * b.driftA * w;
            const y = b.baseY + Math.sin(TAU * time / b.bobT + b.bobPhase) * b.driftA * h * 0.7;
            const angle = b.angle0 + 0.28 * Math.sin(TAU * time / b.angleT + b.anglePhase);

            // Wings hinge at the body; the two sides are slightly out of
            // phase so the flap never reads as a mirrored metronome.
            const osc = TAU * time * b.flapHz + b.flapPhase;
            const flapR = 0.72 + 0.28 * Math.sin(osc);
            const flapL = 0.72 + 0.28 * Math.sin(osc + 0.35);
            // Body lifts as the wings sweep down.
            const y0 = y - b.size * 0.09 * ((flapL + flapR) * 0.5 - 0.72);

            const S = b.size;
            const [inR, inG, inB] = b.cIn;
            const [outR, outG, outB] = b.cOut;
            const br = b.brightness;

            const cos = Math.cos(-angle), sin = Math.sin(-angle);
            const reach = S * 1.45;
            const minX = Math.max(0, Math.floor(x - reach));
            const maxX = Math.min(w - 1, Math.ceil(x + reach));
            const minY = Math.max(0, Math.floor(y - reach));
            const maxY = Math.min(h - 1, Math.ceil(y + reach));

            for (let py = minY; py <= maxY; py++) {
                for (let px = minX; px <= maxX; px++) {
                    // Screen -> body-local units (undo rotation, then span normalization).
                    const dx = px + 0.5 - x;
                    const dy = py + 0.5 - y0;
                    let u = (dx * cos - dy * sin) / S;
                    const v = (dx * sin + dy * cos) / S;

                    let r = 0, g = 0, bl = 0;

                    // --- wings ---
                    for (let li = 0; li < 6; li++) {
                        const lobe = b.lobes[li];
                        const flap = lobe.cx >= 0 ? flapR : flapL;
                        const lu = u / flap - lobe.cx;
                        const lv = v - lobe.cy;
                        const c = Math.cos(-lobe.rot);
                        const sn = Math.sin(-lobe.rot);
                        const qu = lu * c - lv * sn;
                        const qv = lu * sn + lv * c;
                        let d = (qu / lobe.a) * (qu / lobe.a) + (qv / lobe.b) * (qv / lobe.b);
                        if (d > 2.6) continue;

                        // Scalloped silhouette: ripple the lobe radius so the
                        // wing edge is not a bare ellipse.
                        if (d < 1.6) {
                            const th = Math.atan2(qv, qu);
                            const edge = 1 + b.scallop * Math.sin(5 * th + b.scallopPhase + li);
                            d /= edge * edge;
                        }

                        const sd = Math.sqrt(d);
                        // Solid wing body with a tight soft edge.
                        const core = clamp01((1.02 - d) / 0.16);
                        if (core > 0) {
                            // Iridescent fill: near-body color blends to the
                            // deeper rim color across the wing.
                            const m = clamp01(sd * 1.15);
                            const cr = inR + (outR - inR) * m;
                            const cg = inG + (outG - inG) * m;
                            const cb = inB + (outB - inB) * m;
                            const inner = 0.80 + 0.30 * (1 - sd);
                            const k = core * inner * (lobe.kind ? 0.86 : (li < 2 ? 1 : 0.94));
                            r += cr * k;
                            g += cg * k;
                            bl += cb * k;
                        }
                        // Faint rim so the silhouette stays legible at low res.
                        const rim = Math.exp(-Math.pow((d - 1.02) * 5.0, 2)) * 0.22;
                        // Tight additive aura.
                        const glow = Math.exp(-d * 3.2) * 0.14;
                        r += outR * (rim + glow);
                        g += outG * (rim + glow);
                        bl += outB * (rim + glow);
                    }

                    // --- antennae (thin soft lines springing from the head) ---
                    const ad = Math.min(
                        segDistSq(u, v, 0, -0.56, 0.17, -1.02),
                        segDistSq(u, v, 0, -0.56, -0.17, -1.02)
                    );
                    if (ad < 0.0016) {
                        const ak = clamp01((0.0016 - ad) / 0.0012) * 0.5;
                        r += (outR * 0.5 + 44) * ak;
                        g += (outG * 0.5 + 44) * ak;
                        bl += (outB * 0.5 + 44) * ak;
                    }

                    // --- body (dark tapered silhouette over the wings) ---
                    const bw = 0.032 + 0.030 * clamp01(1 - Math.abs(v) / 0.62);
                    const bodyD = Math.abs(u) / bw;
                    const bodyV = Math.abs(v + 0.02) / 0.64;
                    if (bodyD < 1.35 && bodyV < 1.25) {
                        const cov = clamp01((1.15 - Math.max(bodyD, bodyV)) / 0.5);
                        const bodyTone = 34 * cov;
                        // Body darkens the wings it covers; slight warm tint.
                        r = r * (1 - cov * 0.82) + bodyTone * 1.15 * cov;
                        g = g * (1 - cov * 0.82) + bodyTone * 0.95 * cov;
                        bl = bl * (1 - cov * 0.82) + bodyTone * 0.85 * cov;
                        // Head dot.
                        const hd = Math.sqrt(u * u + (v + 0.60) * (v + 0.60)) / 0.05;
                        if (hd < 1.4) {
                            const hc = clamp01((1.1 - hd) / 0.5);
                            r = r * (1 - hc) + 46 * hc;
                            g = g * (1 - hc);
                            bl = bl * (1 - hc) + 52 * hc;
                        }
                    }

                    if (r + g + bl < 0.6) continue;
                    const idx = (py * w + px) * 3;
                    data[idx] += r * br * 255;
                    data[idx + 1] += g * br * 255;
                    data[idx + 2] += bl * br * 255;
                }
            }
        }

        return data;
    }

    AMOLED.createButterflyFrame = createButterflyFrame;
})(window);

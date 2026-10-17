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

    // Wing lobes in body-local units (span ≈ 1): cx/rot already mirrored
    // per side; cy is the same for both.
    const LOBES = [
        { cx: 0.46, cy: -0.32, a: 0.50, b: 0.44, rot: -0.50 },
        { cx: 0.40, cy: 0.32, a: 0.36, b: 0.33, rot: 0.36 },
        { cx: -0.46, cy: -0.32, a: 0.50, b: 0.44, rot: 0.50 },
        { cx: -0.40, cy: 0.32, a: 0.36, b: 0.33, rot: -0.36 }
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
        return {
            baseX: px,
            baseY: py,
            size,
            hue: (index / count + 0.08 * rand() + 0.04) % 1,
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
            brightness: 0.72 + 0.28 * rand()
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

            const x = b.baseX + Math.sin(TAU * time / b.driftT + b.phase) * b.driftA * w;
            const y = b.baseY + Math.sin(TAU * time / b.bobT + b.bobPhase) * b.driftA * h * 0.7;
            const angle = b.angle0 + 0.28 * Math.sin(TAU * time / b.angleT + b.anglePhase);
            const flap = 0.72 + 0.28 * Math.sin(TAU * time * b.flapHz + b.flapPhase);
            const S = b.size;

            // Wing color: vivid but deep enough for an AMOLED showcase.
            const [wr, wg, wb] = hslToRgb(b.hue, 0.82, 0.58);
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
                    const dy = py + 0.5 - y;
                    let u = (dx * cos - dy * sin) / S;
                    const v = (dx * sin + dy * cos) / S;

                    let r = 0, g = 0, bl = 0;

                    // --- wings ---
                    for (let li = 0; li < 4; li++) {
                        const lobe = LOBES[li];
                        // Flap: wings hinge at the body, scaling outward.
                        const lu = u / flap - lobe.cx;
                        const lv = v - lobe.cy;
                        const c = Math.cos(-lobe.rot);
                        const sn = Math.sin(-lobe.rot);
                        const qu = lu * c - lv * sn;
                        const qv = lu * sn + lv * c;
                        const d = (qu / lobe.a) * (qu / lobe.a) + (qv / lobe.b) * (qv / lobe.b);
                        if (d > 2.6) continue;

                        // Solid wing body with a tight soft edge.
                        const core = clamp01((1.02 - d) / 0.16);
                        if (core > 0) {
                            const inner = 1 - 0.34 * Math.min(1, Math.sqrt(d));
                            const k = core * inner * (li < 2 ? 1 : 0.90);
                            r += wr * k;
                            g += wg * k;
                            bl += wb * k;
                        }
                        // Faint rim so the silhouette stays legible at low res.
                        const rim = Math.exp(-Math.pow((d - 1.02) * 5.0, 2)) * 0.22;
                        // Tight additive aura.
                        const glow = Math.exp(-d * 3.2) * 0.14;
                        r += wr * (rim + glow);
                        g += wg * (rim + glow);
                        bl += wb * (rim + glow);
                    }

                    // --- body (dark tapered silhouette over the wings) ---
                    const bw = 0.032 + 0.030 * clamp01(1 - Math.abs(v) / 0.62);
                    const bodyD = Math.abs(u) / bw;
                    const bodyV = Math.abs(v + 0.02) / 0.60;
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

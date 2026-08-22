// Seeded deterministic randomness for procedural scenes (PLAN.md §Phase 5).
// No Math.random() anywhere near scenes — Rule 7 determinism.

/** mulberry32 PRNG factory: fast, tiny, decent distribution. */
export function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Deterministic 2D lattice hash -> [0,1). Integer coords only. */
export function hash2(seed, xi, yi) {
    let h = (seed ^ Math.imul(xi, 374761393) ^ Math.imul(yi, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = u => u * u * (3 - 2 * u);

/** Value noise with bilinear + smoothstep interpolation, seeded. */
export function valueNoise(seed, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = smooth(xf), sy = smooth(yf);

    const v00 = hash2(seed, xi, yi);
    const v10 = hash2(seed, xi + 1, yi);
    const v01 = hash2(seed, xi, yi + 1);
    const v11 = hash2(seed, xi + 1, yi + 1);

    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
}

/** Fractal Brownian motion over valueNoise (octaves at doubling freq). */
export function fbm(seed, x, y, octaves) {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += valueNoise(seed + o * 1013, x * freq, y * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
    }
    return norm > 0 ? sum / norm : 0;
}

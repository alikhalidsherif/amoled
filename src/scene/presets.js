// Motion preset library (PLAN-CREATIVE.md §Workstream C).
//
// Presets are ADVISORY SUGAR: they expand to plain expression code in the
// layer/scene fragment at edit time and then vanish from the file. The .amo
// never references presets, keeping the parser/GPU contract untouched.
//
// Pure JSON-in/JSON-out, DOM-free, deterministic — Node-testable.

/**
 * @param {object} fragment - scene or composite layer object (not mutated).
 * @param {string} name - preset name.
 * @param {object} [params] - preset parameters; unknown keys throw.
 * @returns {object} NEW fragment with generated expressions applied.
 *   Re-applying the same preset replaces its previous output (idempotent).
 */
export function applyPreset(fragment, name, params = {}) {
    const preset = PRESETS[name];
    if (!preset) {
        throw new Error(`applyPreset: unknown preset "${name}"`);
    }
    // Validate params against the preset's declared spec.
    const clean = {};
    for (const key of Object.keys(params)) {
        if (!(key in preset.params)) {
            throw new Error(`applyPreset(${name}): unknown param "${key}"`);
        }
        clean[key] = params[key];
    }
    for (const [key, def] of Object.entries(preset.params)) {
        clean[key] = params[key] !== undefined ? params[key] : def;
    }
    const out = { ...fragment };
    preset.apply(out, clean);
    return out;
}

export function listPresets() {
    return Object.entries(PRESETS).map(([name, p]) => ({
        name,
        description: p.description,
        targets: p.targets,
        params: Object.fromEntries(
            Object.entries(p.params).map(([k, v]) => [k, v])
        )
    }));
}

const f2 = n => Math.round(n * 10000) / 10000;

// ------------------------------------------------------------------
// Preset definitions
// ------------------------------------------------------------------

const PRESETS = {
    pulse: {
        description: "Opacity pulses sinusoidally.",
        targets: ["layer"],
        params: { base: 0.5, amp: 0.4, rate: 1.0, phase: 0 },
        apply(f, p) {
            f.opacity =
                `${f2(p.base)} + ${f2(p.amp)}*sin(t*${f2(p.rate)} + ${f2(p.phase)})`;
        }
    },

    breathe: {
        description: "Layer scale breathes around 1.",
        targets: ["layer"],
        params: { amp: 0.06, rate: 0.5 },
        apply(f, p) {
            f.scale = `1 + ${f2(p.amp)}*sin(t*${f2(p.rate)})`;
        }
    },

    driftX: {
        description: "Horizontal drift oscillation.",
        targets: ["layer"],
        params: { dist: 0.03, rate: 0.15 },
        apply(f, p) {
            const off = { ...(f.offset || { x: 0, y: 0 }) };
            off.x = `${f2(p.dist)}*sin(t*${f2(p.rate)})`;
            f.offset = off;
        }
    },

    driftY: {
        description: "Vertical drift oscillation.",
        targets: ["layer"],
        params: { dist: 0.03, rate: 0.12 },
        apply(f, p) {
            const off = { ...(f.offset || { x: 0, y: 0 }) };
            off.y = `${f2(p.dist)}*sin(t*${f2(p.rate)})`;
            f.offset = off;
        }
    },

    orbit: {
        description: "Circular motion of the whole layer.",
        targets: ["layer"],
        params: { radius: 0.04, rate: 0.3, phase: 0 },
        apply(f, p) {
            f.offset = {
                x: `${f2(p.radius)}*sin(t*${f2(p.rate)} + ${f2(p.phase)})`,
                y: `${f2(p.radius)}*cos(t*${f2(p.rate)} + ${f2(p.phase)})`
            };
        }
    },

    sway: {
        description: "Gentle rotational sway.",
        targets: ["layer"],
        params: { amp: 0.05, rate: 0.25 },
        apply(f, p) {
            f.rotation = `${f2(p.amp)}*sin(t*${f2(p.rate)})`;
        }
    },

    shimmer: {
        description: "Slow noise shimmer on an expression layer's channels.",
        targets: ["expression"],
        params: { amount: 0.06, rate: 0.4, seed: 3 },
        apply(f, p) {
            for (const c of ["r", "g", "b"]) {
                const base = typeof f[c] === "string" ? `(${f[c]})` : String(f2(f[c] ?? 0));
                f[c] = `clamp(${base} + ${f2(p.amount)}*(noise(x*3 + ${p.seed}, y*3 - t*${f2(p.rate)}) - 0.5)*2, 0, 1)`;
            }
        }
    },

    wave: {
        description: "Rippling wobble on a livingGradient.",
        targets: ["livingGradient"],
        params: { amp: 0.05, rate: 0.35 },
        apply(f, p) {
            f.wobble = `${f2(p.amp)}*sin(t*${f2(p.rate)})`;
        }
    },

    flicker: {
        description: "Candle-like brightness jitter on any layer.",
        targets: ["layer"],
        params: { strength: 0.12, rate: 6, seed: 7 },
        apply(f, p) {
            const base = typeof f.opacity === "string" ? `(${f.opacity})` : f2(f.opacity ?? 1);
            f.opacity =
                `clamp(${base} * (1 - ${f2(p.strength)}*abs(sin(t*${p.rate} + noise(${p.seed}, t*${f2(p.rate * 0.37)}, ${p.seed})))) , 0, 1)`;
        }
    },

    scan: {
        description: "Linear scan across X with wrap.",
        targets: ["pattern"],
        params: { dist: 0.9, rate: 0.2 },
        apply(f, p) {
            const off = { ...(f.offset || { x: 0, y: 0 }) };
            off.x = `-mod(t*${f2(p.rate)}, ${f2(p.dist)})`;
            f.offset = off;
        }
    },

    zoomPulse: {
        description: "Very slow cinematic zoom breathing for backgrounds.",
        targets: ["layer"],
        params: { amp: 0.04, period: 20 },
        apply(f, p) {
            f.scale = `1 + ${f2(p.amp)}*(1 + sin(6.28318*t/${f2(p.period)}))/2`;
        }
    },

    hueDrift: {
        description: "Approximate hue cycling on gradient stop channels via phase-shifted sines.",
        targets: ["gradient", "livingGradient"],
        params: { rate: 0.25, depth: 0.25, phase: 0 },
        apply(f, p) {
            const mk = shift =>
                `${f2(p.depth > 0 ? Math.min(1, p.depth) : 0)}*sin(t*${f2(p.rate)} + ${(Math.PI * 2 / 3 * shift + p.phase).toFixed(4)})`;
            const chan = (existing, shift) => {
                const b = existing === undefined || existing === null ? 0.5 : existing;
                const num = typeof b === "number" ? Math.min(1, Math.max(0, b)) : 0.5;
                return `${num.toFixed(4)} - ${mk(shift)}`;
            };
            // Apply to both stops of a plain gradient, or every stop color of
            // a livingGradient.
            if (f.type === "livingGradient") {
                f.stops = f.stops.map(s => ({
                    ...s,
                    color: {
                        r: chan(typeof s.color === "object" && !Array.isArray(s.color) ? s.color.r : hexChan(s.color, "r"), 0),
                        g: chan(typeof s.color === "object" && !Array.isArray(s.color) ? s.color.g : hexChan(s.color, "g"), 1),
                        b: chan(typeof s.color === "object" && !Array.isArray(s.color) ? s.color.b : hexChan(s.color, "b"), 2)
                    }
                }));
            } else {
                f.from = {
                    r: chan(typeof f.from === "object" && !Array.isArray(f.from) ? f.from.r : hexChan(f.from, "r"), 0),
                    g: chan(typeof f.from === "object" && !Array.isArray(f.from) ? f.from.g : hexChan(f.from, "g"), 1),
                    b: chan(typeof f.from === "object" && !Array.isArray(f.from) ? f.from.b : hexChan(f.from, "b"), 2)
                };
                f.to = {
                    r: chan(typeof f.to === "object" && !Array.isArray(f.to) ? f.to.r : hexChan(f.to, "r"), 0),
                    g: chan(typeof f.to === "object" && !Array.isArray(f.to) ? f.to.g : hexChan(f.to, "g"), 1),
                    b: chan(typeof f.to === "object" && !Array.isArray(f.to) ? f.to.b : hexChan(f.to, "b"), 2)
                };
            }
        }
    }
};

/** Extract one channel of a "#rgb"/"#rrggbb" string as a float 0-1. */
function hexChan(color, channel) {
    if (typeof color !== "string" || color[0] !== "#") return 0.5;
    let hex = color.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split("").map(c => c + c).join("");
    const idx = channel === "r" ? 0 : channel === "g" ? 2 : 4;
    return parseInt(hex.slice(idx, idx + 2), 16) / 255;
}

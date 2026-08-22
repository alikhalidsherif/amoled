// Timeline evaluation (PLAN.md §Phase 4): keyframe interpolation for
// animatable display properties, loop wrapping, easings.
// DOM-free; unit-testable in bare Node.

const PROPERTY_TO_CONFIG = {
    "display.gamma": "emitterGamma",
    "display.brightness.active": "activeLevel",
    "display.brightness.inactive": "inactiveLevel",
    "display.spill": "opticalSpill",
    "display.emitters.maxOutput.r": "redMaxOutput",
    "display.emitters.maxOutput.g": "greenMaxOutput",
    "display.emitters.maxOutput.b": "blueMaxOutput",
    "display.emitters.sigma.r": "redSigma",
    "display.emitters.sigma.g": "greenSigma",
    "display.emitters.sigma.b": "blueSigma",
    "display.bloom.intensity": "bloomIntensity",
    "display.bloom.threshold": "bloomThreshold",
    "display.bloom.power": "bloomPower",
    "display.bloom.radius": "bloomRadius"
};

export function easeValue(easing, u) {
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    switch (easing) {
        case "linear": return u;
        case "easeIn": return u * u;
        case "easeOut": return 1 - (1 - u) * (1 - u);
        default: return u * u * (3 - 2 * u); // smoothstep
    }
}

export function wrapTime(t, duration, loop) {
    if (loop && duration > 0) {
        const wrapped = t % duration;
        return wrapped < 0 ? wrapped + duration : wrapped;
    }
    return t < 0 ? 0 : Math.min(t, duration);
}

function interpolateTrack(keys, t, easing) {
    if (t <= keys[0][0]) return keys[0][1];
    const lastIdx = keys.length - 1;
    if (t >= keys[lastIdx][0]) return keys[lastIdx][1];

    let lo = 0, hi = lastIdx;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (keys[mid][0] <= t) lo = mid; else hi = mid;
    }
    const [t0, v0] = keys[lo];
    const span = keys[lo + 1][0] - t0;
    const u = span > 0 ? (t - t0) / span : 1;
    const eased = easeValue(easing, u);
    return v0 + (keys[lo + 1][1] - v0) * eased;
}

/**
 * @param {object|null} timelineDef - normalized definition.timeline.
 * @returns {object} timeline handle; sample(t) → engine config patch ({} when
 *   nothing keyframed).
 */
export function createTimeline(timelineDef) {
    if (!timelineDef || !timelineDef.keyframes || timelineDef.keyframes.length === 0) {
        return Object.freeze({
            isAnimated: false,
            duration: Infinity,
            sample: () => ({})
        });
    }

    const duration = timelineDef.duration;
    const loop = timelineDef.loop !== false;

    return Object.freeze({
        isAnimated: true,
        duration,
        /**
         * Sample all tracks at absolute scene time t and return an
         * updateConfig patch (uniform-only keys, safe every tick).
         */
        sample(absT) {
            const t = wrapTime(absT, duration, loop);
            const patch = {};
            for (const track of timelineDef.keyframes) {
                const cfgKey = PROPERTY_TO_CONFIG[track.property];
                if (!cfgKey) continue;
                patch[cfgKey] = interpolateTrack(track.keys, t, track.easing || "smoothstep");
            }
            return patch;
        }
    });
}

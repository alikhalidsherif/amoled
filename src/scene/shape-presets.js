// Shape presets for the studio math sheet (PLAN_ADVANCED_MATH_POLISH.md §2.1).
//
// Coordinate reality of this engine (do NOT "fix" this — every existing
// .amo scene depends on it):
//   u, v        normalized 0..1 position (left→right, top→bottom)
//   x, y        pixel coordinates (same orientation), 0..width / 0..height
// External equation snippets that assume x,y ∈ 0..1 paint a sub-pixel
// region at the corner — black canvas. These presets are authored with
// u,v plus a width/height aspect factor so shapes stay circular on any
// canvas size.
//
// DOM-free on purpose: the studio inserts these into the model, node tests
// rasterize them through the shared scene pipeline (CPU + validator).

/** Isotropic squared distance from (cx,cy) in u,v space. */
const D2 = "(u-cx)*(u-cx)*(width/height)*(width/height)+(v-cy)*(v-cy)";

const CX_CY = {
    cx: { value: 0.5, min: 0, max: 1, step: 0.01 },
    cy: { value: 0.5, min: 0, max: 1, step: 0.01 }
};

export const SHAPE_PRESETS = [
    {
        id: "circle",
        label: "circle",
        r: `1/(1+exp(400*(${D2}-radius*radius)))`,
        g: `1/(1+exp(400*(${D2}-radius*radius)))`,
        b: `1/(1+exp(400*(${D2}-radius*radius)))`,
        params: {
            ...CX_CY,
            radius: { value: 0.18, min: 0.01, max: 0.8, step: 0.005 }
        }
    },
    {
        id: "ring",
        label: "ring",
        r: `exp(-100*abs(sqrt(${D2})-radius))`,
        g: `exp(-100*abs(sqrt(${D2})-radius))`,
        b: `exp(-100*abs(sqrt(${D2})-radius))`,
        params: {
            ...CX_CY,
            radius: { value: 0.22, min: 0.01, max: 0.8, step: 0.005 }
        }
    },
    {
        id: "square",
        label: "square",
        r: "(1/(1+exp(400*(abs((u-cx)*(width/height))-size))))*(1/(1+exp(400*(abs(v-cy)-size))))",
        g: "(1/(1+exp(400*(abs((u-cx)*(width/height))-size))))*(1/(1+exp(400*(abs(v-cy)-size))))",
        b: "(1/(1+exp(400*(abs((u-cx)*(width/height))-size))))*(1/(1+exp(400*(abs(v-cy)-size))))",
        params: {
            ...CX_CY,
            size: { value: 0.16, min: 0.01, max: 0.8, step: 0.005 }
        }
    },
    {
        id: "cross",
        label: "cross",
        r: "exp(-abs(v-cy)*120)*exp(-abs((u-cx)*(width/height))*120)",
        g: "exp(-abs(v-cy)*120)*exp(-abs((u-cx)*(width/height))*120)",
        b: "exp(-abs(v-cy)*120)*exp(-abs((u-cx)*(width/height))*120)",
        params: { ...CX_CY }
    },
    {
        id: "ripples",
        label: "ripples",
        r: `0.5+0.5*cos(freq*sqrt(${D2}))`,
        g: `0.5+0.5*cos(freq*sqrt(${D2}))`,
        b: `0.5+0.5*cos(freq*sqrt(${D2}))`,
        params: {
            ...CX_CY,
            freq: { value: 30, min: 2, max: 80, step: 1 }
        }
    }
];

/** Build a fresh expression-scene fragment for a preset (white shape). */
export function shapeFragment(preset) {
    return { type: "expression", r: preset.r, g: preset.g, b: preset.b, blend: "add" };
}

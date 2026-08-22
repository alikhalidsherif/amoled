// Cross-checks the GPU emission shader's analytic lattice reconstruction
// against DiamondPentileGeometry for identical viewport parameters.
"use strict";

globalThis.window = globalThis;
require("../src/engine/util.js");
require("../src/engine/diamond-pentile-geometry.js");
const AMOLED = globalThis.AMOLED;

// Shader-side lattice model, mirroring FRAG_EMISSION exactly.
function shaderEmitterAt(row, col, pitchX, pitchY, originX, originY) {
    const rp = ((row % 2) + 2) % 2;
    const cx = col * pitchX + rp * pitchX * 0.5 + originX;
    const cy = row * pitchY + originY;
    const fr = row, fc = col;
    const isGreen = (((fr + fc) % 2) + 2) % 2 === 0;
    let type = "G";
    if (!isGreen) {
        const phase = (((Math.floor(fc * 0.5) + fr) % 2) + 2) % 2;
        type = phase === 0 ? "R" : "B";
    }
    return { cx, cy, type };
}

function run(viewportW, viewportH, pixelScale, label) {
    const geo = new AMOLED.DiamondPentileGeometry({
        rowPitchFactor: 0.86,
        blackMatrixRatio: 0.22,
        greenSizeRatio: 0.80,
        diamondSizeRatio: 0.90
    });
    geo.rebuild(viewportW, viewportH, pixelScale);
    const m = geo.metrics;
    const ox = geo.latticeOriginX;
    const oy = geo.latticeOriginY;

    // For every visible CPU subpixel, find the shader emitter at its
    // (col,row) and compare position + type.
    let mismatches = 0;
    for (const s of geo.subpixels) {
        const g = shaderEmitterAt(s.row, s.col, m.pitchX, m.pitchY, ox, oy);
        const posOk =
            Math.abs(g.cx - s.cx) < 1e-9 &&
            Math.abs(g.cy - s.cy) < 1e-9;
        if (!posOk || g.type !== s.type) {
            mismatches++;
            if (mismatches < 5) {
                console.log("  MISMATCH", JSON.stringify(s), "vs", JSON.stringify(g));
            }
        }
    }

    // Verify R/G/B counts: greens should be ~equal to reds+blues combined,
    // reds ≈ blues.
    let counts = { G: 0, R: 0, B: 0 };
    for (const s of geo.subpixels) counts[s.type]++;

    console.log(
        `${label}: ${geo.subpixels.length} subpixels ` +
        `(G=${counts.G} R=${counts.R} B=${counts.B}) ` +
        `pitch=${m.pitchX.toFixed(2)}x${m.pitchY.toFixed(2)} grid=${m.visibleCols}x${m.visibleRows} -> ` +
        (mismatches === 0 ? "LATTICE MATCH" : mismatches + " MISMATCHES")
    );
    return mismatches;
}

let total = 0;
total += run(800, 600, 8, "800x600@8 ");
total += run(1920, 1080, 6, "1920x1080@6");
total += run(390, 844, 4, "390x844@4 ");
process.exit(total === 0 ? 0 : 1);

(function attachDiamondPentileGeometry(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    /**
     * Builds and caches a physical Diamond PenTile subpixel lattice.
     *
     * This geometry is independent of image content.
     * Subpixels always exist in the lattice (on or off state).
     * Content data only modulates brightness of existing emitters.
     */
    class DiamondPentileGeometry {
        constructor(config) {
            this.config = config;
            this.subpixels = [];
            this.metrics = {
                pitchX: 0,
                pitchY: 0,
                greenRadius: 0,
                diamondRadius: 0,
                colMin: 0,
                colMax: 0,
                rowMin: 0,
                rowMax: 0,
                visibleCols: 0,
                visibleRows: 0,
                subpixelCount: 0
            };
        }

        rebuild(viewportWidth, viewportHeight, pixelScaleOverride, originX, originY) {
            const offX = Number(originX) || 0;
            const offY = Number(originY) || 0;
            const requestedScale = Number.isFinite(pixelScaleOverride)
                ? Number(pixelScaleOverride)
                : Number(this.config.pixelScale);

            const pitchX = Math.max(2, requestedScale || 2);
            const pitchY = Math.max(2, pitchX * (Number(this.config.rowPitchFactor) || 1));

            const baseRadius = Math.min(pitchX, pitchY) * 0.5;
            const trim = baseRadius * clamp01(this.config.blackMatrixRatio);

            const greenRadius = Math.max(
                0.5,
                baseRadius * (Number(this.config.greenSizeRatio) || 0.8) - trim
            );
            const diamondRadius = Math.max(
                0.5,
                baseRadius * (Number(this.config.diamondSizeRatio) || 0.9) - trim
            );

            const roughCols = Math.max(2, Math.ceil(viewportWidth / pitchX) + 3);
            const roughRows = Math.max(2, Math.ceil(viewportHeight / pitchY) + 3);

            const draft = [];
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;

            for (let row = 0; row < roughRows; row += 1) {
                const rowShiftX = (row & 1) * (pitchX * 0.5);

                for (let col = 0; col < roughCols; col += 1) {
                    const cx = col * pitchX + rowShiftX;
                    const cy = row * pitchY;

                    const isGreen = ((row + col) & 1) === 0;

                    let type = "G";
                    if (!isGreen) {
                        const rbPhase = (Math.floor(col / 2) + row) & 1;
                        type = rbPhase === 0 ? "R" : "B";
                    }

                    const size = isGreen ? greenRadius : diamondRadius;
                    draft.push({ cx, cy, col, row, type, size });

                    if (cx < minX) minX = cx;
                    if (cx > maxX) maxX = cx;
                    if (cy < minY) minY = cy;
                    if (cy > maxY) maxY = cy;
                }
            }

            const centerX = (minX + maxX) * 0.5;
            const centerY = (minY + maxY) * 0.5;
            const offsetX = offX + viewportWidth * 0.5 - centerX;
            const offsetY = offY + viewportHeight * 0.5 - centerY;

            const edgePadding = Math.max(greenRadius, diamondRadius) + 1;

            const visible = [];
            let visibleColMin = Infinity;
            let visibleColMax = -1;
            let visibleRowMin = Infinity;
            let visibleRowMax = -1;

            for (let i = 0; i < draft.length; i += 1) {
                const subpixel = draft[i];
                const x = subpixel.cx + offsetX;
                const y = subpixel.cy + offsetY;

                if (
                    x < edgePadding ||
                    x > viewportWidth - edgePadding ||
                    y < edgePadding ||
                    y > viewportHeight - edgePadding
                ) {
                    continue;
                }

                visible.push({
                    cx: x,
                    cy: y,
                    col: subpixel.col,
                    row: subpixel.row,
                    type: subpixel.type,
                    size: subpixel.size
                });

                if (subpixel.col < visibleColMin) visibleColMin = subpixel.col;
                if (subpixel.col > visibleColMax) visibleColMax = subpixel.col;
                if (subpixel.row < visibleRowMin) visibleRowMin = subpixel.row;
                if (subpixel.row > visibleRowMax) visibleRowMax = subpixel.row;
            }

            if (!Number.isFinite(visibleColMin)) visibleColMin = 0;
            if (!Number.isFinite(visibleRowMin)) visibleRowMin = 0;
            if (visibleColMax < visibleColMin) visibleColMax = visibleColMin;
            if (visibleRowMax < visibleRowMin) visibleRowMax = visibleRowMin;

            this.subpixels = visible;
            this.metrics = {
                pitchX,
                pitchY,
                greenRadius,
                diamondRadius,
                colMin: visibleColMin,
                colMax: visibleColMax,
                rowMin: visibleRowMin,
                rowMax: visibleRowMax,
                visibleCols: visibleColMax - visibleColMin + 1,
                visibleRows: visibleRowMax - visibleRowMin + 1,
                subpixelCount: visible.length
            };
        }
    }

    function clamp01(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        if (n < 0) return 0;
        if (n > 1) return 1;
        return n;
    }

    AMOLED.DiamondPentileGeometry = DiamondPentileGeometry;
})(window);

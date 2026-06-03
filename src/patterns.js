(function attachPatternGenerator(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    /**
     * Generates a crisp, high-contrast geometric frame for validation.
     *
     * Pattern contents:
     * - White diagonal band
     * - Saturated RGB bars
     * - Center ring + disc for radial edge coverage
     */
    function createTestPattern(width, height) {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        const data = new Uint8ClampedArray(w * h * 3);

        const cx = (w - 1) * 0.5;
        const cy = (h - 1) * 0.5;
        const ringOuter = Math.min(w, h) * 0.32;
        const ringInner = Math.min(w, h) * 0.24;

        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                const idx = (y * w + x) * 3;

                let r = 0;
                let g = 0;
                let b = 0;

                if (Math.abs(y - x * (h / w)) < 2) {
                    r = 255;
                    g = 255;
                    b = 255;
                }

                if (y > h * 0.20 && y < h * 0.80) {
                    const section = Math.floor((x / w) * 6);
                    if (section === 1) r = 255;
                    if (section === 2) g = 255;
                    if (section === 3) b = 255;
                    if (section === 4) {
                        r = 255;
                        g = 255;
                        b = 0;
                    }
                }

                const dx = x - cx;
                const dy = y - cy;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > ringInner && dist < ringOuter) {
                    r = 255;
                    b = 255;
                }
                if (dist < ringInner * 0.40) {
                    g = 255;
                }

                data[idx] = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
            }
        }

        return data;
    }

    AMOLED.createTestPattern = createTestPattern;
})(window);

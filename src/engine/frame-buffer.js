(function attachFrameBuffer(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    /**
     * Immutable frame-buffer wrapper over flat RGB channel data.
     *
     * Input format: [R, G, B, R, G, B, ...] where each channel is 0..255.
     */
    class FrameBuffer {
        constructor(width, height, dataArray) {
            if (!Number.isInteger(width) || width <= 0) {
                throw new Error("FrameBuffer width must be a positive integer.");
            }
            if (!Number.isInteger(height) || height <= 0) {
                throw new Error("FrameBuffer height must be a positive integer.");
            }

            const expectedLength = width * height * 3;
            if (!dataArray || dataArray.length !== expectedLength) {
                throw new Error(
                    "FrameBuffer data length mismatch. Expected " +
                    expectedLength +
                    " values for " + width + "x" + height + " RGB frame."
                );
            }

            this.width = width;
            this.height = height;

            this.data =
                dataArray instanceof Uint8ClampedArray
                    ? dataArray
                    : new Uint8ClampedArray(dataArray);
        }

        getPixelNearest(x, y) {
            const nx = clampInt(Math.round(x), 0, this.width - 1);
            const ny = clampInt(Math.round(y), 0, this.height - 1);
            const idx = (ny * this.width + nx) * 3;

            return {
                r: this.data[idx],
                g: this.data[idx + 1],
                b: this.data[idx + 2]
            };
        }
    }

    function clampInt(value, min, max) {
        if (value < min) return min;
        if (value > max) return max;
        return value | 0;
    }

    AMOLED.FrameBuffer = FrameBuffer;
})(window);

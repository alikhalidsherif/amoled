(function attachConfig(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    AMOLED.DEFAULT_ENGINE_CONFIG = Object.freeze({
        pixelScale: null,
        autoPixelScale: true,
        minPixelScale: 3.5,
        maxPixelScale: 11,
        targetLogicalWidth: 220,
        targetLogicalHeight: 132,

        rowPitchFactor: 0.86,
        blackMatrixRatio: 0.22,
        greenSizeRatio: 0.80,
        diamondSizeRatio: 0.90,

        inactiveLevel: 0.035,
        activeLevel: 1.0,
        bloomIntensity: 0.0,

        defaultFrameWidth: 220,
        defaultFrameHeight: 132,

        containerSelector: "#display-shell",
        canvasSelector: "#display",
        maxDevicePixelRatio: 2
    });
})(window);

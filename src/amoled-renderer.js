(function attachAmoledRenderer(global) {
    "use strict";

    var AMOLED = global.AMOLED || (global.AMOLED = {});

    var FrameBuffer = AMOLED.FrameBuffer;
    var DiamondPentileGeometry = AMOLED.DiamondPentileGeometry;

    if (!FrameBuffer || !DiamondPentileGeometry) {
        throw new Error(
            "AMOLED renderer dependencies are missing. " +
            "Load frame-buffer.js and diamond-pentile-geometry.js first."
        );
    }

    class AMOLEDRenderer {
        constructor(configOverrides) {
            this.config = Object.assign(
                {},
                AMOLED.DEFAULT_ENGINE_CONFIG,
                configOverrides || {}
            );

            this.container = resolveElement(
                this.config.container,
                this.config.containerSelector,
                document.body
            );

            this.canvas = resolveElement(
                this.config.canvas,
                this.config.canvasSelector,
                null
            );

            if (!this.canvas) {
                throw new Error("AMOLED renderer could not find a target canvas.");
            }

            this.ctx = this.canvas.getContext("2d", {
                alpha: false,
                desynchronized: true
            });

            if (!this.ctx) {
                throw new Error("Unable to acquire CanvasRenderingContext2D.");
            }

            this.frameBuffer = null;

            this.geometry = new DiamondPentileGeometry(this.config);

            this.viewportWidth = 1;
            this.viewportHeight = 1;
            this.devicePixelRatio = 1;
            this.currentPixelScale = 2;

            this._bloomCanvas = null;
            this._bloomCtx = null;

            this.renderQueued = false;

            this._boundResize = this.resize.bind(this);
            this._resizeObserver = null;

            this._bindResizeListeners();
            this.resize();
        }

        loadFrameBuffer(width, height, dataArray) {
            this.frameBuffer = new FrameBuffer(width, height, dataArray);
            this.requestRender();
            return this.frameBuffer;
        }

        updateConfig(partialConfig) {
            if (!partialConfig || typeof partialConfig !== "object") {
                return;
            }
            Object.assign(this.config, partialConfig);

            var needsResize = (
                "pixelScale" in partialConfig ||
                "autoPixelScale" in partialConfig ||
                "minPixelScale" in partialConfig ||
                "maxPixelScale" in partialConfig ||
                "blackMatrixRatio" in partialConfig ||
                "greenSizeRatio" in partialConfig ||
                "diamondSizeRatio" in partialConfig ||
                "rowPitchFactor" in partialConfig
            );

            if (needsResize) {
                this.resize();
            } else {
                this.requestRender();
            }
        }

        resize() {
            var rect = this.container.getBoundingClientRect();
            var cssWidth = Math.max(1, Math.floor(rect.width));
            var cssHeight = Math.max(1, Math.floor(rect.height));

            var dprLimit = Math.max(1, this.config.maxDevicePixelRatio || 1);
            var dpr = Math.min(global.devicePixelRatio || 1, dprLimit);

            var pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
            var pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));

            if (
                this.canvas.width !== pixelWidth ||
                this.canvas.height !== pixelHeight
            ) {
                this.canvas.width = pixelWidth;
                this.canvas.height = pixelHeight;
                this.canvas.style.width = cssWidth + "px";
                this.canvas.style.height = cssHeight + "px";
            }

            this.devicePixelRatio = dpr;
            this.viewportWidth = cssWidth;
            this.viewportHeight = cssHeight;

            this.currentPixelScale = this._resolvePixelScale(cssWidth, cssHeight);

            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.ctx.imageSmoothingEnabled = false;

            this.geometry.rebuild(cssWidth, cssHeight, this.currentPixelScale);

            var bw = Math.max(1, Math.floor(cssWidth / 4));
            var bh = Math.max(1, Math.floor(cssHeight / 4));
            if (!this._bloomCanvas) {
                this._bloomCanvas = global.document.createElement("canvas");
                this._bloomCtx = this._bloomCanvas.getContext("2d");
            }
            this._bloomCanvas.width = bw;
            this._bloomCanvas.height = bh;

            this.requestRender();
        }

        requestRender() {
            if (this.renderQueued) {
                return;
            }
            this.renderQueued = true;
            global.requestAnimationFrame(() => {
                this.renderQueued = false;
                this.render();
            });
        }

        render() {
            var ctx = this.ctx;

            ctx.fillStyle = "#000000";
            ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);

            var subpixels = this.geometry.subpixels;
            if (!subpixels || subpixels.length === 0) {
                return;
            }

            var fb = this.frameBuffer;
            var inactive = clamp01(this.config.inactiveLevel);
            var inactive8 = Math.round(inactive * 255);
            var activeMul = clamp01(this.config.activeLevel);
            var bloom = clamp01(this.config.bloomIntensity);

            var metrics = this.geometry.metrics;
            var colsDenom = Math.max(1, metrics.visibleCols - 1);
            var rowsDenom = Math.max(1, metrics.visibleRows - 1);

            var count = subpixels.length;
            var colors = new Uint8Array(count);
            var types = new Uint8Array(count);

            for (var i = 0; i < count; i += 1) {
                var s = subpixels[i];
                var channel = inactive8;

                if (fb) {
                    var normX = (s.col - metrics.colMin) / colsDenom;
                    var normY = (s.row - metrics.rowMin) / rowsDenom;
                    var sourcePixel = fb.getPixelNearest(
                        normX * (fb.width - 1),
                        normY * (fb.height - 1)
                    );

                    if (s.type === "R") {
                        channel = mixInactive(sourcePixel.r * activeMul, inactive8);
                        types[i] = 1;
                    } else if (s.type === "G") {
                        channel = mixInactive(sourcePixel.g * activeMul, inactive8);
                        types[i] = 0;
                    } else {
                        channel = mixInactive(sourcePixel.b * activeMul, inactive8);
                        types[i] = 2;
                    }
                } else {
                    types[i] = s.type === "R" ? 1 : s.type === "B" ? 2 : 0;
                }

                colors[i] = channel;
            }

            this._drawBatch(ctx, subpixels, colors, types, count);

            if (bloom > 0.001 && this._bloomCanvas) {
                this._drawBloom(ctx, subpixels, colors, types, count, bloom);
            }
        }

        _drawBatch(ctx, subpixels, colors, types, count) {
            var i, s, r, g, b;

            for (i = 0; i < count; i += 1) {
                if (types[i] !== 0) continue;
                s = subpixels[i];
                g = colors[i];
                ctx.fillStyle = "rgb(0," + g + ",0)";
                ctx.beginPath();
                ctx.arc(s.cx, s.cy, s.size, 0, Math.PI * 2);
                ctx.fill();
            }

            for (i = 0; i < count; i += 1) {
                if (types[i] !== 1) continue;
                s = subpixels[i];
                r = colors[i];
                ctx.fillStyle = "rgb(" + r + ",0,0)";
                ctx.beginPath();
                ctx.moveTo(s.cx, s.cy - s.size);
                ctx.lineTo(s.cx + s.size, s.cy);
                ctx.lineTo(s.cx, s.cy + s.size);
                ctx.lineTo(s.cx - s.size, s.cy);
                ctx.closePath();
                ctx.fill();
            }

            for (i = 0; i < count; i += 1) {
                if (types[i] !== 2) continue;
                s = subpixels[i];
                b = colors[i];
                ctx.fillStyle = "rgb(0,0," + b + ")";
                ctx.beginPath();
                ctx.moveTo(s.cx, s.cy - s.size);
                ctx.lineTo(s.cx + s.size, s.cy);
                ctx.lineTo(s.cx, s.cy + s.size);
                ctx.lineTo(s.cx - s.size, s.cy);
                ctx.closePath();
                ctx.fill();
            }
        }

        _drawBloom(ctx, subpixels, colors, types, count, intensity) {
            var bCtx = this._bloomCtx;
            var bw = this._bloomCanvas.width;
            var bh = this._bloomCanvas.height;
            var scaleX = bw / Math.max(1, this.viewportWidth);
            var scaleY = bh / Math.max(1, this.viewportHeight);

            bCtx.clearRect(0, 0, bw, bh);

            var i, s, ch, bx, by, bs, alpha;

            for (i = 0; i < count; i += 1) {
                ch = colors[i];
                if (ch < 15) continue;

                s = subpixels[i];
                bx = s.cx * scaleX;
                by = s.cy * scaleY;
                bs = s.size * scaleX * (1.2 + intensity * 1.8);
                alpha = (ch / 255) * 0.7 * intensity;

                if (types[i] === 0) {
                    bCtx.fillStyle = "rgba(0," + ch + ",0," + alpha.toFixed(3) + ")";
                    bCtx.beginPath();
                    bCtx.arc(bx, by, bs, 0, Math.PI * 2);
                    bCtx.fill();
                } else if (types[i] === 1) {
                    bCtx.fillStyle = "rgba(" + ch + ",0,0," + alpha.toFixed(3) + ")";
                    bCtx.beginPath();
                    bCtx.arc(bx, by, bs, 0, Math.PI * 2);
                    bCtx.fill();
                } else {
                    bCtx.fillStyle = "rgba(0,0," + ch + "," + alpha.toFixed(3) + ")";
                    bCtx.beginPath();
                    bCtx.arc(bx, by, bs, 0, Math.PI * 2);
                    bCtx.fill();
                }
            }

            var blurPx = Math.round(4 + intensity * 12);
            ctx.save();
            ctx.filter = "blur(" + blurPx + "px)";
            ctx.globalCompositeOperation = "lighter";
            ctx.drawImage(this._bloomCanvas, 0, 0, this.viewportWidth, this.viewportHeight);
            ctx.restore();
        }

        getStats() {
            var fb = this.frameBuffer;
            return {
                viewportWidth: this.viewportWidth,
                viewportHeight: this.viewportHeight,
                pixelScale: this.currentPixelScale,
                subpixelCount: this.geometry.metrics.subpixelCount,
                gridCols: this.geometry.metrics.visibleCols,
                gridRows: this.geometry.metrics.visibleRows,
                frameBufferWidth: fb ? fb.width : 0,
                frameBufferHeight: fb ? fb.height : 0
            };
        }

        destroy() {
            if (this._resizeObserver) {
                this._resizeObserver.disconnect();
                this._resizeObserver = null;
            }
            global.removeEventListener("resize", this._boundResize);
        }

        _bindResizeListeners() {
            global.addEventListener("resize", this._boundResize);

            if (typeof global.ResizeObserver === "function") {
                this._resizeObserver = new global.ResizeObserver(this._boundResize);
                this._resizeObserver.observe(this.container);
            }
        }

        _resolvePixelScale(viewportWidth, viewportHeight) {
            var autoEnabled = Boolean(this.config.autoPixelScale);

            if (!autoEnabled) {
                return clampScale(
                    this.config.pixelScale,
                    this.config.minPixelScale,
                    this.config.maxPixelScale
                );
            }

            var targetW = Math.max(1, Number(this.config.targetLogicalWidth) || 220);
            var targetH = Math.max(1, Number(this.config.targetLogicalHeight) || 132);
            var areaRatio =
                (viewportWidth * viewportHeight) /
                Math.max(1, targetW * targetH);
            var autoScale = Math.sqrt(areaRatio);

            return quantizeScale(
                clampScale(
                    autoScale,
                    this.config.minPixelScale,
                    this.config.maxPixelScale
                ),
                0.25
            );
        }
    }

    function mixInactive(activeChannel, inactiveFloor) {
        var v = clampByte(activeChannel);
        return Math.round(inactiveFloor + (255 - inactiveFloor) * (v / 255));
    }

    function clampByte(value) {
        var n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return 0;
        if (n >= 255) return 255;
        return n | 0;
    }

    function clamp01(value) {
        var n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return 0;
        if (n >= 1) return 1;
        return n;
    }

    function resolveElement(explicitElement, selector, fallback) {
        if (explicitElement && explicitElement.nodeType === 1) {
            return explicitElement;
        }
        if (selector && typeof selector === "string") {
            var found = document.querySelector(selector);
            if (found) return found;
        }
        return fallback;
    }

    function clampScale(value, min, max) {
        var fallback = 6;
        var n = Number(value);
        var lo = Number.isFinite(min) ? Number(min) : 2;
        var hi = Number.isFinite(max) ? Number(max) : 20;

        if (!Number.isFinite(n)) {
            return Math.max(lo, Math.min(hi, fallback));
        }

        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
    }

    function quantizeScale(value, step) {
        var s = Math.max(0.1, Number(step) || 0.25);
        return Math.round(value / s) * s;
    }

    AMOLED.AMOLEDRenderer = AMOLEDRenderer;
})(window);

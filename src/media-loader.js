(function attachMediaLoader(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    /**
     * Client-side media loader.
     * Uses <img> for images, <video> for video, gifuct-js for GIFs.
     *
     * GIF frames are decoded manually using gifuct-js (LZW decompress),
     * giving us frame-exact control across all browsers.
     * Uses setInterval (not rAF) so it doesn't compete with the renderer.
     */
    class ClientMediaLoader {
        constructor() {
            this._canvas = document.createElement("canvas");
            this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });

            this._element = null;
            this._type = null;
            this._blobUrl = null;
            this._playing = false;
            this._timerId = null;
            this._frameCallback = null;
            this._targetWidth = 0;
            this._targetHeight = 0;
            this._fps = 12;

            this.width = 0;
            this.height = 0;

            // GIF-specific state
            this._gifFrames = null;
            this._gifFrameIndex = 0;
            this._gifFrameDelay = 0;
            this._gifLastTime = 0;
            this._gifDisposal = null;
            this._gifImageData = null;

            // Hidden host for <video> elements
            this._host = document.createElement("div");
            this._host.style.cssText =
                "position:absolute;left:-99999px;top:0;visibility:hidden;";
        }

        setFps(fps) {
            this._fps = Math.max(1, Math.min(60, fps | 0));
            if (this._playing) {
                const cb = this._frameCallback;
                const tw = this._targetWidth;
                const th = this._targetHeight;
                this.stop();
                this.startLoop(cb, tw, th);
            }
        }

        getFps() {
            return this._fps;
        }

        async load(source) {
            this.stop();
            this._removeElement();
            this._releaseBlobUrl();
            this._gifFrames = null;

            // Invalidate any background GIF decoding from a previous load
            // immediately — its chunks must not touch our fresh state.
            this._gifLoadGen = (this._gifLoadGen || 0) + 1;

            if (!source) throw new Error("No source provided.");

            let url;
            let file = null;

            if (source instanceof File || source instanceof Blob) {
                file = source;
                url = URL.createObjectURL(source);
            } else if (typeof source === "string") {
                url = source;
            } else {
                throw new Error("Source must be a File, Blob, or URL string.");
            }

            this._blobUrl = url;
            const mediaType = this._detectType(file || url);

            if (mediaType === "video") {
                await this._loadVideo(url);
            } else if (mediaType === "gif") {
                await this._loadGif(file || url);
            } else {
                await this._loadImage(url);
            }
        }

        /**
         * Read current frame.
         * For GIFs: decodes from gifuct frame data.
         * For images/video: draws from <img>/<video> element.
         * Always outputs at targetWidth x targetHeight with AR-preserving black padding.
         */
        getFrame(targetWidth, targetHeight) {
            const w = Math.max(1, targetWidth | 0);
            const h = Math.max(1, targetHeight | 0);

            this._canvas.width = w;
            this._canvas.height = h;

            // Black background
            this._ctx.fillStyle = "#000";
            this._ctx.fillRect(0, 0, w, h);

            if (this._type === "gif" && this._gifFrames) {
                return this._getGifFrame(w, h);
            }

            if (!this._element) return null;

            return this._getElementFrame(w, h);
        }

        _getGifFrame(w, h) {
            const frame = this._gifFrames[this._gifFrameIndex];
            if (!frame || !frame.patch) return { width: w, height: h, data: new Uint8ClampedArray(w * h * 3) };

            const dims = frame.dims;
            const patch = frame.patch;

            // Draw frame patch onto the GIF canvas at its native position
            if (!this._gifCanvas) {
                this._gifCanvas = document.createElement("canvas");
                this._gifCtx = this._gifCanvas.getContext("2d");
            }

            // Handle disposal: clear or restore
            if (this._gifDisposal === 2 && this._gifImageData) {
                // Restore to background (clear the frame area)
                this._gifCtx.clearRect(dims.left, dims.top, dims.width, dims.height);
            } else if (this._gifDisposal === 3 && this._gifImageData) {
                // Restore to previous — put back saved image data
                this._gifCtx.putImageData(this._gifImageData, 0, 0);
            }

            // Save current state for disposal type 3
            if (frame.disposalType === 3) {
                this._gifImageData = this._gifCtx.getImageData(0, 0, this._gifCanvas.width, this._gifCanvas.height);
            }

            // Draw the frame patch
            const frameImageData = new ImageData(patch, dims.width, dims.height);
            this._gifCtx.putImageData(frameImageData, dims.left, dims.top);

            this._gifDisposal = frame.disposalType || 0;

            // Now draw the GIF canvas onto our output canvas with AR preservation
            const gifW = this._gifCanvas.width;
            const gifH = this._gifCanvas.height;
            const srcAR = gifW / Math.max(1, gifH);
            const dstAR = w / Math.max(1, h);

            let drawW, drawH, drawX, drawY;
            if (srcAR > dstAR) {
                drawW = w;
                drawH = Math.max(1, Math.round(w / srcAR));
                drawX = 0;
                drawY = Math.round((h - drawH) / 2);
            } else {
                drawH = h;
                drawW = Math.max(1, Math.round(h * srcAR));
                drawX = Math.round((w - drawW) / 2);
                drawY = 0;
            }

            this._ctx.imageSmoothingEnabled = true;
            this._ctx.imageSmoothingQuality = "medium";
            this._ctx.drawImage(this._gifCanvas, drawX, drawY, drawW, drawH);

            const imageData = this._ctx.getImageData(0, 0, w, h);
            const rgba = imageData.data;
            const rgb = new Uint8ClampedArray(w * h * 3);
            for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
                rgb[j] = rgba[i];
                rgb[j + 1] = rgba[i + 1];
                rgb[j + 2] = rgba[i + 2];
            }

            return { width: w, height: h, data: rgb };
        }

        _getElementFrame(w, h) {
            const srcW = this.width || this._element.videoWidth || this._element.naturalWidth || w;
            const srcH = this.height || this._element.videoHeight || this._element.naturalHeight || h;
            const srcAR = srcW / Math.max(1, srcH);
            const dstAR = w / Math.max(1, h);

            let drawW, drawH, drawX, drawY;
            if (srcAR > dstAR) {
                drawW = w;
                drawH = Math.max(1, Math.round(w / srcAR));
                drawX = 0;
                drawY = Math.round((h - drawH) / 2);
            } else {
                drawH = h;
                drawW = Math.max(1, Math.round(h * srcAR));
                drawX = Math.round((w - drawW) / 2);
                drawY = 0;
            }

            this._ctx.imageSmoothingEnabled = true;
            this._ctx.imageSmoothingQuality = "medium";
            this._ctx.drawImage(this._element, drawX, drawY, drawW, drawH);

            const imageData = this._ctx.getImageData(0, 0, w, h);
            const rgba = imageData.data;
            const rgb = new Uint8ClampedArray(w * h * 3);
            for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
                rgb[j] = rgba[i];
                rgb[j + 1] = rgba[i + 1];
                rgb[j + 2] = rgba[i + 2];
            }

            return { width: w, height: h, data: rgb };
        }

        startLoop(callback, targetWidth, targetHeight) {
            if (this._playing) this.stop();

            this._frameCallback = callback;
            this._targetWidth = targetWidth;
            this._targetHeight = targetHeight;
            this._playing = true;
            this._gifFrameIndex = 0;
            this._gifLastTime = Date.now();

            if (this._element instanceof HTMLVideoElement) {
                this._element.play().catch(() => {});
            }

            const intervalMs = Math.max(1, Math.round(1000 / this._fps));

            this._timerId = global.setInterval(() => {
                if (!this._playing) return;

                // GIF frame advancement uses its own timing
                if (this._type === "gif" && this._gifFrames) {
                    this._advanceGifFrame();
                }

                // Video check
                if (this._element instanceof HTMLVideoElement) {
                    if (this._element.paused || this._element.ended) return;
                }

                const frame = this.getFrame(this._targetWidth, this._targetHeight);
                if (frame && callback) callback(frame);
            }, intervalMs);

            // Fire first frame immediately
            if (this._type === "gif" && this._gifFrames) {
                this._advanceGifFrame();
            }
            const first = this.getFrame(this._targetWidth, this._targetHeight);
            if (first && callback) callback(first);
        }

        _advanceGifFrame() {
            if (!this._gifFrames || this._gifFrames.length === 0) return;

            const now = Date.now();
            const elapsed = now - this._gifLastTime;

            // Use the frame's own delay, or fall back to FPS
            const frameDelay = this._gifFrameDelay || (1000 / this._fps);

            if (elapsed >= frameDelay) {
                const frame = this._gifFrames[this._gifFrameIndex];
                if (frame && frame.delay) {
                    this._gifFrameDelay = Math.max(20, frame.delay);
                }
                this._gifFrameIndex = (this._gifFrameIndex + 1) % this._gifFrames.length;
                this._gifLastTime = Date.now();
            }
        }

        stop() {
            this._playing = false;
            if (this._timerId !== null) {
                global.clearInterval(this._timerId);
                this._timerId = null;
            }
            if (this._element instanceof HTMLVideoElement) {
                this._element.pause();
                this._element.currentTime = 0;
            }
            this._frameCallback = null;
        }

        resizeTarget(width, height) {
            this._targetWidth = width;
            this._targetHeight = height;
        }

        getNativeSize() {
            if (this._type === "gif" && this._gifFrames && this._gifFrames.length > 0) {
                // GIF native size from first frame dims
                const f = this._gifFrames[0].dims;
                return { width: f.width, height: f.height };
            }
            if (!this._element) return { width: 0, height: 0 };
            return { width: this.width, height: this.height };
        }

        isAnimated() {
            return this._type === "gif" || this._type === "video";
        }

        isPlaying() {
            return Boolean(this._playing);
        }

        destroy() {
            this._gifLoadGen = (this._gifLoadGen || 0) + 1; // abort background decode
            this.stop();
            this._removeElement();
            this._releaseBlobUrl();
            this._element = null;
            this._gifFrames = null;
        }

        // --- Private ---

        _ensureHost() {
            if (!this._host.parentNode) {
                document.body.appendChild(this._host);
            }
        }

        _removeElement() {
            if (this._element && this._element.parentNode) {
                this._element.parentNode.removeChild(this._element);
            }
        }

        _detectType(source) {
            if (source instanceof File) {
                const mime = source.type || "";
                if (mime.startsWith("video/")) return "video";
                if (mime === "image/gif") return "gif";
                return "image";
            }
            if (typeof source === "string") {
                const lower = source.toLowerCase();
                if (/\.(mp4|webm|mkv|mov|avi|m4v)(\?|$)/.test(lower)) return "video";
                if (/\.gif(\?|$)/.test(lower)) return "gif";
                return "image";
            }
            if (source instanceof Blob) {
                const mime = source.type || "";
                if (mime.startsWith("video/")) return "video";
                if (mime === "image/gif") return "gif";
                return "image";
            }
            return "image";
        }

        async _loadImage(url) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    this._removeElement();
                    this._element = img;
                    this._type = "image";
                    this.width = img.naturalWidth;
                    this.height = img.naturalHeight;
                    resolve();
                };
                img.onerror = () => reject(new Error("Failed to load image."));
                img.src = url;
            });
        }

        async _loadGif(source) {
            const Gifuct = global.gifuct;
            if (!Gifuct) {
                throw new Error("gifuct-js not loaded. GIF decoding unavailable.");
            }

            let buffer;
            if (source instanceof Blob || source instanceof File) {
                buffer = await source.arrayBuffer();
            } else {
                const resp = await fetch(source);
                buffer = await resp.arrayBuffer();
            }

            const parsed = Gifuct.parseGIF(buffer);
            const imageFrames = parsed.frames.filter(function (f) { return f.image; });

            if (!imageFrames.length) {
                throw new Error("GIF has no decodable frames.");
            }

            // Generation guard: a newer load()/destroy() supersedes any
            // background decoding kicked off here. load()/destroy() already
            // bumped the generation; ours must match to survive.
            const gen = this._gifLoadGen = this._gifLoadGen || 1;

            // Decode ONLY the first frame synchronously (~10ms) so playback
            // starts immediately. Full-frame LZW+palette work for large GIFs
            // can take seconds and would otherwise block boot and playback.
            const firstFrame = Gifuct.decompressFrame(imageFrames[0], parsed.gct, true);
            this._gifFrames = [firstFrame];
            this._gifFrameIndex = 0;
            this._gifDisposal = null;
            this._gifImageData = null;

            // Get native dimensions from first frame
            this.width = firstFrame.dims.width;
            this.height = firstFrame.dims.height;

            // Create the GIF canvas at native size
            this._gifCanvas = document.createElement("canvas");
            this._gifCanvas.width = this.width;
            this._gifCanvas.height = this.height;
            this._gifCtx = this._gifCanvas.getContext("2d");

            // Draw first frame
            if (firstFrame.patch) {
                const imgData = new ImageData(firstFrame.patch, firstFrame.dims.width, firstFrame.dims.height);
                this._gifCtx.putImageData(imgData, firstFrame.dims.left, firstFrame.dims.top);
            }

            this._type = "gif";
            this._removeElement();

            this._decodeRemainingGifFrames(Gifuct, parsed, imageFrames, gen);
        }

        /**
         * Streams the remaining GIF frames through small event-loop-friendly
         * chunks. Animation loops over whatever is decoded so far; frames
         * appear progressively until complete. Aborted silently when a newer
         * load replaces this one.
         */
        _decodeRemainingGifFrames(Gifuct, parsed, imageFrames, gen) {
            const CHUNK = 2;
            let next = 1;
            const step = () => {
                if (gen !== this._gifLoadGen) return;
                let n = CHUNK;
                while (n-- > 0 && next < imageFrames.length) {
                    const frame = Gifuct.decompressFrame(imageFrames[next++], parsed.gct, true);
                    if (frame) this._gifFrames.push(frame);
                }
                if (next < imageFrames.length) {
                    setTimeout(step, 0);
                }
            };
            setTimeout(step, 0);
        }

        async _loadVideo(url) {
            return new Promise((resolve, reject) => {
                const video = document.createElement("video");
                video.muted = true;
                video.loop = true;
                video.playsInline = true;
                video.preload = "auto";

                this._removeElement();
                this._ensureHost();
                this._host.appendChild(video);

                video.onloadedmetadata = () => {
                    this._element = video;
                    this._type = "video";
                    this.width = video.videoWidth;
                    this.height = video.videoHeight;
                    resolve();
                };

                video.onerror = () => reject(new Error("Failed to load video."));
                video.src = url;
            });
        }

        _releaseBlobUrl() {
            if (this._blobUrl && this._blobUrl.startsWith("blob:")) {
                URL.revokeObjectURL(this._blobUrl);
            }
            this._blobUrl = null;
        }
    }

    AMOLED.ClientMediaLoader = ClientMediaLoader;
})(window);

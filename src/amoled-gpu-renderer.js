(function attachGpuPentileSimulator(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    // ------------------------------------------------------------------
    // Shaders
    // ------------------------------------------------------------------

    const VERT_QUAD = `#version 300 es
    layout(location = 0) in vec2 aPos;
    out vec2 vUV;
    void main() {
        vUV = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

    // Pass 1 — physical emission (§9-§11, §14).
    //
    // Every fragment of the supersampled internal buffer is treated as a point
    // on the virtual panel. The PenTile lattice is reconstructed analytically,
    // each nearby emitter's drive is sampled from the logical frame (sRGB ->
    // linear), pushed through the emitter response, and its spatial profile
    // (hard core shape + gaussian spill halo) is accumulated in linear light.
    const FRAG_EMISSION = `#version 300 es
    precision highp float;
    precision highp sampler2D;

    in vec2 vUV;
    out vec4 fragColor;

    uniform sampler2D uSource;
    uniform vec2  uRes;         // internal buffer size (px)
    uniform vec2  uPitch;       // lattice pitch, device px (x, y)
    uniform vec2  uOrigin;      // lattice origin offset, device px
    uniform vec2  uColNorm;     // colMin, colDenom  -> logical u
    uniform vec2  uRowNorm;     // rowMin, rowDenom  -> logical v
    uniform vec2  uRadii;       // green radius, diamond radius (device px)
    uniform vec3  uMaxOutput;   // R,G,B maximum output
    uniform vec3  uSigma;       // R,G,B optical spread (pitch units)
    uniform float uGamma;       // emitter response exponent
    uniform float uSpill;       // fraction of energy in gaussian halo
    uniform vec2  uDrive;       // activeLevel, inactiveLevel(linear)

    vec3 srgbToLinear(vec3 c) {
        bvec3 lo = lessThanEqual(c, vec3(0.04045));
        vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
        return mix(hi, c / 12.92, vec3(lo));
    }

    void main() {
        // Screen-space panel coordinate, y down (matches CPU lattice space).
        vec2 p = vec2(vUV.x, 1.0 - vUV.y) * uRes - uOrigin;

        float maxSigma = max(uSigma.r, max(uSigma.g, uSigma.b));
        float marginX = 3.0 * maxSigma * uPitch.x + uRadii.y + 2.0;
        float marginY = 3.0 * maxSigma * uPitch.y + max(uRadii.x, uRadii.y) + 2.0;

        int r0 = int(floor((p.y - marginY) / uPitch.y)) - 1;
        int r1 = int(floor((p.y + marginY) / uPitch.y)) + 1;
        int c0 = int(floor((p.x - marginX) / uPitch.x)) - 1;
        int c1 = int(floor((p.x + marginX) / uPitch.x)) + 1;

        vec3 acc = vec3(0.0);
        float aa = 0.75; // px, core edge softness at internal resolution

        for (int r = r0; r <= r1; r++) {
            float fr = float(r);
            float rp = mod(fr, 2.0);
            for (int c = c0; c <= c1; c++) {
                float fc = float(c);

                bool isGreen = mod(fr + fc, 2.0) < 0.5;

                // R/B emitters alternate between neighbouring green cells.
                float phase = mod(floor(fc * 0.5) + fr, 2.0);

                float rad;
                float sig;
                float maxOut;
                if (isGreen) {
                    rad = uRadii.x; sig = uSigma.g; maxOut = uMaxOutput.g;
                } else if (phase < 0.5) {
                    rad = uRadii.y; sig = uSigma.r; maxOut = uMaxOutput.r;
                } else {
                    rad = uRadii.y; sig = uSigma.b; maxOut = uMaxOutput.b;
                }

                vec2 center = vec2(
                    fc * uPitch.x + rp * uPitch.x * 0.5,
                    fr * uPitch.y
                );
                vec2 dp = p - center;

                float reachX = 3.5 * sig * uPitch.x + rad + 1.5;
                float reachY = 3.5 * sig * uPitch.y + rad + 1.5;
                if (abs(dp.x) > reachX || abs(dp.y) > reachY) continue;

                // Logical pixel this emitter belongs to.
                vec2 uv = vec2(
                    (fc - uColNorm.x) / uColNorm.y,
                    (fr - uRowNorm.x) / uRowNorm.y
                );
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;

                vec3 lin = srgbToLinear(texture(uSource, uv).rgb);

                float chan = isGreen ? lin.g : (phase < 0.5 ? lin.r : lin.b);
                chan = chan < 0.0 ? 0.0 : (chan > 1.0 ? 1.0 : chan);

                // Emitter response on linear drive (§8).
                float drive = clamp(uDrive.x * chan + uDrive.y, 0.0, 1.0);
                float A = maxOut * pow(drive, uGamma);

                // Core: circle for G, diamond for R/B (AA via smoothstep).
                float sd = isGreen
                    ? length(dp) - rad
                    : abs(dp.x) + abs(dp.y) - rad;
                float core = smoothstep(aa, -aa, sd);

                // Anisotropic gaussian optical spill into neighbours (§10).
                float sx2 = 2.0 * sig * sig * uPitch.x * uPitch.x;
                float sy2 = 2.0 * sig * sig * uPitch.y * uPitch.y;
                float halo = exp(-dp.x * dp.x / sx2 - dp.y * dp.y / sy2);

                float e = A * ((1.0 - uSpill) * core + uSpill * halo);

                if (isGreen)          acc += vec3(0.0, 1.0, 0.0) * e;
                else if (phase < 0.5) acc += vec3(1.0, 0.0, 0.0) * e;
                else                  acc += vec3(0.0, 0.0, 1.0) * e;
            }
        }

        fragColor = vec4(acc, 1.0);
    }`;

    // Pass 2 — brightness-dependent bloom extraction (§12).
    const FRAG_BRIGHT = `#version 300 es
    precision highp float;
    in vec2 vUV;
    out vec4 fragColor;

    uniform sampler2D uScene;
    uniform float uThreshold;
    uniform float uPower;
    uniform float uStrength;

    void main() {
        vec3 c = texture(uScene, vUV).rgb;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float w = pow(max(lum - uThreshold, 0.0), uPower);
        fragColor = vec4(c * w * uStrength, 1.0);
    }`;

    // Passes 3/4 — separable gaussian blur of the bloom buffer.
    const FRAG_BLUR = `#version 300 es
    precision highp float;
    in vec2 vUV;
    out vec4 fragColor;

    uniform sampler2D uTex;
    uniform vec2 uDir;        // texel step * direction
    uniform float uWeights[13];

    void main() {
        vec3 acc = texture(uTex, vUV).rgb * uWeights[0];
        for (int i = 1; i < 13; i++) {
            acc += texture(uTex, vUV + uDir * float(i)).rgb * uWeights[i];
            acc += texture(uTex, vUV - uDir * float(i)).rgb * uWeights[i];
        }
        fragColor = vec4(acc, 1.0);
    }`;

    // Pass 5 — composite + linear -> sRGB encode (§7).
    const FRAG_COMPOSITE = `#version 300 es
    precision highp float;
    in vec2 vUV;
    out vec4 fragColor;

    uniform sampler2D uScene;
    uniform sampler2D uBloom;

    vec3 linearToSrgb(vec3 c) {
        c = clamp(c, vec3(0.0), vec3(1.0));
        bvec3 lo = lessThanEqual(c, vec3(0.0031308));
        vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
        return mix(hi, c * 12.92, vec3(lo));
    }

    void main() {
        vec3 c = texture(uScene, vUV).rgb + texture(uBloom, vUV).rgb;
        fragColor = vec4(linearToSrgb(c), 1.0);
    }`;

    // ------------------------------------------------------------------
    // GL helpers
    // ------------------------------------------------------------------

    function compileShader(gl, type, src, label) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(sh);
            gl.deleteShader(sh);
            throw new Error("GPU sim " + label + " shader compile failed: " + log);
        }
        return sh;
    }

    function createProgram(gl, fragSrc, label) {
        const prog = gl.createProgram();
        const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_QUAD, label + ":vert");
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc, label);
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(prog);
            gl.deleteProgram(prog);
            throw new Error("GPU sim " + label + " link failed: " + log);
        }
        return prog;
    }

    function makeUniformProxy(gl, prog) {
        const cache = new Map();
        return function loc(name) {
            let l = cache.get(name);
            if (l === undefined) {
                l = gl.getUniformLocation(prog, name);
                cache.set(name, l);
            }
            return l;
        };
    }

    // ------------------------------------------------------------------
    // Simulator
    // ------------------------------------------------------------------

    class GPUPentileSimulator {
        static isSupported() {
            try {
                const c = global.document.createElement("canvas");
                return Boolean(c.getContext("webgl2"));
            } catch (err) {
                return false;
            }
        }

        constructor(configOverrides) {
            this.config = Object.assign(
                {},
                AMOLED.DEFAULT_ENGINE_CONFIG,
                configOverrides || {}
            );
            this.engine = "webgl2";

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
                throw new Error("GPU simulator could not find a target canvas.");
            }

            const gl = this.canvas.getContext("webgl2", {
                alpha: false,
                antialias: false,
                depth: false,
                stencil: false,
                desynchronized: true,
                preserveDrawingBuffer: false
            });
            if (!gl) {
                throw new Error("WebGL2 context unavailable.");
            }
            this.gl = gl;

            // HDR targets when renderable; RGBA8 fallback still works because
            // bloom threshold sits below 1.0.
            this.hdr = Boolean(gl.getExtension("EXT_color_buffer_float"));

            this.geometry = new AMOLED.DiamondPentileGeometry(this.config);

            this.frameBuffer = null;
            this._frameDirty = true;

            this.viewportWidth = 1;
            this.viewportHeight = 1;
            this.devicePixelRatio = 1;
            this.currentPixelScale = 2;
            this.internalWidth = 1;
            this.internalHeight = 1;
            this.supersampleUsed = 1;

            this._initGlResources();

            this.renderQueued = false;
            this._boundResize = this.resize.bind(this);
            this._resizeObserver = null;
            this._bindResizeListeners();
            this.resize();
        }

        _initGlResources() {
            const gl = this.gl;

            this.vao = gl.createVertexArray();
            gl.bindVertexArray(this.vao);
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 3, -1, -1, 3]),
                gl.STATIC_DRAW
            );
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.bindVertexArray(null);

            this.progEmission = createProgram(gl, FRAG_EMISSION, "emission");
            this.progBright = createProgram(gl, FRAG_BRIGHT, "bright");
            this.progBlur = createProgram(gl, FRAG_BLUR, "blur");
            this.progComposite = createProgram(gl, FRAG_COMPOSITE, "composite");

            this.uEmission = makeUniformProxy(gl, this.progEmission);
            this.uBright = makeUniformProxy(gl, this.progBright);
            this.uBlur = makeUniformProxy(gl, this.progBlur);
            this.uComposite = makeUniformProxy(gl, this.progComposite);

            this.blurWeights = new Float32Array(13);

            // Placeholder source texture until first loadFrameBuffer().
            // NEAREST: each emitter samples exactly its own logical pixel (§14).
            this.sourceTexture = this._createTexture(1, 1);
            gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255])
            );

            this.sceneTarget = null;
            this.bloomATarget = null;
            this.bloomBTarget = null;
        }

        _createTexture(w, h) {
            const gl = this.gl;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(
                gl.TEXTURE_2D, 0,
                this.hdr ? gl.RGBA16F : gl.RGBA8,
                Math.max(1, w), Math.max(1, h), 0,
                gl.RGBA,
                this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
                null
            );
            return tex;
        }

        _createTarget(w, h) {
            const gl = this.gl;
            const tex = this._createTexture(w, h);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0
            );
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return { tex, fbo, width: Math.max(1, w), height: Math.max(1, h) };
        }

        _destroyTarget(t) {
            if (!t) return;
            this.gl.deleteTexture(t.tex);
            this.gl.deleteFramebuffer(t.fbo);
        }

        loadFrameBuffer(width, height, dataArray) {
            const w = Math.max(1, width | 0);
            const h = Math.max(1, height | 0);

            // Expand packed RGB into RGBA for upload.
            const rgba = new Uint8Array(w * h * 4);
            for (let i = 0, j = 0, n = w * h; i < n; i++) {
                rgba[j++] = dataArray[i * 3];
                rgba[j++] = dataArray[i * 3 + 1];
                rgba[j++] = dataArray[i * 3 + 2];
                rgba[j++] = 255;
            }

            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, rgba
            );

            this.frameBuffer = { width: w, height: h };
            this.requestRender();
        }

        updateConfig(partialConfig) {
            if (!partialConfig || typeof partialConfig !== "object") {
                return;
            }
            Object.assign(this.config, partialConfig);

            const needsResize = (
                "pixelScale" in partialConfig ||
                "autoPixelScale" in partialConfig ||
                "minPixelScale" in partialConfig ||
                "maxPixelScale" in partialConfig ||
                "targetLogicalWidth" in partialConfig ||
                "targetLogicalHeight" in partialConfig ||
                "rowPitchFactor" in partialConfig ||
                "blackMatrixRatio" in partialConfig ||
                "greenSizeRatio" in partialConfig ||
                "diamondSizeRatio" in partialConfig ||
                "supersample" in partialConfig ||
                "maxInternalPixels" in partialConfig ||
                "maxDevicePixelRatio" in partialConfig
            );

            if (needsResize) {
                this.resize();
            } else {
                this.requestRender();
            }
        }

        resize() {
            const rect = this.container.getBoundingClientRect();
            const cssWidth = Math.max(1, Math.floor(rect.width));
            const cssHeight = Math.max(1, Math.floor(rect.height));

            const dprLimit = Math.max(1, this.config.maxDevicePixelRatio || 1);
            const dpr = Math.min(global.devicePixelRatio || 1, dprLimit);

            const deviceWidth = Math.max(1, Math.floor(cssWidth * dpr));
            const deviceHeight = Math.max(1, Math.floor(cssHeight * dpr));

            if (
                this.canvas.width !== deviceWidth ||
                this.canvas.height !== deviceHeight
            ) {
                this.canvas.width = deviceWidth;
                this.canvas.height = deviceHeight;
                this.canvas.style.width = cssWidth + "px";
                this.canvas.style.height = cssHeight + "px";
            }

            this.devicePixelRatio = dpr;
            this.viewportWidth = cssWidth;
            this.viewportHeight = cssHeight;

            this.currentPixelScale = resolvePixelScale(this.config, cssWidth, cssHeight);

            // Lattice metrics are computed in CSS px, converted to device px
            // for the GPU pipeline.
            this.geometry.rebuild(cssWidth, cssHeight, this.currentPixelScale);

            // Effective supersampling, capped by fragment budget (§13).
            const requested = clampInt(this.config.supersample, 1, 4, 2);
            // Tiny pitches need internal samples finer than screen pixels,
            // otherwise subpixels alias away entirely.
            const minForPitch = Math.ceil(
                2 / Math.max(0.25, this.currentPixelScale * dpr)
            );
            let ss = Math.max(requested, Math.min(4, minForPitch));
            const budget = Math.max(1, Number(this.config.maxInternalPixels) || 33554432);
            while (ss > 1 && deviceWidth * deviceHeight * ss * ss > budget) {
                ss -= 1;
            }
            this.supersampleUsed = ss;
            this.internalWidth = deviceWidth * ss;
            this.internalHeight = deviceHeight * ss;

            this._destroyTarget(this.sceneTarget);
            this._destroyTarget(this.bloomATarget);
            this._destroyTarget(this.bloomBTarget);
            this.sceneTarget = this._createTarget(this.internalWidth, this.internalHeight);
            this.bloomATarget = this._createTarget(deviceWidth >> 2, deviceHeight >> 2);
            this.bloomBTarget = this._createTarget(deviceWidth >> 2, deviceHeight >> 2);

            // Notify when the logical grid changed so consumers (e.g. the
            // media loop) can re-target instead of feeding stale sizes.
            const metrics = this.geometry.metrics;
            const gridKey = metrics.visibleCols + "x" + metrics.visibleRows;
            if (this._lastGridKey !== undefined && gridKey !== this._lastGridKey) {
                if (typeof this.onGridChange === "function") {
                    this.onGridChange(metrics.visibleCols, metrics.visibleRows);
                }
            }
            this._lastGridKey = gridKey;

            this.requestRender();
        }

        requestRender() {
            if (this.renderQueued) {
                return;
            }
            this.renderQueued = true;
            global.requestAnimationFrame(() => {
                this.renderQueued = false;
                try {
                    this.render();
                } catch (err) {
                    console.error("[amoled-gpu] render failed:", err);
                }
            });
        }

        _computeBlurWeights(radiusPx) {
            const sigma = Math.max(0.6, radiusPx * 0.5);
            const weights = this.blurWeights;
            let sum = 0;
            for (let i = 0; i < 13; i++) {
                const x = i - 6;
                const w = Math.exp(-(x * x) / (2 * sigma * sigma));
                weights[i] = w;
                sum += w;
            }
            for (let i = 0; i < 13; i++) {
                weights[i] /= sum;
            }
        }

        _drawPass(target, prog, setUniforms) {
            const gl = this.gl;
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
            if (target) {
                gl.viewport(0, 0, target.width, target.height);
            } else {
                gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            }
            gl.useProgram(prog);
            setUniforms();
            gl.bindVertexArray(this.vao);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindVertexArray(null);
        }

        render() {
            const gl = this.gl;
            const m = this.geometry.metrics;
            const cfg = this.config;

            // Lattice lives in CSS px; the emission pass renders at
            // devicePx * supersample, so every lattice-space uniform is
            // scaled by the full factor. Getting this wrong compresses the
            // whole virtual display by 1/ss into the top-left corner.
            const scale = this.devicePixelRatio * this.supersampleUsed;
            const pitch = [m.pitchX * scale, m.pitchY * scale];
            const radii = [m.greenRadius * scale, m.diamondRadius * scale];
            const origin = [
                (this.geometry.latticeOriginX || 0) * scale,
                (this.geometry.latticeOriginY || 0) * scale
            ];

            const inactiveLinear = srgbChannelToLinear(clamp01(cfg.inactiveLevel));

            // ---- Pass 1: emission at supersampled resolution -------------
            this._drawPass(this.sceneTarget, this.progEmission, () => {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
                gl.uniform1i(this.uEmission("uSource"), 0);
                gl.uniform2f(this.uEmission("uRes"), this.internalWidth, this.internalHeight);
                gl.uniform2f(this.uEmission("uPitch"), pitch[0], pitch[1]);
                gl.uniform2f(this.uEmission("uOrigin"), origin[0], origin[1]);
                gl.uniform2f(this.uEmission("uColNorm"), m.colMin, Math.max(1, m.visibleCols - 1));
                gl.uniform2f(this.uEmission("uRowNorm"), m.rowMin, Math.max(1, m.visibleRows - 1));
                gl.uniform2f(this.uEmission("uRadii"), radii[0], radii[1]);
                gl.uniform3f(this.uEmission("uMaxOutput"),
                    clamp01(cfg.redMaxOutput),
                    clamp01(cfg.greenMaxOutput),
                    clamp01(cfg.blueMaxOutput));
                gl.uniform3f(this.uEmission("uSigma"),
                    positive(cfg.redSigma, 0.45),
                    positive(cfg.greenSigma, 0.35),
                    positive(cfg.blueSigma, 0.55));
                gl.uniform1f(this.uEmission("uGamma"), positive(cfg.emitterGamma, 1.8));
                gl.uniform1f(this.uEmission("uSpill"), clamp01(cfg.opticalSpill));
                gl.uniform2f(this.uEmission("uDrive"),
                    clamp01(cfg.activeLevel), inactiveLinear);
            });

            // ---- Pass 2: bloom extraction at quarter res -----------------
            this._drawPass(this.bloomATarget, this.progBright, () => {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.tex);
                gl.uniform1i(this.uBright("uScene"), 0);
                gl.uniform1f(this.uBright("uThreshold"), positive(cfg.bloomThreshold, 0.7));
                gl.uniform1f(this.uBright("uPower"), positive(cfg.bloomPower, 2.0));
                gl.uniform1f(this.uBright("uStrength"), clamp01(cfg.bloomIntensity));
            });

            // ---- Passes 3/4: separable blur ------------------------------
            this._computeBlurWeights(positive(cfg.bloomRadius, 12) / 4);

            this._drawPass(this.bloomBTarget, this.progBlur, () => {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.bloomATarget.tex);
                gl.uniform1i(this.uBlur("uTex"), 0);
                gl.uniform2f(this.uBlur("uDir"), 1 / this.bloomATarget.width, 0);
                gl.uniform1fv(this.uBlur("uWeights[0]"), this.blurWeights);
            });

            this._drawPass(this.bloomATarget, this.progBlur, () => {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.bloomBTarget.tex);
                gl.uniform1i(this.uBlur("uTex"), 0);
                gl.uniform2f(this.uBlur("uDir"), 0, 1 / this.bloomBTarget.height);
                gl.uniform1fv(this.uBlur("uWeights[0]"), this.blurWeights);
            });

            // ---- Pass 5: composite + sRGB encode to screen ----------------
            this._drawPass(null, this.progComposite, () => {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.tex);
                gl.uniform1i(this.uComposite("uScene"), 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.bloomATarget.tex);
                gl.uniform1i(this.uComposite("uBloom"), 1);
            });

            gl.activeTexture(gl.TEXTURE0);
        }

        getStats() {
            const fb = this.frameBuffer;
            const m = this.geometry.metrics;
            return {
                engine: this.engine,
                hdr: this.hdr,
                supersample: this.supersampleUsed,
                internalResolution:
                    this.internalWidth + "x" + this.internalHeight,
                viewportWidth: this.viewportWidth,
                viewportHeight: this.viewportHeight,
                pixelScale: this.currentPixelScale,
                subpixelCount: m.subpixelCount,
                gridCols: m.visibleCols,
                gridRows: m.visibleRows,
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
            const ext = this.gl.getExtension("WEBGL_lose_context");
            if (ext) {
                ext.loseContext();
            }
        }

        _bindResizeListeners() {
            global.addEventListener("resize", this._boundResize);
            if (typeof global.ResizeObserver === "function") {
                this._resizeObserver = new global.ResizeObserver(this._boundResize);
                this._resizeObserver.observe(this.container);
            }
        }
    }

    // ------------------------------------------------------------------
    // Shared helpers
    // ------------------------------------------------------------------

    function srgbChannelToLinear(c) {
        if (c <= 0.04045) {
            return c / 12.92;
        }
        return Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function resolveElement(explicitElement, selector, fallback) {
        if (explicitElement && explicitElement.nodeType === 1) {
            return explicitElement;
        }
        if (selector && typeof selector === "string") {
            const found = document.querySelector(selector);
            if (found) return found;
        }
        return fallback;
    }

    function resolvePixelScale(config, viewportWidth, viewportHeight) {
        if (!config.autoPixelScale) {
            return clampRange(
                Number(config.pixelScale),
                Number(config.minPixelScale) || 3.5,
                Number(config.maxPixelScale) || 20,
                6
            );
        }
        const targetW = Math.max(1, Number(config.targetLogicalWidth) || 220);
        const targetH = Math.max(1, Number(config.targetLogicalHeight) || 132);
        const auto = Math.sqrt(
            (viewportWidth * viewportHeight) / Math.max(1, targetW * targetH)
        );
        return clampRange(auto,
            Number(config.minPixelScale) || 3.5,
            Number(config.maxPixelScale) || 20,
            6
        );
    }

    function clampRange(value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(Math.max(n, min), max);
    }

    function clampInt(value, min, max, fallback) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return fallback;
        return Math.min(Math.max(n, min), max);
    }

    function clamp01(v) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return 0;
        if (n >= 1) return 1;
        return n;
    }

    function positive(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    }

    AMOLED.GPUPentileSimulator = GPUPentileSimulator;
})(window);

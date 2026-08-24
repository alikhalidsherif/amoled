// GPU procedural rasterizer (PLAN.md §Phase 10).
//
// Renders expression scenes into an offscreen WebGL2 canvas at logical
// resolution using the GLSL expression backend; the resulting canvas is
// handed to the engine via loadSourceTexture(), skipping CPU per-pixel work.
//
// Determinism: GPU transcendentals differ from JS in ULPs — output may
// differ by ±1/255 after quantization. The CPU path remains available and
// is selected automatically if this rasterizer fails to initialize.

import { compileToGLSL, AmoExprError, GLSL_PRELUDE } from "../scene/expression.js";

export class GpuExpressionRasterizer {
    static isSupported() {
        try {
            const c = globalThis.document
                ? document.createElement("canvas")
                : new OffscreenCanvas(1, 1);
            return Boolean(c.getContext("webgl2"));
        } catch (e) {
            return false;
        }
    }

    constructor(width, height) {
        this.width = width | 0;
        this.height = height | 0;

        if (typeof OffscreenCanvas === "function") {
            this.canvas = new OffscreenCanvas(this.width, this.height);
        } else {
            this.canvas = document.createElement("canvas");
            this.canvas.width = this.width;
            this.canvas.height = this.height;
        }

        this.gl = this.canvas.getContext("webgl2", {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true // engine texImage2D may read late
        });
        if (!this.gl) throw new Error("GpuExpressionRasterizer: no webgl2");

        this._buildQuad();
    }

    _buildQuad() {
        const gl = this.gl;
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
    }

    /**
     * Compile r/g/b expressions of a scene into one fragment program.
     * @param {object} scene - normalized expression scene content.
     * @param {string[]} [paramNames] - scene parameter names (become uniforms).
     * @returns {boolean} success.
     */
    setScene(scene, paramNames) {
        const gl = this.gl;
        const names = paramNames || [];
        let prog = null;
        try {
            const uniforms = names.map(n => `uniform float uP_${n};`).join("\n");
            const extraVars = names.length ? new Set(names) : undefined;
            const vs = `#version 300 es
layout(location=0) in vec2 p;
void main(){ gl_Position = vec4(p,0.,1.); }`;
            const fs = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;
uniform float uT;
uniform float uFps;
uniform float uProgress;
uniform uint uSeed;
uniform float uWidth;
uniform float uHeight;
${uniforms}
${GLSL_PRELUDE}
void main(){
    float x = floor(gl_FragCoord.x);
    float y = floor(uHeight) - gl_FragCoord.y - 0.5; // top-down like CPU
    float width = uWidth;
    float height = uHeight;
    float u = x / max(1.0, width - 1.0);
    float v = y / max(1.0, height - 1.0);
    float r = ${compileToGLSL(scene.r, extraVars)};
    float g = ${compileToGLSL(scene.g, extraVars)};
    float b = ${compileToGLSL(scene.b, extraVars)};
    outColor = vec4(clamp(r,0.,1.), clamp(g,0.,1.), clamp(b,0.,1.), 1.0);
}`;
            prog = this._link(vs, fs);
        } catch (e) {
            console.warn("[gpu-raster] compile failed:", e.message);
            if (prog) gl.deleteProgram(prog);
            return false;
        }
        if (!prog) return false;
        if (this.program) gl.deleteProgram(this.program);
        this.program = prog;
        this.uT = gl.getUniformLocation(prog, "uT");
        this.uFps = gl.getUniformLocation(prog, "uFps");
        this.uProgress = gl.getUniformLocation(prog, "uProgress");
        this.uSeed = gl.getUniformLocation(prog, "uSeed");
        this.uWidth = gl.getUniformLocation(prog, "uWidth");
        this.uHeight = gl.getUniformLocation(prog, "uHeight");
        this.paramLocations = new Map();
        for (const n of names) {
            this.paramLocations.set(n, gl.getUniformLocation(prog, "uP_" + n));
        }

        gl.useProgram(prog);
        gl.uniform1f(this.uWidth, this.width);
        gl.uniform1f(this.uHeight, this.height);
        gl.uniform1ui(this.uSeed, (scene.seed | 0) >>> 0);
        return true;
    }

    _link(vsSrc, fsSrc) {
        const gl = this.gl;
        const mk = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(sh);
                gl.deleteShader(sh);
                throw new Error("GLSL compile: " + log);
            }
            return sh;
        };
        const vs = mk(gl.VERTEX_SHADER, vsSrc);
        const fs = mk(gl.FRAGMENT_SHADER, fsSrc);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(prog);
            gl.deleteProgram(prog);
            throw new Error("GLSL link: " + log);
        }
        return prog;
    }

    /** Render one frame at time t; returns the offscreen canvas for upload. */
    render(t, fps, progress, paramValues) {
        const gl = this.gl;
        if (!this.program) return null;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this.program);
        gl.uniform1f(this.uT, t);
        gl.uniform1f(this.uFps, fps || 30);
        gl.uniform1f(this.uProgress, progress || 0);
        if (this.paramLocations && paramValues) {
            for (const [name, loc] of this.paramLocations) {
                const v = paramValues[name];
                if (loc && typeof v === "number") gl.uniform1f(loc, v);
            }
        }
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        return this.canvas;
    }

    destroy() {
        if (this.program) this.gl.deleteProgram(this.program);
        if (this.vao) this.gl.deleteVertexArray(this.vao);
    }
}

// .amo STUDIO — visual-first scene builder (PLAN-CREATIVE.md §Workstream D,
// redesigned for mobile + desktop after real-world feedback).
//
// Model:
//   workingRaw            authoritative raw .amo object
//   selected              { kind: "scene" } | { kind: "layer", index }
//   Single (non-composite) scenes appear as one pseudo-layer; adding a second
//   layer auto-wraps the scene into a composite.
//
// Round-trip: form edits patch workingRaw then regenerate the source text;
// source edits replace workingRaw wholesale when they validate.

import { parseAmo } from "../src/scene/parser.js";
import { applyPreset, listPresets } from "../src/scene/presets.js";
import {
    compileExpression, AmoExprError,
    FUNCTION_NAMES, VARIABLE_NAMES, CONSTANT_NAMES, isReservedName
} from "../src/scene/expression.js";
import { rasterize } from "../src/scene/rasterizer.js";
import { SHAPE_PRESETS, shapeFragment } from "../src/scene/shape-presets.js";
import { ENGINE_PROMPT, parseAIReply } from "../src/scene/ai-prompt.js";
import AMOLEDPlayer from "../src/player/amoplayer.js";

const GPUPentileSimulator = window.AMOLED.GPUPentileSimulator;
const attachColorPopover = window.AMOLED.attachColorPopover;

const $ = id => document.getElementById(id);
const statusEl = $("statusbar");
const sourceEl = $("source");

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || "";
}

window.__gsim = null;
window.__gplayerRef = () => player;
window.__gworking = () => workingRaw;

// ------------------------------------------------------------------
// Renderer + player
// ------------------------------------------------------------------
const sim = new GPUPentileSimulator({
    containerSelector: "#shell",
    canvasSelector: "#preview-canvas"
});
window.__gsim = sim;
let player = null;
let playing = false;
let scrubbing = false;
let workingRaw = null;
let selected = { kind: "scene", index: -1 };
let lastErrorPath = "";
let suppressSourceSync = false;

function boot() {
    player = new AMOLEDPlayer({
        renderer: sim,
        events: {
            onerror: err => {
                lastErrorPath = err.path || "";
                setStatus("error: " + err.message, "err");
                highlightError();
            },
            onload: info => {
                lastErrorPath = "";
                const warns = info.warnings && info.warnings.length
                    ? "\nwarnings:\n - " + info.warnings.join("\n - ") : "";
                setStatus(`✓ "${info.name}" — ${info.isStatic ? "static (renders once)" : "animated"}${warns}`,
                    info.isStatic ? "ok" : "");
                highlightError();
                updateTransport();
            }
        }
    });
}

function highlightError() {
    const m = /layers\[(\d+)\]/.exec(lastErrorPath);
    const badIdx = m ? parseInt(m[1]) : -1;
    document.querySelectorAll(".layer-chip").forEach((chip, i) => {
        chip.classList.toggle("error",
            badIdx >= 0 && chip.dataset.layerIndex === String(badIdx));
    });
}

// ------------------------------------------------------------------
// Desmos-style expression editing (§6): highlight layer behind the
// textarea, autocomplete over functions/variables/constants/parameters,
// inline validation errors with the real parser.
// ------------------------------------------------------------------

const BASE_VAR_SET = new Set(VARIABLE_NAMES);
const CONST_SET = new Set(CONSTANT_NAMES);

function exprVocabulary(signal = false) {
    const params = Object.keys(workingRaw?.parameters || {});
    // Signal-space editors never offer pixel-space variables (y/v).
    const vars = signal
        ? VARIABLE_NAMES.filter(n => !/[uv]/.test(n)).concat(["p", "frequency", "sweepSpeed", "phaseOffset"])
        : [...VARIABLE_NAMES];
    return [
        ...vars.map(n => ({ name: n, meta: "variable", cls: "tok-var" })),
        ...CONSTANT_NAMES.map(n => ({ name: n, meta: "constant", cls: "tok-const" })),
        ...params.map(n => ({ name: n, meta: "parameter", cls: "tok-param" })),
        ...FUNCTION_NAMES.map(n => ({ name: n, meta: "function", cls: "tok-fn" }))
    ];
}

const HL_TOKEN_RE = /(\d+\.?\d*(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/%^<>?:(),])|(\s+)|(.)/g;

function highlightExpr(src, extraVars) {
    let out = "";
    let m;
    HL_TOKEN_RE.lastIndex = 0;
    while ((m = HL_TOKEN_RE.exec(src)) !== null) {
        if (m[1] !== undefined) out += `<span class="tok-num">${escapeHtml(m[1])}</span>`;
        else if (m[2] !== undefined) {
            const word = m[2];
            const isCall = src[HL_TOKEN_RE.lastIndex] === "(";
            let cls = "tok-bad";
            if (isCall && FUNCTION_NAMES.includes(word)) cls = "tok-fn";
            else if (BASE_VAR_SET.has(word) || extraVars?.has(word)) cls = "tok-var";
            else if (CONST_SET.has(word)) cls = "tok-const";
            else if ((workingRaw?.parameters || {})[word] !== undefined) cls = "tok-param";
            out += `<span class="${cls}">${escapeHtml(word)}</span>`;
        }
        else if (m[3] !== undefined) out += `<span class="tok-op">${escapeHtml(m[3])}</span>`;
        else out += escapeHtml(m[0]);
    }
    return out;
}

/**
 * Upgrade a textarea into an expression editor. Returns nothing; mutates
 * the DOM around it. Live-validates with the real compiler so error
 * messages match playback exactly.
 *
 * opts.signal — trace custom-expression mode: the vocabulary is signal-space
 * (p, frequency, sweepSpeed, phaseOffset; no y/v) and the range hint expects
 * a normalized signal, not 0..1 brightness.
 */
function attachExprEditor(textarea, opts = {}) {
    // Highlight layer under a transparent-text textarea.
    const wrap = document.createElement("div");
    wrap.className = "expr-wrap";
    textarea.parentNode.insertBefore(wrap, textarea);
    const hl = document.createElement("pre");
    hl.className = "expr-hl";
    hl.setAttribute("aria-hidden", "true");
    wrap.appendChild(hl);
    wrap.appendChild(textarea);
    const errEl = document.createElement("div");
    errEl.className = "expr-err";
    wrap.after(errEl);

    const signalMode = !!opts.signal;
    const signalVarSet = signalMode ? TRACE_SIGNAL_VARS : null;

    function refreshHighlight() {
        hl.innerHTML = highlightExpr(textarea.value, signalVarSet) + "\n";
        hl.scrollTop = textarea.scrollTop;
    }

    function validate() {
        errEl.textContent = "";
        errEl.classList.remove("soft");
        textarea.style.borderColor = "";
        const v = textarea.value.trim();
        if (!v) {
            errEl.textContent = "empty — the preview keeps the last valid scene until this has an expression";
            errEl.classList.add("soft");
            return;
        }
        let compiled;
        try {
            const extra = signalMode
                ? new Set([...Object.keys(workingRaw?.parameters || {}), ...TRACE_SIGNAL_VARS])
                : new Set(Object.keys(workingRaw?.parameters || {}));
            compiled = compileExpression(v, extra);
        } catch (e) {
            if (e instanceof AmoExprError || e.name === "AmoExprError") {
                errEl.textContent = e.message;
                textarea.style.borderColor = "var(--err)";
            }
            return;
        }
        if (signalMode) {
            // Signal values are ±1-ish, not 0..1 brightness — but a result
            // that never leaves a tiny band usually means a missing offset.
            let smax = 0;
            try {
                for (let ti = 0; ti < 5; ti++) {
                    const E = {
                        t: ti * 0.9, frame: ti * 27, width: 64, height: 64,
                        u: 0, v: 0, x: 0, y: 0, seed: 1, progress: ti / 4,
                        p: ti * 1.3, frequency: 2, sweepSpeed: 4, phaseOffset: 0
                    };
                    const out = compiled.eval(E.x, E.y, E);
                    if (Number.isFinite(out) && Math.abs(out) > smax) smax = Math.abs(out);
                }
            } catch { /* sampling is best-effort */ }
            if (smax > 0.001 && smax < 0.05) {
                errEl.classList.add("soft");
                errEl.innerHTML =
                    "heads-up: this signal is nearly flat — did you mean " +
                    `<a href="#" class="expr-fix">sin(p)</a> (the built-in sine shape)?`;
                const fix = errEl.querySelector(".expr-fix");
                if (fix) fix.addEventListener("click", ev => {
                    ev.preventDefault();
                    textarea.value = "sin(p)";
                    textarea.dispatchEvent(new Event("input", { bubbles: false }));
                });
            }
            return;
        }
        // Range check: expressions output 0..1. Sample the field; if it
        // clearly lives on a 0..100 scale, offer a one-click conversion.
        let max = 0;
        try {
            for (let ti = 0; ti < 5; ti++) {
                const E = {
                    t: ti * 0.9, frame: ti * 27, width: 64, height: 64,
                    u: 0, v: 0, x: 0, y: 0, seed: 1, progress: ti / 4
                };
                for (let pi = 0; pi < 5; pi++) {
                    E.x = pi * 16; E.y = (pi % 3) * 21;
                    E.u = E.x / 63; E.v = E.y / 63;
                    const out = compiled.eval(E.x, E.y, E);
                    if (Number.isFinite(out) && Math.abs(out) > max) max = Math.abs(out);
                }
            }
        } catch { /* sampling is best-effort */ }
        if (max > 5) {
            errEl.classList.add("soft");
            errEl.innerHTML =
                "heads-up: equations output <b>0..1</b>, not 0..100 — this saturates to full brightness. " +
                `<a href="#" class="expr-fix">convert to 0..1</a> (wraps in /100)`;
            const fix = errEl.querySelector(".expr-fix");
            fix.addEventListener("click", ev => {
                ev.preventDefault();
                textarea.value = `(${textarea.value}) / 100`;
                textarea.dispatchEvent(new Event("input", { bubbles: false }));
            });
        }
    }

    // --- autocomplete ---
    let acMenu = null;
    let acItems = [];
    let acActive = 0;

    function closeAc() {
        if (acMenu) { acMenu.remove(); acMenu = null; acItems = []; }
    }

    function currentWord() {
        const pos = textarea.selectionStart;
        const before = textarea.value.slice(0, pos);
        const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
        return m ? { word: m[0], start: pos - m[0].length } : null;
    }

    function openAc() {
        const cw = currentWord();
        if (!cw || cw.word.length < 1) { closeAc(); return; }
        const lower = cw.word.toLowerCase();
        acItems = exprVocabulary(signalMode)
            .filter(v => v.name.toLowerCase().startsWith(lower) && v.name !== cw.word)
            .slice(0, 12);
        if (acItems.length === 0) { closeAc(); return; }
        acActive = 0;
        if (!acMenu) {
            acMenu = document.createElement("div");
            acMenu.className = "ac-menu";
            wrap.appendChild(acMenu);
            for (const evName of ["mousedown"]) {
                acMenu.addEventListener(evName, e => e.preventDefault());
            }
            acMenu.addEventListener("click", e => {
                const item = e.target.closest(".ac-item");
                if (item) acceptAc(acItems[Number(item.dataset.idx)]);
            });
        }
        renderAc();
    }

    function renderAc() {
        if (!acMenu) return;
        acMenu.innerHTML = acItems
            .map((v, i) =>
                `<div class="ac-item${i === acActive ? " active" : ""}" data-idx="${i}">` +
                `${escapeHtml(v.name)}<span class="ac-meta">${v.meta}</span></div>`)
            .join("");
    }

    function acceptAc(item) {
        if (!item) { closeAc(); return; }
        const cw = currentWord();
        if (cw) {
            const pos = textarea.selectionStart;
            textarea.value =
                textarea.value.slice(0, cw.start) + item.name +
                textarea.value.slice(pos);
            const np = cw.start + item.name.length;
            textarea.setSelectionRange(np, np);
        }
        closeAc();
        textarea.dispatchEvent(new Event("input", { bubbles: false }));
        textarea.focus();
    }

    textarea.addEventListener("keydown", e => {
        if (!acMenu) return;
        if (e.key === "ArrowDown") { acActive = (acActive + 1) % acItems.length; renderAc(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { acActive = (acActive - 1 + acItems.length) % acItems.length; renderAc(); e.preventDefault(); }
        else if (e.key === "Enter" || e.key === "Tab") { acceptAc(acItems[acActive]); e.preventDefault(); }
        else if (e.key === "Escape") { closeAc(); e.preventDefault(); }
    });
    textarea.addEventListener("blur", () => setTimeout(closeAc, 120));

    textarea.addEventListener("input", () => { refreshHighlight(); validate(); openAc(); });
    textarea.addEventListener("scroll", () => { hl.scrollTop = textarea.scrollTop; });
    refreshHighlight();
    validate();
}

// ------------------------------------------------------------------
// Scene type schemas (visual editors)
// ------------------------------------------------------------------
const SCENE_TYPES = ["livingGradient", "flow", "particles", "pattern",
    "shape", "conicGradient", "waves", "scope",
    "curve", "expression", "gradient", "color", "image", "gif", "video"];

// kind: eval-num (text input + optional slider), color, select, expr, int
const TYPE_FIELDS = {
    livingGradient: [
        { key: "direction", label: "Direction", kind: "select", options: ["vertical", "horizontal", "diagonal", "radial"], def: "vertical" },
        { key: "wobble", label: "Wobble amount", kind: "eval-num", min: -0.3, max: 0.3, step: 0.01, def: "0.05*sin(t*0.4)", hint: "number or time expression" },
        { key: "__stops", label: "Color stops", kind: "stops", def: [{ at: 0, color: "#001208" }, { at: 1, color: "#2a5c34" }] }
    ],
    flow: [
        { key: "__palette", label: "Palette", kind: "palette", def: ["#020d06", "#0a2e18", "#175c2e", "#79c98a"] },
        { key: "scale", label: "Detail (scale)", kind: "eval-num", min: 0.5, max: 12, step: 0.1, def: 3.5 },
        { key: "speed", label: "Drift speed", kind: "eval-num", min: 0, max: 2, step: 0.01, def: 0.12 },
        { key: "warp", label: "Turbulence (warp)", kind: "eval-num", min: 0, max: 2, step: 0.05, def: 0.5 },
        { key: "octaves", label: "Octaves", kind: "select", options: ["1", "2", "3", "4", "5"], def: "3" },
        { key: "seed", label: "Seed", kind: "int", def: 7 }
    ],
    particles: [
        { key: "behavior", label: "Behavior", kind: "select", options: ["fireflies", "drift", "orbit", "rise", "fall", "snow"], def: "fireflies" },
        { key: "count", label: "Count", kind: "eval-num", min: 1, max: 400, step: 1, def: 80 },
        { key: "speed", label: "Speed", kind: "eval-num", min: 0, max: 2, step: 0.01, def: 0.2 },
        { key: "glow", label: "Glow", kind: "eval-num", min: 0, max: 1, step: 0.05, def: 0.7 },
        { key: "color", label: "Color", kind: "color", def: "#c8ffb0" },
        { key: "seed", label: "Seed", kind: "int", def: 42 }
    ],
    pattern: [
        { key: "pattern", label: "Variant", kind: "select", options: ["dots", "checks", "stripes", "scanlines", "halftone", "grid"], def: "dots" },
        { key: "size", label: "Size (px)", kind: "eval-num", min: 2, max: 64, step: 1, def: 10 },
        { key: "thickness", label: "Thickness", kind: "eval-num", min: 0, max: 1, step: 0.05, def: 0.6 },
        { key: "fg", label: "Foreground", kind: "color", def: "#39ff6a" },
        { key: "bg", label: "Background", kind: "color", def: "#041008" },
        { key: "softness", label: "Edge softness", kind: "eval-num", min: 0, max: 0.5, step: 0.01, def: 0.1 },
        { key: "angle", label: "Angle (rad)", kind: "eval-num", min: -3.14, max: 3.14, step: 0.05, def: 0 }
    ],
    shape: [
        { key: "kind", label: "Shape", kind: "select", options: ["circle", "ring", "rect", "line"], def: "circle" },
        { key: "cx", label: "Center X", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.5 },
        { key: "cy", label: "Center Y", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.5 },
        { key: "r", label: "Radius", kind: "eval-num", min: 0.005, max: 1, step: 0.005, def: 0.25, when: f => f.kind === "circle" || f.kind === undefined },
        { key: "innerR", label: "Inner radius", kind: "eval-num", min: 0, max: 1, step: 0.005, def: 0.15, when: f => f.kind === "ring" },
        { key: "outerR", label: "Outer radius", kind: "eval-num", min: 0.005, max: 1, step: 0.005, def: 0.25, when: f => f.kind === "ring" },
        { key: "w", label: "Width", kind: "eval-num", min: 0.01, max: 2, step: 0.01, def: 0.4, when: f => f.kind === "rect" },
        { key: "h", label: "Height", kind: "eval-num", min: 0.01, max: 2, step: 0.01, def: 0.4, when: f => f.kind === "rect" },
        { key: "x1", label: "Start X", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.25, when: f => f.kind === "line" },
        { key: "y1", label: "Start Y", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.7, when: f => f.kind === "line" },
        { key: "x2", label: "End X", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.75, when: f => f.kind === "line" },
        { key: "y2", label: "End Y", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.3, when: f => f.kind === "line" },
        { key: "thickness", label: "Thickness", kind: "eval-num", min: 0.001, max: 0.3, step: 0.002, def: 0.02, when: f => f.kind === "line" },
        { key: "softness", label: "Edge softness", kind: "eval-num", min: 0, max: 0.3, step: 0.002, def: 0.008 },
        { key: "color", label: "Color", kind: "color", def: "#ffffff" }
    ],
    conicGradient: [
        { key: "cx", label: "Center X", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.5 },
        { key: "cy", label: "Center Y", kind: "eval-num", min: -0.5, max: 1.5, step: 0.01, def: 0.5 },
        { key: "angle", label: "Start angle (rad)", kind: "eval-num", min: -6.28, max: 6.28, step: 0.05, def: 0 },
        { key: "__from", label: "From", kind: "color-or-json", def: "#000000" },
        { key: "__to", label: "To", kind: "color-or-json", def: "#ffffff" },
        { key: "softness", label: "Seam softness", kind: "eval-num", min: 0, max: 0.49, step: 0.01, def: 0.02 }
    ],
    waves: [
        { key: "wavelength", label: "Wavelength", kind: "eval-num", min: 0.01, max: 4, step: 0.01, def: 0.25 },
        { key: "amplitude", label: "Amplitude", kind: "eval-num", min: 0, max: 1, step: 0.02, def: 1 },
        { key: "speed", label: "Speed", kind: "eval-num", min: -4, max: 4, step: 0.05, def: 0.5 },
        { key: "angle", label: "Direction (rad)", kind: "eval-num", min: -3.14, max: 3.14, step: 0.05, def: 0 },
        { key: "phase", label: "Phase (rad)", kind: "eval-num", min: -6.28, max: 6.28, step: 0.05, def: 0 },
        { key: "color", label: "Wave color", kind: "color", def: "#39ff6a" },
        { key: "bg", label: "Background", kind: "color-or-json", def: "#000000" }
    ],
    curve: [
        { key: "x", label: "x(p)  — horizontal equation", kind: "expr", def: "sin(3*6.28318*p + t*0.4)" },
        { key: "y", label: "y(p)  — vertical equation", kind: "expr", def: "sin(4*6.28318*p)" },
        { key: "samples", label: "Smoothness (samples)", kind: "eval-num", min: 64, max: 3000, step: 50, def: 1000 },
        { key: "thickness", label: "Line thickness", kind: "eval-num", min: 0.002, max: 0.08, step: 0.002, def: 0.012 },
        { key: "glow", label: "Glow", kind: "eval-num", min: 0, max: 1, step: 0.05, def: 0.85 },
        { key: "decay", label: "Decay (harmonograph damping)", kind: "eval-num", min: 0, max: 1.5, step: 0.02, def: 0 },
        { key: "color", label: "Line color", kind: "color", def: "#00ffcc" },
        { key: "bg", label: "Background", kind: "color-or-json", def: "#010a08" }
    ],
    expression: [
        { key: "r", label: "Red channel", kind: "expr", def: "0.5 + 0.5*sin(x*8 + t*2)" },
        { key: "g", label: "Green channel", kind: "expr", def: "0.5 + 0.45*sin(y*6 - t*1.5)" },
        { key: "b", label: "Blue channel", kind: "expr", def: "0.35 + 0.35*noise(u*6 + t*0.4, v*6)" },
        { key: "seed", label: "Seed", kind: "int", def: 7 }
    ],
    gradient: [
        { key: "__from", label: "From", kind: "color-or-json", def: "#001a08" },
        { key: "__to", label: "To", kind: "color-or-json", def: "#123f20" },
        { key: "direction", label: "Direction", kind: "select", options: ["vertical", "horizontal", "diagonal", "radial"], def: "vertical" }
    ],
    color: [{ key: "color", label: "Color", kind: "color", def: "#06120a" }],
    image: [{ key: "__assetUrl", label: "Image URL", kind: "asset", def: "/assets/test-portrait.gif" },
            { key: "fit", label: "Fit", kind: "select", options: ["cover", "contain", "stretch"], def: "cover" }],
    gif: [{ key: "__assetUrl", label: "GIF URL", kind: "asset", def: "/assets/test-portrait.gif" },
          { key: "fit", label: "Fit", kind: "select", options: ["cover", "contain", "stretch"], def: "cover" }],
    video: [{ key: "__assetUrl", label: "Video URL (.webm/.mp4)", kind: "asset", def: "" }]
};

// Transform/blending fields available on every layer of a composite.
const TRANSFORM_FIELDS = [
    { key: "opacity", label: "Opacity", kind: "eval-num", min: 0, max: 1, step: 0.05, def: 1 },
    { key: "blend", label: "Blend", kind: "select", options: ["normal", "add", "screen", "multiply", "overlay"], def: "normal" },
    { key: "scale", label: "Scale", kind: "eval-num", min: 0.2, max: 4, step: 0.05, def: 1 },
    { key: "rotation", label: "Rotation (rad)", kind: "eval-num", min: -3.14, max: 3.14, step: 0.05, def: 0 }
];

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function num(id, fallback) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
}
function val(id) { return $(id).value; }

/** The fragment the layer editor currently targets. */
function targetFragment() {
    if (!workingRaw) return null;
    if (workingRaw.scene?.type === "composite") {
        return workingRaw.scene.layers[selected.index] ?? null;
    }
    return workingRaw.scene ?? null;
}

function isComposite() {
    return workingRaw?.scene?.type === "composite";
}

// ------------------------------------------------------------------
// Source pane <-> workingRaw
// ------------------------------------------------------------------
let reparseTimer = null;
// True when the Source textarea holds edits that have not parsed yet.
// A debounced field-editor commit must never overwrite them (and vice
// versa: whichever pane the user touched last wins).
let sourceDirty = false;

function syncSourceFromWorking() {
    suppressSourceSync = true;
    sourceEl.value = JSON.stringify(workingRaw, null, 2);
    suppressSourceSync = false;
    sourceEl.classList.remove("invalid");
    sourceDirty = false;
}

async function loadToPlayer() {
    if (!player || !workingRaw) return null;
    let parsed;
    try {
        parsed = parseAmo(JSON.parse(JSON.stringify(workingRaw)), location.href);
    } catch (e) {
        // Editing in progress: an invalid scene must feel like a pause, not
        // a failure. The preview keeps the last valid scene.
        lastErrorPath = e.path || "";
        highlightError();
        const field = describeErrorField(e.path);
        if (isIncompleteExpression(e)) {
            setStatus(`still typing — ${field || "expression"} is incomplete; preview holds the last valid scene`, "warn");
        } else {
            setStatus(`scene invalid — ${e.message}${field ? `\nfield: ${field}` : ""}\npreview holds the last valid scene`, "err");
        }
        return null;
    }
    try {
        await player.load(parsed.definition);
        if (playing) player.play();
        updateTransport();
        renderLayers();      // reflect adopted state
        renderTraceWorkspace();   // fresh trace rows adopt the primary UI
        lastErrorPath = "";
        highlightError();
        setInspectDefinition(parsed.definition);
        return parsed;
    } catch (e) {
        setStatus("load failed: " + e.message, "err");
        return null;
    }
}

/** Expression parse errors are "mid-keystroke" by default — the inline
 *  editor shows the precise reason under the field; the statusbar stays calm. */
function isIncompleteExpression(err) {
    return /invalid expression/.test(err.message || "");
}

/** Map an AmoError path like scene.layers[0].y to a human field label. */
function describeErrorField(path) {
    const m = /^scene\.layers\[(\d+)\]\.(\w+)$/.exec(path || "");
    if (!m) return "";
    const idx = Number(m[1]);
    const layer = workingRaw?.scene?.layers?.[idx];
    const f = (TYPE_FIELDS[layer?.type] || []).find(f => f.key === m[2]);
    return `${f ? f.label : m[2]} (layer ${idx + 1})`;
}

function onSourceEdit() {
    if (suppressSourceSync) return;
    sourceDirty = true;
    clearTimeout(reparseTimer);
    reparseTimer = setTimeout(async () => {
        let raw;
        try {
            raw = JSON.parse(sourceEl.value);
        } catch (e) {
            setStatus("invalid JSON: " + e.message, "err");
            sourceEl.classList.add("invalid");
            return;
        }
        try {
            const parsed = parseAmo(raw);
            workingRaw = raw;
            sourceDirty = false;
            clampSelection();
            hydrateAll();
            await loadToPlayer();
            setStatus(`valid ✓${parsed.warnings.length ? "\nwarnings:\n - " + parsed.warnings.join("\n - ") : ""}`,
                parsed.warnings.length ? "warn" : "ok");
        } catch (e) {
            lastErrorPath = e.path || "";
            highlightError();
            const field = describeErrorField(e.path);
            if (isIncompleteExpression(e)) {
                setStatus(`still typing — ${field || "expression"} is incomplete; preview holds the last valid scene`, "warn");
            } else {
                setStatus(`scene invalid — ${e.message}${field ? `\nfield: ${field}` : ""}\npreview holds the last valid scene`, "err");
            }
        }
    }, 300);
}

function clampSelection() {
    const n = layerCount();
    if (selected.kind === "layer" && selected.index >= n) {
        selected = n > 0 ? { kind: "layer", index: n - 1 } : { kind: "scene", index: -1 };
    }
}
function layerCount() {
    return isComposite() ? workingRaw.scene.layers.length : 1;
}

// ------------------------------------------------------------------
// Layer list UI
// ------------------------------------------------------------------
function describeLayer(frag) {
    const bits = [];
    switch (frag?.type) {
        case "flow":
            if (Array.isArray(frag.palette)) bits.push(frag.palette.slice(0, 3).join(" "));
            break;
        case "particles":
            bits.push(`${frag.count ?? "?"}× ${frag.behavior ?? "drift"}`);
            break;
        case "pattern":
            bits.push(frag.pattern ?? "dots");
            break;
        case "expression":
            bits.push("procedural math");
            break;
        case "shape":
            bits.push(frag.kind ?? "circle");
            break;
        case "conicGradient":
            bits.push("sweep");
            break;
        case "waves":
            bits.push("wave field");
            break;
        case "livingGradient": {
            const stops = frag.stops?.length ?? "?";
            bits.push(`${stops} stops`);
            break;
        }
        case "scope": {
            const n = (frag.rows || []).filter(r => r?.type === "trace").length;
            bits.push(`${n} trace${n === 1 ? "" : "s"}`);
            break;
        }
        case "gradient":
            bits.push("2-color");
            break;
        case "color":
            if (typeof frag.color === "string") bits.push(frag.color);
            break;
        case "image":
        case "gif":
        case "video":
            bits.push("media");
            break;
        default: break;
    }
    // On composites, surface the blend so "why is this hidden?" is visible.
    if (isComposite() && frag?.blend && frag.blend !== "normal") bits.push(frag.blend);
    return bits.join(" · ");
}

function renderLayers() {
    const host = $("layer-list");
    host.innerHTML = "";
    if (!workingRaw) return;

    // Dead-end prevention: single scenes have nothing to reorder/delete
    // yet — disable instead of silently no-op'ing (PLAN §5). Duplicate is
    // always available: on a single scene it wraps + copies.
    const single = !isComposite();
    $("btn-del-layer").disabled = single;
    $("btn-up").disabled = single;
    $("btn-down").disabled = single;

    // Scope scenes are edited in the Traces workspace, not as layer chips.
    if (isTraceScene()) { highlightError(); return; }

    // Display top-first (what-you-see order): the last array element is the
    // topmost layer, so the list reads top → bottom like every layer editor.
    const n = layerCount();
    const frags = isComposite()
        ? workingRaw.scene.layers.map((l, i) => ({ frag: l, i })).reverse()
        : [{ frag: workingRaw.scene, i: -1 }];

    frags.forEach(({ frag, i }) => {
        const chip = document.createElement("div");
        chip.className = "layer-chip";
        const selIdx = isComposite() ? i : -1;
        if ((selected.kind === "layer" && selIdx === selected.index) ||
            (selected.kind === "scene" && !isComposite())) {
            chip.classList.add("selected");
        }
        chip.dataset.layerIndex = String(selIdx);
        chip.innerHTML =
            `<span class="l-order">${isComposite() ? (n - i) : "•"}</span>` +
            `<span class="l-type">${escapeHtml(frag?.type ?? "?")}</span>` +
            `<span class="l-desc">${escapeHtml(describeLayer(frag))}</span>`;
        chip.addEventListener("click", () => selectLayer(isComposite() ? i : -1));
        host.appendChild(chip);
    });

    if (!isComposite()) {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "Single scene — add another layer to unlock blending.";
        host.appendChild(hint);
    }
    highlightError();
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function selectLayer(idx) {
    selected = idx < 0 ? { kind: "scene", index: -1 } : { kind: "layer", index: idx };
    renderLayers();
    renderLayerEditor();
    // Selection drives which scope layer the Traces workspace edits.
    renderTraceWorkspace();
    // Bring the editor into view so tapping a chip pays off immediately.
    requestAnimationFrame(() => {
        const ed = document.getElementById("layer-editor");
        if (ed && ed.children.length) {
            ed.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    });
}

function ensureComposite() {
    if (isComposite()) return;
    const base = JSON.parse(JSON.stringify(workingRaw.scene));
    workingRaw.scene = { type: "composite", layers: [base] };
    selected = { kind: "layer", index: 0 };
}

$("btn-add-layer").addEventListener("click", () => {
    ensureComposite();
    openTypePicker(t => {
        const frag = buildSceneForType(t);
        // New layers default to additive blending — on an AMOLED matrix,
        // light stacks additively; "normal" (opaque replace) hid everything
        // below and made layering feel broken (PLAN §5).
        if (frag.blend === undefined) frag.blend = "add";
        workingRaw.scene.layers.push(frag);
        selected = { kind: "layer", index: workingRaw.scene.layers.length - 1 };
        afterStructureChange();
        switchTab("layers");
    });
});

$("btn-dup-layer").addEventListener("click", () => {
    if (!isComposite()) {
        // Single scene: duplicating means "make a composite with two copies"
        // — the natural first step toward blending (PLAN §5).
        ensureComposite();
        workingRaw.scene.layers.splice(1, 0, JSON.parse(JSON.stringify(workingRaw.scene.layers[0])));
        selected = { kind: "layer", index: 1 };
        afterStructureChange();
        return;
    }
    const src = workingRaw.scene.layers[selected.index];
    if (!src) return;
    workingRaw.scene.layers.splice(selected.index + 1, 0, JSON.parse(JSON.stringify(src)));
    selected.index += 1;
    afterStructureChange();
});

$("btn-del-layer").addEventListener("click", () => {
    if (!isComposite()) return;
    if (workingRaw.scene.layers.length <= 1) {
        // unwrap back to single scene
        workingRaw.scene = JSON.parse(JSON.stringify(workingRaw.scene.layers[0]));
        selected = { kind: "scene", index: -1 };
        afterStructureChange();
        return;
    }
    workingRaw.scene.layers.splice(selected.index, 1);
    clampSelection();
    afterStructureChange();
});

// List is displayed top-first: ↑ raises the layer in the stack (index + 1).
$("btn-up").addEventListener("click", () => moveLayer(1));
$("btn-down").addEventListener("click", () => moveLayer(-1));
function moveLayer(dir) {
    if (!isComposite()) return;
    const i = selected.index, j = i + dir;
    if (i < 0 || j < 0 || j >= workingRaw.scene.layers.length) return;
    const L = workingRaw.scene.layers;
    [L[i], L[j]] = [L[j], L[i]];
    selected.index = j;
    afterStructureChange();
}

function afterStructureChange() {
    renderLayers();
    renderLayerEditor();
    renderTraceWorkspace(true);
    syncSourceFromWorking();
    loadToPlayer();
}

// ------------------------------------------------------------------
// Field editors
// ------------------------------------------------------------------
function buildSceneForType(type) {
    // Scope has no field schema (rows aren't editable via TYPE_FIELDS) —
    // seed it with the canonical three traces.
    if (type === "scope") return blankScopeScene();
    const scene = { type };
    const fields = TYPE_FIELDS[type] || [];
    for (const f of fields) {
        if (f.when && !f.when(scene)) continue;
        if (f.kind === "stops") scene.stops = JSON.parse(JSON.stringify(f.def));
        else if (f.kind === "palette") scene.palette = [...f.def];
        else if (f.kind === "int") scene[f.key] = f.def;
        else if (f.kind !== "color") scene[f.key] = f.def;
        else scene[f.key] = f.def;
    }
    normalizeSpecials(scene);
    return scene;
}

/** Convert __-prefixed raw inputs into structured properties. */
function normalizeSpecials(scene) {
    if (typeof scene.__from === "string") {
        try { scene.from = JSON.parse(scene.__from); } catch { scene.from = scene.__from; }
        delete scene.__from;
    }
    if (typeof scene.__to === "string") {
        try { scene.to = JSON.parse(scene.__to); } catch { scene.to = scene.__to; }
        delete scene.__to;
    }
    if (typeof scene.__assetUrl === "string") {
        scene.asset = "media";
        workingRaw.assets = { ...(workingRaw.assets || {}), media: scene.__assetUrl };
        delete scene.__assetUrl;
    }
}

function renderLayerEditor() {
    const host = $("layer-editor");
    host.innerHTML = "";
    const frag = targetFragment();
    if (!frag) return;

    const type = frag.type;
    const title = document.createElement("h2");
    // Number matches the top-first chip badge (1 = topmost).
    title.textContent = `Edit ${type}${isComposite() ? ` · layer ${layerCount() - selected.index}` : ""}`;
    host.appendChild(title);

    const wrap = document.createElement("div");

    if (type === "scope") {
        // No field schema — traces are edited in the Traces workspace.
        const n = (frag.rows || []).filter(r => r?.type === "trace").length;
        const note = document.createElement("div");
        note.className = "hint";
        note.style.marginBottom = "8px";
        note.textContent = `${n} trace${n === 1 ? "" : "s"} — height, speed, color and phase live in the Traces workspace.`;
        const btn = document.createElement("button");
        btn.textContent = "Edit traces";
        btn.addEventListener("click", () => switchTab("traces"));
        wrap.append(note, btn);
    } else {
        for (const f of TYPE_FIELDS[type] || []) {
            if (f.when && !f.when(frag)) continue;
            wrap.appendChild(renderField(f, frag));
        }
    }
    host.appendChild(wrap);

    // Cheat-sheet whenever math is involved (after the fields it explains).
    if (["expression", "curve", "shape", "waves", "conicGradient"].includes(type)) {
        host.appendChild(buildCheatSheet());
    }

    // Transform/blending panel for composite layers.
    if (isComposite()) {
        const th = document.createElement("h2");
        th.textContent = "Transform & blending";
        host.appendChild(th);
        const tw = document.createElement("div");
        for (const f of TRANSFORM_FIELDS) tw.appendChild(renderField(f, frag));
        const offRow = document.createElement("div");
        offRow.className = "row";
        offRow.appendChild(offsetField(frag, "x"));
        offRow.appendChild(offsetField(frag, "y"));
        tw.appendChild(offRow);
        host.appendChild(tw);
    }
}

function buildCheatSheet() {
    const d = document.createElement("details");
    d.style.cssText = "margin-top:12px;border:1px solid var(--line);border-radius:6px;padding:8px;";
    d.innerHTML =
        `<summary style="cursor:pointer;color:#9fd39f">Math cheat-sheet</summary>
        <div class="hint" style="margin-top:6px">
        <b>Variables:</b> p = position along the curve (0→1) · x y u v = pixel ·
        t = seconds · frame · width height · seed · progress<br>
        <b>Constants:</b> pi · tau (= 2pi) · e &nbsp;&nbsp;
        <b>Parameters:</b> any name from the Parameters panel works here<br><br>
        <b>Recipes</b> (multiply p by tau·f to make f full cycles):<br>
        • Lissajous: x=sin(3*tau*p+t), y=sin(4*tau*p)<br>
        • Rose (5 petals): x=cos(5*tau*p)*cos(tau*p), y=cos(5*tau*p)*sin(tau*p)<br>
        • Circle: x=cos(tau*p), y=sin(tau*p)<br>
        • Moving emitter (shape): cx = 0.5 + 0.3*cos(t), cy = 0.5 + 0.3*sin(t)<br>
        • Damping: wrap in exp(-decay*p), or use the Decay slider<br><br>
        <b>Functions:</b> sin cos tan abs sqrt pow exp log sign<br>
        min max floor ceil fract mod clamp mix smoothstep step distance length noise<br><br>
        For per-pixel fields (plasma, waves) add an <b>expression</b> layer instead —
        there x and y are pixel coordinates.
        </div>`;
    return d;
}

function offsetField(frag, axis) {
    const label = document.createElement("label");
    label.className = "field";
    label.innerHTML = `Offset ${axis.toUpperCase()} <span class="hint">number or expr</span>`;
    const input = document.createElement("input");
    input.type = "text"; input.step = "any";
    input.value = frag.offset?.[axis] ?? 0;
    input.addEventListener("input", () => {
        if (!frag.offset) frag.offset = {};
        frag.offset[axis] = maybeNumber(input.value);
        commitEdits();
    });
    label.appendChild(input);
    return label;
}

function maybeNumber(v) {
    if (typeof v !== "string") return v;
    const n = parseFloat(v);
    return (/^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(v.trim()) && Number.isFinite(n)) ? n : v;
}

function renderField(f, frag) {
    const label = document.createElement("label");
    label.className = "field";
    let input;

    switch (f.kind) {
        case "select": {
            input = document.createElement("select");
            for (const o of f.options) {
                const opt = document.createElement("option");
                opt.value = o; opt.textContent = o;
                input.appendChild(opt);
            }
            const cur = frag[f.key];
            if (cur !== undefined) input.value = String(cur);
            else if (typeof f.def === "number") input.value = String(f.def);
            input.addEventListener("change", () => {
                const n = Number(input.value);
                frag[f.key] = Number.isFinite(n) && /^\d+$/.test(String(input.value)) ? n : input.value;
                commitEdits();
            });
            break;
        }
        case "color": {
            input = document.createElement("button");
            input.type = "button";
            input.className = "trace-swatch";
            input.title = "Pick color";
            const exprDriven = typeof frag[f.key] === "string" && frag[f.key][0] !== "#";
            if (exprDriven) {
                input.disabled = true;
                input.style.background = toHex(frag[f.key]) || f.def;
                input.title = "Color comes from an expression — edit it in Source";
            } else {
                attachColorPopover(input, {
                    get: () => toHex(frag[f.key]) || f.def,
                    set: hex => { frag[f.key] = hex; commitEdits(); }
                });
            }
            break;
        }
        case "color-or-json": {
            input = document.createElement("input");
            input.type = "text";
            input.value = typeof frag[f.key] === "object"
                ? JSON.stringify(frag[f.key]) : (toHex(frag[f.key]) ?? frag[f.key] ?? f.def);
            input.addEventListener("input", () => {
                frag["__" + f.key.replace("__", "")] = undefined;
                delete frag[f.key];
                try { frag[f.key] = JSON.parse(input.value); }
                catch { frag[f.key] = input.value; }
                commitEdits();
            });
            break;
        }
        case "palette": {
            const cur = Array.isArray(frag[f.key]) ? frag[f.key] : f.def;
            input = document.createElement("input");
            input.type = "text";
            input.value = cur.map(toHexValue).join("  ");
            input.addEventListener("input", () => {
                frag[f.key] = input.value.split(/[\s,]+/).filter(s => s.startsWith("#"));
                commitEdits();
            });
            label.innerHTML = `${f.label} <span class="hint">hex colors separated by spaces</span>`;
            break;
        }
        case "stops": {
            const cur = Array.isArray(frag.stops) ? frag.stops : f.def;
            input = document.createElement("textarea");
            input.rows = 3;
            input.value = cur.map(s =>
                `{ "at": ${s.at}, "color": ${JSON.stringify(typeof s.color === "string" ? s.color : "#" + chanToHex(s.color))} }`
            ).join(",\n");
            input.addEventListener("input", () => {
                try {
                    frag.stops = JSON.parse(`[${input.value}]`);
                    input.style.borderColor = "";
                    commitEdits();
                } catch { input.style.borderColor = "var(--err)"; }
            });
            label.innerHTML = `${f.label} <span class="hint">one per line: {"at":0.5,"color":"#22552c"} · expressions allowed in color channels</span>`;
            break;
        }
        case "expr": {
            input = document.createElement("textarea");
            input.rows = 2;
            input.spellcheck = false;
            input.value = frag[f.key] ?? f.def;
            input.addEventListener("input", () => {
                frag[f.key] = input.value;
                commitEdits();
            });
            label.innerHTML = f.label
                ? `${f.label} <span class="expr-badge">expression</span>`
                : (f.noBadge ? "" : `<span class="expr-badge">expression</span>`);
            break;
        }
        case "asset": {
            input = document.createElement("input");
            input.type = "text";
            const assetName = frag.asset;
            input.value = assetName && workingRaw.assets ? (workingRaw.assets[assetName] || "") : f.def;
            input.addEventListener("input", () => {
                frag.asset = "media";
                workingRaw.assets = { ...(workingRaw.assets || {}), media: input.value };
                commitEdits();
            });
            break;
        }
        case "int": {
            input = document.createElement("input");
            input.type = "number"; input.step = "1";
            input.value = frag[f.key] ?? f.def;
            input.addEventListener("input", () => {
                const n = parseInt(input.value);
                if (Number.isFinite(n)) { frag[f.key] = n; commitEdits(); }
            });
            break;
        }
        case "eval-num":
        default: {
            input = document.createElement("input");
            input.type = "text"; input.step = "any";
            const cur = frag[f.key];
            input.value = cur !== undefined ? String(cur) : String(f.def);
            input.placeholder = "number or expression";
            input.addEventListener("input", () => {
                frag[f.key] = maybeNumber(input.value);
                syncSlider(frag, f, label);
                commitEdits();
            });
            label.innerHTML = `${f.label} <span class="hint">number or expr</span>`;
            // Slider companion for numeric values with a known range.
            if (f.min !== undefined) {
                const slider = document.createElement("input");
                slider.type = "range";
                slider.min = String(f.min); slider.max = String(f.max);
                slider.step = String(f.step ?? 0.01);
                slider.dataset.sliderFor = f.key;
                slider.addEventListener("input", () => {
                    frag[f.key] = parseFloat(slider.value);
                    input.value = slider.value;
                    commitEdits();
                });
                label.appendChild(slider);
                syncSlider(frag, f, label);
            }
            break;
        }
    }

    if (input && input.parentNode !== label) label.appendChild(input);
    if (f.kind === "expr" && input) attachExprEditor(input);
    return label;
}

function syncSlider(frag, f, label) {
    const slider = label.querySelector(`input[data-slider-for="${f.key}"]`);
    if (!slider) return;
    const v = frag[f.key];
    if (typeof v === "number") {
        slider.disabled = false;
        slider.value = String(Math.min(Math.max(v, f.min), f.max));
    } else {
        slider.disabled = true;   // expression-driven
    }
}

function toHex(color) {
    if (typeof color !== "string") return null;
    return color[0] === "#" ? color : null;
}
function toHexValue(color) {
    if (typeof color === "string") return color;
    if (color && typeof color === "object") {
        const h = v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
        return `#${h(color.r)}${h(color.g)}${h(color.b)}`;
    }
    return "#888888";
}
function chanToHex(color) {
    return typeof color === "string" ? color : toHexValue(color);
}

let commitTimer = null;
function commitEdits() {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
        if (!sourceDirty) syncSourceFromWorking();
        loadToPlayer();
    }, 350);
}

// ------------------------------------------------------------------
// Design tab -> workingRaw
// ------------------------------------------------------------------
function rebuildDesignIntoWorking() {
    if (!workingRaw) return;
    workingRaw.meta = {
        name: val("f-name"),
        author: val("f-author") || (workingRaw.meta?.author ?? "")
    };
    workingRaw.display = {
        ...keepKnown(workingRaw.display, ["emitters", "pentile"]),
        gamma: num("f-gamma", 1.7),
        spill: num("f-spill", 0.4),
        brightness: { active: num("f-active", 1), inactive: num("f-inactive", 0.035) },
        bloom: {
            ...(workingRaw.display?.bloom || {}),
            intensity: num("f-bloomI", 0.25),
            threshold: num("f-bloomT", 0.45),
            radius: num("f-bloomR", 14)
        }
    };
    const q = { fps: num("f-fps", 30) };
    const ss = val("f-ss");
    if (ss) q.supersample = Number(ss);
    const lw = parseInt(val("f-lw")), lh = parseInt(val("f-lh"));
    if (lw && lh) q.logicalResolution = { width: lw, height: lh };
    workingRaw.quality = q;

    const dur = num("f-duration", 8);
    const loop = val("f-loop") === "true";
    if (workingRaw.timeline || dur > 0) {
        workingRaw.timeline = { ...(workingRaw.timeline || {}), duration: dur, loop };
    }
}
function keepKnown(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
}

let designTimer = null;
function onDesignEdit() {
    clearTimeout(designTimer);
    designTimer = setTimeout(() => {
        rebuildDesignIntoWorking();
        syncSourceFromWorking();
        loadToPlayer();
    }, 350);
}

function hydrateDesign(raw) {
    const setV = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = v; };
    setV("f-name", raw.meta?.name);
    setV("f-author", raw.meta?.author);
    const d = raw.display || {};
    setV("f-gamma", d.gamma); setV("f-spill", d.spill);
    setV("f-active", d.brightness?.active); setV("f-inactive", d.brightness?.inactive);
    setV("f-bloomI", d.bloom?.intensity); setV("f-bloomT", d.bloom?.threshold); setV("f-bloomR", d.bloom?.radius);
    const q = raw.quality || {};
    setV("f-fps", q.fps ?? 30); setV("f-ss", q.supersample ?? "");
    setV("f-lw", q.logicalResolution?.width); setV("f-lh", q.logicalResolution?.height);
    const tl = raw.timeline || {};
    setV("f-duration", tl.duration ?? 8); setV("f-loop", String(tl.loop !== false));
}

function hydrateAll() {
    hydrateDesign(workingRaw);
    renderLayers();
    renderLayerEditor();
    renderParams();
    renderTraceWorkspace(true);   // scene identity may have changed wholesale
    const md = $("math-duration");
    if (md) md.value = String(workingRaw?.timeline?.duration ?? 8);
}

// ------------------------------------------------------------------
// Transport / scrubber
// ------------------------------------------------------------------
function updateTransport() {
    const dur = player ? player.getDuration() : 0;
    $("scrubber").max = String(Math.max(1, dur));
    updateTLabel();
}
function updateTLabel() {
    const t = player ? player.getTime() : 0;
    const dur = player ? player.getDuration() : 0;
    $("t-label").textContent = `${t.toFixed(1)}s`;
    if (!scrubbing) $("scrubber").value = String(Math.min(t, Math.max(1, dur)));
}
setInterval(updateTLabel, 250);

$("btn-play").addEventListener("click", () => {
    if (!player) return;
    playing = !playing;
    if (playing) player.play(); else player.pause();
    $("btn-play").innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
});
$("scrubber").addEventListener("pointerdown", () => { scrubbing = true; });
$("scrubber").addEventListener("input", e => {
    if (!player) return;
    player.scrub(parseFloat(e.target.value));
    updateTLabel();
});
$("scrubber").addEventListener("change", () => { scrubbing = false; });
document.addEventListener("keydown", e => {
    if (e.code === "Space" && !/TEXTAREA|INPUT|SELECT/.test(e.target.tagName)) {
        e.preventDefault();
        $("btn-play").click();
    }
});

// ------------------------------------------------------------------
// Add-layer type picker modal (replaces prompt())
// ------------------------------------------------------------------
const TYPE_DESCRIPTIONS = {
    livingGradient: "Multi-color animated gradient — great base",
    flow: "Drifting organic noise field",
    particles: "Fireflies, snow, orbits…",
    pattern: "Dots, stripes, grids, halftone",
    shape: "Circle, ring, rect, line — expressions make them move",
    conicGradient: "Color sweep rotating around a center",
    waves: "Traveling plane wave with angle + phase",
    scope: "Waveform traces — edited in the Traces tab",
    curve: "Math curves — Lissajous, roses, spirographs",
    expression: "Per-pixel math (advanced)",
    gradient: "Simple 2-color gradient",
    color: "Solid color",
    image: "Static picture",
    gif: "Animated GIF",
    video: "Video clip"
};

function openTypePicker(onPick) {
    const existing = document.getElementById("type-picker");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "type-picker";
    const card = document.createElement("div");
    card.className = "tp-card";
    card.innerHTML = `<h2>Add a layer</h2>`;
    for (const t of SCENE_TYPES) {
        const btn = document.createElement("button");
        btn.className = "tp-btn";
        btn.innerHTML = `<b>${t}</b><span class="tp-desc">${TYPE_DESCRIPTIONS[t] || ""}</span>`;
        btn.addEventListener("click", () => { overlay.remove(); onPick(t); });
        card.appendChild(btn);
    }
    const cancel = document.createElement("button");
    cancel.className = "secondary tp-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => overlay.remove());
    card.appendChild(cancel);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

// ------------------------------------------------------------------
// Tabs — Traces is the primary workspace; everything technical lives in
// Advanced (which hosts the old Math/Layers/Design/Source panes).
// ------------------------------------------------------------------
document.querySelectorAll("#tabs button").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
    // Legacy targets (math/layers/design/source) now live inside Advanced.
    if (["math", "layers", "design", "source"].includes(name)) {
        switchTab("advanced");
        switchAdvTab(name);
        return;
    }
    document.querySelectorAll("#tabs button").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll("#tab-content > .tabpane").forEach(p =>
        p.classList.toggle("active", p.dataset.pane === name));
    if (name === "traces") renderTraceWorkspace();
    if (name === "math") renderMathSheet();
    // First open of Advanced must populate the default-active Math pane —
    // without this the sheet stayed blank until an atab was clicked.
    if (name === "advanced") renderMathSheet();
}
// Advanced sub-tabs (the old top-level tabs, one level down).
document.querySelectorAll("#adv-strip button").forEach(btn => {
    btn.addEventListener("click", () => switchAdvTab(btn.dataset.atab));
});
function switchAdvTab(name) {
    document.querySelectorAll("#adv-strip button").forEach(b =>
        b.classList.toggle("active", b.dataset.atab === name));
    document.querySelectorAll("#advanced-shell .tabpane").forEach(p =>
        p.classList.toggle("active", p.dataset.pane === name));
    if (name === "math") renderMathSheet();
}

// ------------------------------------------------------------------
// Presets (target = selected layer)
// ------------------------------------------------------------------
function initPresets() {
    const sel = $("preset-select");
    for (const p of listPresets()) {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.textContent = p.name;
        sel.appendChild(opt);
    }
    sel.addEventListener("change", renderPresetParams);
    renderPresetParams();
}
function renderPresetParams() {
    const name = $("preset-select").value;
    const preset = listPresets().find(p => p.name === name);
    const host = $("preset-params");
    host.innerHTML = "";
    for (const [k, def] of Object.entries(preset.params)) {
        const label = document.createElement("label");
        label.className = "field";
        label.append(`${k} `);
        const input = document.createElement("input");
        input.type = "number"; input.step = "any"; input.value = def;
        input.dataset.paramKey = k;
        label.appendChild(input);
        host.appendChild(label);
    }
}
$("btn-preset").addEventListener("click", () => {
    const name = $("preset-select").value;
    const params = {};
    for (const el of $("preset-params").querySelectorAll("[data-param-key]")) {
        params[el.dataset.paramKey] = parseFloat(el.value);
    }
    const frag = targetFragment();
    if (!frag) return;
    try {
        Object.assign(frag, applyPreset(JSON.parse(JSON.stringify(frag)), name, params));
        switchTab("layers");
        syncSourceFromWorking();
        loadToPlayer();
        setStatus(`applied "${name}"`, "ok");
    } catch (e) {
        setStatus("preset failed: " + e.message, "err");
    }
});

// ------------------------------------------------------------------
// Parameters panel (§8): named values with sliders, usable in any
// expression. Values may be numbers or expressions of t.
// ------------------------------------------------------------------
function renderParams() {
    // Rendered in both the Layers pane and the Math sheet.
    for (const hostId of ["param-list", "math-vars"]) {
        const host = $(hostId);
        if (!host) continue;
        host.innerHTML = "";
        const params = workingRaw?.parameters;
        if (!params) continue;
        for (const name of Object.keys(params)) {
            host.appendChild(paramRow(name));
        }
    }
}

function addParameter() {
    if (!workingRaw) return;
    if (!workingRaw.parameters) workingRaw.parameters = {};
    let i = 1;
    while (workingRaw.parameters[`param${i}`] !== undefined) i++;
    workingRaw.parameters[`param${i}`] = { value: 0.5, min: 0, max: 1, step: 0.01 };
    renderParams();
    commitEdits();
}

$("btn-add-param").addEventListener("click", addParameter);
$("btn-add-var").addEventListener("click", addParameter);

function paramRow(name) {
    const params = workingRaw.parameters;
    const spec = params[name];
    const row = document.createElement("div");
    row.className = "param-row";
    row.dataset.paramName = name;

    // Name (renaming does NOT rewrite expressions — validator will flag
    // stale references in the source/status).
    const nameEl = document.createElement("input");
    nameEl.type = "text";
    nameEl.value = name;
    nameEl.spellcheck = false;
    nameEl.addEventListener("change", () => {
        const newName = nameEl.value.trim();
        if (!newName || newName === name || /^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) === false) {
            nameEl.value = name;
            return;
        }
        const entries = Object.entries(params);
        const rebuilt = {};
        for (const [k, v] of entries) rebuilt[k === name ? newName : k] = v;
        workingRaw.parameters = rebuilt;
        renderParams();
        commitEdits();
    });

    // Value: number (slider-bound) or expression.
    const valEl = document.createElement("input");
    valEl.type = "text";
    valEl.step = "any";
    valEl.spellcheck = false;
    valEl.value = String(spec.value);
    valEl.title = "number or expression";

    // Slider.
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(spec.min ?? 0);
    slider.max = String(spec.max ?? 1);
    slider.step = String(spec.step ?? 0.01);

    // Editable bounds (Desmos-style slider ends).
    const minEl = document.createElement("input");
    minEl.type = "number"; minEl.step = "any";
    minEl.className = "pbound";
    minEl.value = String(spec.min ?? 0);
    minEl.title = "lower bound";
    const maxEl = document.createElement("input");
    maxEl.type = "number"; maxEl.step = "any";
    maxEl.className = "pbound";
    maxEl.value = String(spec.max ?? 1);
    maxEl.title = "upper bound";
    function applyBounds() {
        let lo = parseFloat(minEl.value), hi = parseFloat(maxEl.value);
        if (!Number.isFinite(lo)) lo = 0;
        if (!Number.isFinite(hi)) hi = 1;
        if (hi < lo) [lo, hi] = [hi, lo];
        spec.min = lo; spec.max = hi;
        minEl.value = String(lo); maxEl.value = String(hi);
        slider.min = String(lo); slider.max = String(hi);
        syncSlider();
        commitEdits();
    }
    minEl.addEventListener("change", applyBounds);
    maxEl.addEventListener("change", applyBounds);

    // Desmos-style play: animate the value between the bounds.
    const play = document.createElement("button");
    play.className = "secondary pplay";
    play.innerHTML = "&#9654;";
    play.title = `Animate ${name} between its bounds`;
    play.addEventListener("click", () => {
        if (sliderAnim.has(name)) {
            stopSliderAnim(name);
            play.innerHTML = "&#9654;";
            play.classList.remove("selected");
        } else {
            startSliderAnim(name);
            play.innerHTML = "&#10074;&#10074;";
            play.classList.add("selected");
        }
    });

    function syncSlider() {
        const n = typeof spec.value === "number" ? spec.value : parseFloat(spec.value);
        if (Number.isFinite(n)) {
            slider.disabled = false;
            slider.value = String(Math.min(Math.max(n, parseFloat(slider.min)), parseFloat(slider.max)));
        } else {
            slider.disabled = true;  // expression-driven value
        }
    }

    slider.addEventListener("input", () => {
        spec.value = parseFloat(slider.value);
        valEl.value = slider.value;
        commitEdits();
    });
    valEl.addEventListener("input", () => {
        spec.value = maybeNumber(valEl.value);
        syncSlider();
        commitEdits();
    });
    syncSlider();

    // Delete (also stops animation).
    const del = document.createElement("button");
    del.className = "secondary pdel";
    del.textContent = "✕";
    del.title = `Delete ${name}`;
    del.addEventListener("click", () => {
        stopSliderAnim(name);
        delete workingRaw.parameters[name];
        if (Object.keys(workingRaw.parameters).length === 0) delete workingRaw.parameters;
        renderParams();
        commitEdits();
    });

    row.append(nameEl, play, minEl, slider, maxEl, valEl, del);
    return row;
}

// ------------------------------------------------------------------
// Math sheet (default mode): type equations, they render. Each card is
// one R/G/B trio; extra cards stack additively. Unknown identifiers in
// an equation automatically become slider variables (Desmos-style).
// ------------------------------------------------------------------

/**
 * Desmos behavior: any invented name in an equation becomes a variable.
 * Scans the parsed AST for identifiers that aren't built-ins and aren't
 * declared yet, then creates them as 0..1 slider parameters.
 */
function adoptUnknownIdentifiers(source) {
    if (!workingRaw || typeof source !== "string" || !source.trim()) return;
    let ast;
    try {
        ast = compileExpression(source, undefined, true).ast;
    } catch { return; }   // incomplete input — nothing to adopt yet
    const found = new Set();
    (function walk(node) {
        if (!node || typeof node !== "object") return;
        if (node.kind === "var" && node.name) found.add(node.name);
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === "object") walk(v);
        }
    })(ast);
    if (found.size === 0) return;
    if (!workingRaw.parameters) workingRaw.parameters = {};
    let added = false;
    for (const name of found) {
        if (workingRaw.parameters[name]) continue;
        if (isReservedName(name)) continue;   // x, y, t, u, v, sin, pi…
        workingRaw.parameters[name] = { value: 0.5, min: 0, max: 1, step: 0.01 };
        added = true;
    }
    if (added) {
        renderParams();
        // The equation was invalid until now (unknown identifier); reload
        // so the preview picks it up instead of staying on "still typing".
        commitEdits();
    }
}

// ------------------------------------------------------------------
// Slider animation (Desmos "play" on a slider): ping-pongs the value
// between min and max and drives the preview at ~8 fps.
// ------------------------------------------------------------------
const sliderAnim = new Map();   // name -> {phase, raf, lastLoad, lastTick}

function animTick(name) {
    const anim = sliderAnim.get(name);
    const spec = workingRaw?.parameters?.[name];
    if (!anim || !spec) { stopSliderAnim(name); return; }

    const now = performance.now();
    const dt = Math.min(0.1, (now - anim.lastTick) / 1000);
    anim.lastTick = now;
    const period = 4;                       // seconds per full sweep
    anim.phase = (anim.phase + dt / period) % 2;
    const pos = anim.phase < 1 ? anim.phase : 2 - anim.phase;   // ping-pong
    const range = (spec.max - spec.min) || 1;
    spec.value = spec.min + range * pos;

    // Refresh the row widgets in place (both variable hosts).
    for (const hostId of ["param-list", "math-vars"]) {
        const row = $(hostId)?.querySelector(`.param-row[data-param-name="${name}"]`);
        if (!row) continue;
        const slider = row.querySelector("input[type=range]");
        const val = row.querySelector(".pval");
        if (slider) slider.value = String(spec.value);
        if (val) val.value = String(Math.round(spec.value * 1000) / 1000);
    }

    // Drive the preview at ~8 fps (parse+load is not free).
    if (now - anim.lastLoad > 120) {
        anim.lastLoad = now;
        loadToPlayer();
    }
    anim.raf = requestAnimationFrame(() => animTick(name));
}

function startSliderAnim(name) {
    const spec = workingRaw?.parameters?.[name];
    if (!spec) return;
    const range = (spec.max - spec.min) || 1;
    const cur = typeof spec.value === "number" ? spec.value : spec.min;
    sliderAnim.set(name, {
        phase: (cur - spec.min) / range * 2,
        raf: 0,
        lastLoad: 0,
        lastTick: performance.now()
    });
    animTick(name);
}

function stopSliderAnim(name) {
    const anim = sliderAnim.get(name);
    if (!anim) return;
    if (anim.raf) cancelAnimationFrame(anim.raf);
    sliderAnim.delete(name);
    syncSourceFromWorking();
    loadToPlayer();
}

/** Empty trio for "clear sheet" / additional equation groups. */
const BLANK_FIELD = () => ({
    type: "expression",
    r: "0", g: "0", b: "0",
    blend: "add"
});

/** Expression layers as math rows. `single` = the whole scene. */
function mathGroups() {
    if (!workingRaw) return [];
    const s = workingRaw.scene;
    if (s?.type === "expression") return [{ frag: s, index: -1, single: true }];
    if (s?.type === "composite") {
        return s.layers
            .map((frag, index) => ({ frag, index }))
            .filter(g => g.frag.type === "expression");
    }
    return null;   // scene is not equation-based
}

function renderMathSheet() {
    const host = $("math-sheet");
    host.innerHTML = "";
    renderShapesBar();
    if (!workingRaw) return;

    const groups = mathGroups();
    if (groups === null) {
        const empty = document.createElement("div");
        empty.className = "math-empty";
        empty.textContent = isTraceScene()
            ? "This is a waveform scene — its traces are edited in the Traces tab. " +
              "Raw channel equations can be added as layers here."
            : "These layers aren't equations. Use “clear sheet” to start from scratch.";
        host.appendChild(empty);
        return;
    }
    if (groups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "math-empty";
        empty.textContent = "Nothing here yet — add equations below.";
        host.appendChild(empty);
        return;
    }
    groups.forEach(g => host.appendChild(mathCard(g)));
}

function mathCard(group) {
    const card = document.createElement("div");
    card.className = "math-card";

    // Delete control only when there is more than one trio.
    const groups = mathGroups();
    if (!group.single && groups.length > 1) {
        const head = document.createElement("div");
        head.className = "math-head";
        const del = document.createElement("button");
        del.className = "secondary";
        del.textContent = "✕ remove";
        del.addEventListener("click", () => {
            const layers = workingRaw.scene.layers;
            layers.splice(group.index, 1);
            if (layers.length === 1) {
                workingRaw.scene = layers[0];   // unwrap single trio
            }
            renderMathSheet();
            renderLayers();
            commitEdits();
        });
        head.appendChild(del);
        card.appendChild(head);
    }

    for (const c of ["r", "g", "b"]) {
        const row = document.createElement("div");
        row.className = "ch-row";
        const badge = document.createElement("span");
        badge.className = `ch-badge ch-${c}`;
        badge.textContent = c.toUpperCase();
        row.appendChild(badge);

        const field = renderField(
            { key: c, label: "", kind: "expr", def: "0", noBadge: true },
            group.frag
        );
        row.appendChild(field);
        card.appendChild(row);

        // Desmos behavior: invented names become sliders automatically.
        // Debounced (250ms — shorter than commitEdits' 350ms) so typing
        // "amp" doesn't adopt "a" and "am" on the way, AND so the variable
        // exists before the first auto-commit: no "still typing" transient.
        const ta = field.querySelector("textarea");
        let adoptTimer = null;
        ta.addEventListener("input", () => {
            clearTimeout(adoptTimer);
            adoptTimer = setTimeout(() => {
                const before = Object.keys(workingRaw?.parameters || {}).length;
                adoptUnknownIdentifiers(ta.value);
                // Re-run inline validation now that the names exist.
                if (Object.keys(workingRaw?.parameters || {}).length > before) {
                    ta.dispatchEvent(new Event("input", { bubbles: false }));
                }
            }, 250);
        });
    }
    return card;
}

// Shape presets (PLAN_ADVANCED_MATH_POLISH.md): insert a working, slidable
// shape as an equation group. Equations use u,v (0..1) — x,y are pixels in
// this engine, so external "x,y ∈ 0..1" snippets silently paint black.
function renderShapesBar() {
    const host = $("math-shapes");
    if (!host) return;
    host.innerHTML = "";
    for (const preset of SHAPE_PRESETS) {
        const b = document.createElement("button");
        b.className = "secondary";
        b.textContent = preset.label;
        b.dataset.shape = preset.id;
        b.title = `insert a ${preset.label} (u,v equations, slidable cx/cy)`;
        b.addEventListener("click", () => insertShape(preset));
        host.appendChild(b);
    }
}

function insertShape(preset) {
    if (!workingRaw) return;
    // Waveform scenes layer fine now (scope wraps as the base layer) — no
    // guard; traces stay editable through the Traces workspace.
    // Adopt preset params without clobbering names the user already has.
    const params = workingRaw.parameters || (workingRaw.parameters = {});
    for (const [name, spec] of Object.entries(preset.params)) {
        if (!(name in params)) params[name] = { ...spec };
    }
    insertMathGroup(shapeFragment(preset));
    setStatus(`inserted ${preset.label} — drag cx / cy / ${
        "radius" in preset.params ? "radius" : "size" in preset.params ? "size" : "freq" in preset.params ? "freq" : "cx"
    } sliders in Variables below`, "ok");
}

/**
 * Insert an expression group into the sheet. Non-expression scenes
 * (waveform, gradient, particles…) are kept as the base layer and the
 * equations layer on top; single expression scenes are wrapped so the new
 * group sits above them. Never destroys existing layers.
 */
function insertMathGroup(frag) {
    ensureComposite();
    workingRaw.scene.layers.push(frag);
    selected = { kind: "layer", index: workingRaw.scene.layers.length - 1 };
    renderMathSheet();
    renderLayers();
    hydrateAll();
    commitEdits();
}

// ------------------------------------------------------------------
// AI round-trip: copy a paste-ready engine prompt, parse the bot's
// reply (R:/G:/B: lines) back into an equation group.
// (PLAN_ADVANCED_MATH_POLISH.md §5.)
// ------------------------------------------------------------------
async function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through to execCommand */ }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

// Clipboard reads can stall indefinitely — headless browsers, denied
// permission prompts and some embedders return a promise that never
// settles. The paste flow must never hang on one: race the read against a
// short timeout and fall back to an empty prompt the user can paste into.
function readClipboardText(timeoutMs) {
    try {
        if (!navigator.clipboard?.readText) return Promise.resolve("");
        return Promise.race([
            navigator.clipboard.readText().then(t => t || ""),
            new Promise(resolve => setTimeout(() => resolve(""), timeoutMs))
        ]).catch(() => "");
    } catch {
        return Promise.resolve("");
    }
}

$("btn-ai-prompt").addEventListener("click", async () => {
    const ok = await copyText(ENGINE_PROMPT);
    setStatus(ok
        ? "engine prompt copied — paste it into any AI, then use “paste reply”"
        : "copy failed — select the prompt from the source pane instead", ok ? "ok" : "warn");
});

$("btn-ai-paste").addEventListener("click", async () => {
    if (!workingRaw) return;
    const text = await readClipboardText(400);
    const entered = prompt(
        text
            ? "Clipboard contents (edit if needed, then OK):"
            : "Paste the AI reply (three lines: R: … G: … B: …), then OK:",
        text || "");
    if (entered === null) return;   // cancel
    const parsed = parseAIReply(entered);
    if (!parsed) {
        setStatus("couldn't find R:/G:/B: lines in that reply — " +
            "the bot should answer with exactly three lines", "warn");
        return;
    }
    // Adopt invented names as sliders, then insert.
    for (const expr of [parsed.r, parsed.g, parsed.b]) adoptUnknownIdentifiers(expr);
    insertMathGroup({ type: "expression", r: parsed.r, g: parsed.g, b: parsed.b, blend: "add" });
    setStatus("inserted AI equations — new names became sliders below", "ok");
});

// Old top-level Math tab is now an Advanced pane: it edits raw per-pixel
// channel fields. Scenes are no longer auto-created here; point people back
// to the primary workspace unless they specifically want raw pixel math.
$("btn-add-field").addEventListener("click", () => {
    if (!workingRaw) return;
    insertMathGroup(BLANK_FIELD());
});

$("btn-new-math").addEventListener("click", () => {
    if (!workingRaw) return;
    // Don't let the raw sheet wipe a trace scene — waveforms are edited in
    // the Traces workspace; raw fields can be added as layers instead.
    // Same guard for composites that CONTAIN a scope layer.
    if (isTraceScene() ||
        (isComposite() && workingRaw.scene.layers.some(l => l?.type === "scope"))) {
        setStatus("this scene has waveforms — edit traces in the Traces tab, " +
            "or add/remove raw equations layers in Layers", "warn");
        return;
    }
    workingRaw.scene = BLANK_FIELD();
    workingRaw.parameters = {};
    selected = { kind: "scene", index: -1 };
    hydrateAll();
    syncSourceFromWorking();
    loadToPlayer();
    switchTab("math");
});

// Time controls for the math sheet (mirror the Design tab fields).
$("math-duration").addEventListener("input", () => {
    if (!workingRaw) return;
    const dur = num("math-duration", 8);
    workingRaw.timeline = { ...(workingRaw.timeline || { loop: true }), duration: dur };
    const d = $("f-duration");
    if (d) d.value = String(dur);
    commitEdits();
});
$("math-speed").addEventListener("change", e => {
    if (player) player.setPlaybackRate(parseFloat(e.target.value));
    const s = $("f-speed");
    if (s) s.value = e.target.value;
});

// ------------------------------------------------------------------
// Timeline transport extras (§23): restart, frame stepping, speed.
// ------------------------------------------------------------------
$("btn-restart").addEventListener("click", () => {
    if (!player) return;
    player.scrub(0);
    if (playing) player.play();
});
function stepFrame(dir) {
    if (!player) return;
    player.pause();
    playing = false;
    $("btn-play").innerHTML = "&#9654;";
    const fps = player.runtime?.definitionRef?.quality?.fps || 30;
    player.scrub(Math.max(0, player.getTime() + dir / fps));
}
$("btn-step-back").addEventListener("click", () => stepFrame(-1));
$("btn-step-fwd").addEventListener("click", () => stepFrame(1));
$("f-speed").addEventListener("change", e => {
    if (player) player.setPlaybackRate(parseFloat(e.target.value));
});

// ------------------------------------------------------------------
// Pixel inspector (§22): hover the preview to read the underlying field.
// ------------------------------------------------------------------
const inspectorEl = $("inspector");
const shellEl = $("shell");
let inspDef = null;          // parsed definition for inspection
let inspBuf = null;
let inspT = -1;
const INSP_W = 96, INSP_H = 54;

/** Keep the inspection definition in sync whenever the player loads. */
function setInspectDefinition(parsed) {
    inspDef = parsed || null;
    inspBuf = null;
    inspT = -1;
}

function inspectAt(clientX, clientY) {
    if (!inspDef) return;
    const rect = shellEl.getBoundingClientRect();
    const u = (clientX - rect.left) / Math.max(1, rect.width);
    const v = (clientY - rect.top) / Math.max(1, rect.height);
    if (u < 0 || u > 1 || v < 0 || v > 1) { inspectorEl.style.display = "none"; return; }

    try {
        const t = player ? player.getTime() : 0;
        if (!inspBuf || t !== inspT) {
            inspBuf = rasterize(inspDef, t, { width: INSP_W, height: INSP_H });
            inspT = t;
        }
        const x = Math.min(INSP_W - 1, Math.round(u * (INSP_W - 1)));
        const y = Math.min(INSP_H - 1, Math.round(v * (INSP_H - 1)));
        const i = (y * INSP_W + x) * 3;
        const r = inspBuf[i] / 255, g = inspBuf[i + 1] / 255, b = inspBuf[i + 2] / 255;
        inspectorEl.textContent =
            `x ${(u).toFixed(3)}  y ${(v).toFixed(3)}\n` +
            `R ${(r * 100).toFixed(1)}  G ${(g * 100).toFixed(1)}  B ${(b * 100).toFixed(1)}\n` +
            `#${toHexValue({ r, g, b })}`;
        inspectorEl.style.display = "block";
    } catch {
        inspectorEl.style.display = "none";
    }
}
shellEl.addEventListener("pointermove", e => {
    if (e.pointerType === "touch") return;
    inspectAt(e.clientX, e.clientY);
});
shellEl.addEventListener("pointerleave", () => { inspectorEl.style.display = "none"; });

// ------------------------------------------------------------------
// Traces — the primary workspace. Simple visual editing: waveform,
// color, Height / Frequency / Position / Speed up front; Phase and
// Thickness (and Custom expressions) tucked into "More". No jargon.
// ------------------------------------------------------------------

const TRACE_WAVEFORMS = ["sine", "square", "triangle", "sawtooth", "custom"];
const TRACE_SIGNAL_VARS = new Set(["p", "frequency", "sweepSpeed", "phaseOffset"]);
const TRACE_KNOB_META = {
    amplitude:  { label: "Height",     min: 0,    max: 1,    step: 0.01,
                  tip: "How tall the wave appears." },
    frequency:  { label: "Frequency",  min: 0,    max: 8,    step: 0.05,
                  tip: "How many waves are visible across the screen." },
    offset:     { label: "Position",   min: 0,    max: 1,    step: 0.01,
                  tip: "Moves the wave up or down." },
    sweepSpeed: { label: "Speed",      min: -12,  max: 12,   step: 0.1,
                  tip: "How quickly the wave moves across the screen." },
    phaseOffset:{ label: "Phase",      min: -6.5, max: 6.5,  step: 0.05,
                  tip: "Shifts the wave relative to the others." },
    thickness:  { label: "Thickness",  min: 0.005, max: 0.08, step: 0.001,
                  tip: "Changes the thickness of the line." }
};

function isTraceScene() {
    return workingRaw?.scene?.type === "scope";
}

/**
 * The scope fragment the Traces workspace should edit: the scene itself
 * when it is a scope, or the selected layer when a composite contains a
 * scope layer. (Scopes are valid composite layers — PLAN §5.)
 */
function activeScopeScene() {
    if (!workingRaw) return null;
    if (isTraceScene()) return workingRaw.scene;
    if (isComposite()) {
        const frag = workingRaw.scene.layers[selected.index];
        if (frag?.type === "scope") return frag;
    }
    return null;
}

/** Traces tab must never dead-end: snap selection to the first scope layer.
 *  Only fires while the Traces pane is visible — otherwise it would fight
 *  Layers-tab selection of non-scope layers. */
function ensureScopeSelection() {
    if (!workingRaw || isTraceScene() || !isComposite()) return;
    if (activeScopeScene()) return;
    const tabPane = document.querySelector('#tab-content > .tabpane.active');
    if (tabPane?.dataset.pane !== "traces") return;
    const i = workingRaw.scene.layers.findIndex(l => l?.type === "scope");
    if (i >= 0) {
        selected = { kind: "layer", index: i };
        renderLayers();
        renderLayerEditor();
    }
}

// Boot traces keep the canonical three-phase look: pure primaries, no
// channel binding (a pure primary renders identically bound or unbound —
// channel binding is an opt-in PenTile experiment, not the default idea
// of "color"). Traces added later cycle a curated non-RGB palette.
const TRACE_PALETTE = ["#ffb454", "#4fd6e0", "#b48cff", "#ff8ac2", "#7fe0b0", "#e8e8ee"];

function traceDefaults(extra) {
    return {
        type: "trace", waveform: "sine", amplitude: 0.35, frequency: 2,
        offset: 0.5, sweepSpeed: 4, thickness: 0.02, enabled: true, ...extra
    };
}

function defaultTrace(i) {
    const presets = [
        { name: "R", color: "#ff0000", phaseOffset: 0 },
        { name: "G", color: "#00ff00", phaseOffset: -2 * Math.PI / 3 },
        { name: "B", color: "#0000ff", phaseOffset: -4 * Math.PI / 3 }
    ];
    const p = presets[i % 3];
    return traceDefaults({ ...p });
}

function addedTrace(count) {
    const len = TRACE_PALETTE.length;
    const color = TRACE_PALETTE[((count - 3) % len + len) % len];
    return traceDefaults({
        name: `Trace ${count + 1}`,
        color,
        phaseOffset: -0.4 * count
    });
}

function blankScopeScene() {
    return {
        type: "scope",
        rows: [defaultTrace(0), defaultTrace(1), defaultTrace(2)]
    };
}

function traceChannelBadge(row) {
    if (row.channel === "r" || row.channel === "g" || row.channel === "b") {
        const b = document.createElement("span");
        b.className = `ch-badge ch-${row.channel}`;
        b.style.cssText = "width:auto;padding:4px 7px;margin-top:0;";
        b.textContent = row.channel.toUpperCase();
        return b;
    }
    return null;
}

/** 0..1 component of a hex color for one channel, or null when the value
 *  isn't a hex string (e.g. expression-driven). */
function colorComponent(color, ch) {
    let h = typeof color === "string" ? color.trim() : "";
    if (h[0] !== "#") return null;
    h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const i = ch === "r" ? 0 : ch === "g" ? 2 : 4;
    return parseInt(h.slice(i, i + 2), 16) / 255;
}

/** Bound channel with (almost) no component in the trace color → the trace
 *  would render invisible. Returns the channel letter for the warning. */
function boundChannelMissing(row) {
    const ch = row.channel;
    if (ch !== "r" && ch !== "g" && ch !== "b") return null;
    const v = colorComponent(row.color, ch);
    if (v === null) return null;
    return v < 0.06 ? ch.toUpperCase() : null;
}

/** Desmos-style: invented names in a custom expression become sliders —
 *  except the signal variables, which are built into every trace. */
function adoptTraceIdentifiers(source) {
    if (!workingRaw || typeof source !== "string" || !source.trim()) return;
    let ast;
    try { ast = compileExpression(source, undefined, true).ast; } catch { return; }
    const found = new Set();
    (function walk(node) {
        if (!node || typeof node !== "object") return;
        if (node.kind === "var" && node.name) found.add(node.name);
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === "object") walk(v);
        }
    })(ast);
    let added = false;
    for (const name of found) {
        if (TRACE_SIGNAL_VARS.has(name)) continue;   // built into traces
        if (isReservedName(name)) continue;
        if (workingRaw.parameters?.[name]) continue;
        if (!workingRaw.parameters) workingRaw.parameters = {};
        workingRaw.parameters[name] = { value: 0.5, min: 0, max: 1, step: 0.01 };
        added = true;
    }
    if (added) renderParams();
}

function traceKnob(row, key) {
    const meta = TRACE_KNOB_META[key];
    const wrap = document.createElement("div");
    wrap.className = "knob";
    const label = document.createElement("label");
    label.textContent = meta.label;
    label.title = meta.tip;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(meta.min); slider.max = String(meta.max);
    slider.step = String(meta.step);
    slider.value = String(typeof row[key] === "number" ? row[key] : 0);
    const num = document.createElement("input");
    num.className = "knum"; num.type = "text"; num.spellcheck = false;
    num.value = slider.value;
    slider.addEventListener("input", () => {
        row[key] = parseFloat(slider.value);
        num.value = slider.value;
        commitEdits();
    });
    num.addEventListener("change", () => {
        const n = parseFloat(num.value);
        if (Number.isFinite(n)) {
            row[key] = n;
            slider.value = String(Math.min(meta.max, Math.max(meta.min, n)));
            commitEdits();
        } else {
            num.value = String(row[key] ?? 0);
        }
    });
    wrap.append(label, slider, num);
    return wrap;
}

function traceCard(row, index) {
    const card = document.createElement("details");
    card.className = "trace-card";
    if (row._open) card.open = true;
    card.addEventListener("toggle", () => { row._open = card.open; });

    // --- header (always visible) ---
    const head = document.createElement("summary");
    head.className = "trace-head";
    const caret = document.createElement("span");
    caret.className = "trace-caret";
    caret.textContent = "▸";
    card.addEventListener("toggle", () => { caret.textContent = card.open ? "▾" : "▸"; });
    caret.textContent = card.open ? "▾" : "▸";
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "trace-swatch";
    swatch.title = "Trace color";
    swatch.setAttribute("aria-label", "Trace color");
    attachColorPopover(swatch, {
        get: () => chanToHex(row.color),
        set: hex => { row.color = hex; commitEdits(); }
    });
    const name = document.createElement("input");
    name.type = "text"; name.className = "trace-name";
    name.value = row.name || "";
    name.placeholder = "trace";
    name.title = "Trace name";
    name.addEventListener("click", e => e.preventDefault());
    name.addEventListener("input", () => {
        row.name = name.value;
        commitEdits();
    });
    const waveSel = document.createElement("select");
    for (const w of TRACE_WAVEFORMS) {
        const opt = document.createElement("option");
        opt.value = w; opt.textContent = w;
        waveSel.appendChild(opt);
    }
    waveSel.value = TRACE_WAVEFORMS.includes(row.waveform) ? row.waveform : "sine";
    waveSel.title = "Waveform shape";
    waveSel.addEventListener("change", () => {
        row.waveform = waveSel.value;
        if (row.waveform === "custom" && typeof row.expression !== "string") {
            row.expression = "sin(p)";
        }
        row._open = true;   // stay open through the re-render
        renderTraceWorkspace(true);
        commitEdits();
    });
    const enable = document.createElement("input");
    enable.type = "checkbox"; enable.className = "trace-enable";
    enable.checked = row.enabled !== false;
    enable.title = "Show / hide this trace";
    enable.addEventListener("change", () => {
        row.enabled = enable.checked;
        commitEdits();
    });
    const del = document.createElement("button");
    del.className = "secondary trace-del";
    del.textContent = "✕";
    del.title = "Delete this trace";
    del.addEventListener("click", e => {
        e.preventDefault();
        scopeRows().splice(index, 1);
        renderTraceWorkspace(true);
        commitEdits();
    });
    const badge = traceChannelBadge(row);
    head.append(caret, swatch, name);
    if (badge) head.appendChild(badge);
    head.append(waveSel, enable, del);
    card.appendChild(head);

    // --- body: primary knobs, then More (Phase / Thickness / expression) ---
    const body = document.createElement("div");
    body.className = "trace-body";
    for (const k of ["amplitude", "frequency", "offset", "sweepSpeed"]) {
        body.appendChild(traceKnob(row, k));
    }
    const more = document.createElement("details");
    more.className = "more-wrap";
    const moreBtn = document.createElement("summary");
    moreBtn.className = "more-btn";
    moreBtn.textContent = "More…";
    more.appendChild(moreBtn);
    const moreBody = document.createElement("div");
    for (const k of ["phaseOffset", "thickness"]) moreBody.appendChild(traceKnob(row, k));

    // Emitter channel: an explicit opt-in PenTile experiment. Unbound (None)
    // traces render their full selected color; binding restricts the trace
    // to one subpixel channel of the display.
    const chWrap = document.createElement("label");
    chWrap.className = "field";
    chWrap.innerHTML =
        `Emitter channel <span class="hint">PenTile experiment: lights only that ` +
        `subpixel channel. None = full selected color.</span>`;
    const chSel = document.createElement("select");
    for (const [val, label] of [["", "None"], ["r", "R"], ["g", "G"], ["b", "B"]]) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        chSel.appendChild(opt);
    }
    chSel.value = ["r", "g", "b"].includes(row.channel) ? row.channel : "";
    chSel.addEventListener("change", () => {
        if (chSel.value) row.channel = chSel.value;
        else delete row.channel;
        renderTraceWorkspace(true);
        commitEdits();
    });
    chWrap.appendChild(chSel);
    const missing = boundChannelMissing(row);
    if (missing) {
        const warn = document.createElement("div");
        warn.className = "ch-warn";
        warn.textContent =
            `This trace's color has no ${missing} — it will render nearly invisible.`;
        chWrap.appendChild(warn);
    }
    moreBody.appendChild(chWrap);
    if (row.waveform === "custom") {
        const f = document.createElement("label");
        f.className = "field";
        f.innerHTML =
            `Expression <span class="expr-badge">signal</span>` +
            `<span class="hint">Shape only — Height/Position apply after it. ` +
            `Variables: p (sweep angle), x, t, frequency, sweepSpeed, phaseOffset. Try sin(p).</span>`;
        const ta = document.createElement("textarea");
        ta.rows = 2; ta.spellcheck = false;
        ta.value = typeof row.expression === "string" ? row.expression : "sin(p)";
        let adoptTimer = null;
        ta.addEventListener("input", () => {
            row.expression = ta.value;
            clearTimeout(adoptTimer);
            adoptTimer = setTimeout(() => {
                const before = Object.keys(workingRaw?.parameters || {}).length;
                adoptTraceIdentifiers(ta.value);
                if (Object.keys(workingRaw?.parameters || {}).length > before) {
                    ta.dispatchEvent(new Event("input", { bubbles: false }));
                }
            }, 250);
            commitEdits();
        });
        f.appendChild(ta);
        moreBody.appendChild(f);
        attachExprEditor(ta, { signal: true });
    }
    more.appendChild(moreBody);
    body.appendChild(more);
    card.appendChild(body);
    return card;
}

// --- background: simple color editing; raw expressions stay in Advanced ---
function appendBackgroundCard(tbody, rows) {
    const idx = rows.findIndex(r => !r || r.type !== "trace");
    const card = document.createElement("div");
    card.className = "bg-card";
    if (idx === -1) {
        card.innerHTML =
            `<span class="bg-note">No background — traces draw on black.</span>`;
    } else {
        const bg = rows[idx];
        const isColor = bg.type === "color";
        const sw = document.createElement("button");
        sw.type = "button";
        sw.className = "trace-swatch";
        sw.title = "Background color";
        sw.setAttribute("aria-label", "Background color");
        if (isColor) {
            attachColorPopover(sw, {
                get: () => toHex(bg.color) || "#000000",
                set: hex => { bg.color = hex; commitEdits(); }
            });
        } else {
            sw.disabled = true;
            sw.style.background = toHex(bg.color) || "#000000";
        }
        const note = document.createElement("span");
        note.className = "bg-note";
        note.textContent = isColor
            ? "Background"
            : `Background (${bg.type}) — edit in Advanced → Math`;
        const del = document.createElement("button");
        del.className = "secondary trace-del"; del.textContent = "✕";
        del.title = "Remove background";
        del.addEventListener("click", () => {
            rows.splice(idx, 1);
            renderTraceWorkspace(true);
            commitEdits();
        });
        card.append(sw, note, del);
    }
    tbody.appendChild(card);
}

const traceUIState = { tracesOpen: true, displayOpen: true };

function buildDisplaySection() {
    const sec = document.createElement("details");
    sec.className = "ws-section";
    sec.open = traceUIState.displayOpen;
    sec.addEventListener("toggle", () => { traceUIState.displayOpen = sec.open; });
    const s = document.createElement("summary");
    s.textContent = "Display";
    sec.appendChild(s);
    const body = document.createElement("div");
    body.className = "ws-body";

    // Vertical scale — serialized; the renderer maps signal -> screen.
    const vs = document.createElement("div");
    vs.className = "knob";
    const vsLab = document.createElement("label");
    vsLab.textContent = "Vertical scale";
    vsLab.title = "Stretches all waves vertically together.";
    const vsR = document.createElement("input");
    vsR.type = "range"; vsR.min = "0.2"; vsR.max = "2"; vsR.step = "0.05";
    const cur = typeof workingRaw.scene.verticalScale === "number"
        ? workingRaw.scene.verticalScale : 1;
    vsR.value = String(cur);
    const vsN = document.createElement("input");
    vsN.className = "knum"; vsN.type = "text"; vsN.value = String(cur);
    vsR.addEventListener("input", () => {
        workingRaw.scene.verticalScale = parseFloat(vsR.value);
        vsN.value = vsR.value;
        commitEdits();
    });
    vsN.addEventListener("change", () => {
        const n = parseFloat(vsN.value);
        if (Number.isFinite(n)) {
            workingRaw.scene.verticalScale = n;
            commitEdits();
        } else {
            vsN.value = String(workingRaw.scene.verticalScale ?? 1);
        }
    });
    vs.append(vsLab, vsR, vsN);
    body.appendChild(vs);

    // Grid + center line: studio-only overlays. Never serialized, never
    // rendered by the AMOLED simulator, not part of exports.
    const gridRow = document.createElement("div");
    gridRow.style.cssText = "display:flex; gap:18px; margin-top:10px; align-items:center; flex-wrap:wrap;";
    for (const [key, label, tip] of [
        ["grid", "Grid", "Editing aid only — shows divisions on the preview. Never saved."],
        ["centerline", "Center line", "Editing aid only — marks the vertical middle. Never saved."]
    ]) {
        const lab = document.createElement("label");
        lab.style.cssText = "display:flex;gap:6px;align-items:center;color:var(--dim);font-size:12px;cursor:pointer;";
        lab.title = tip;
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "trace-enable";
        cb.checked = localStorage.getItem(key) === "1";
        cb.addEventListener("change", () => {
            localStorage.setItem(key, cb.checked ? "1" : "0");
            updateScopeOverlay();
        });
        lab.append(cb, document.createTextNode(label));
        gridRow.appendChild(lab);
    }
    const glowNote = document.createElement("span");
    glowNote.className = "hint";
    glowNote.style.marginLeft = "auto";
    glowNote.textContent = "Glow & brightness: Advanced → Design";
    gridRow.appendChild(glowNote);
    body.appendChild(gridRow);
    sec.appendChild(body);
    return sec;
}

function buildAdvancedSection() {
    const sec = document.createElement("details");
    sec.className = "ws-section";
    const s = document.createElement("summary");
    s.textContent = "Advanced";
    sec.appendChild(s);
    const body = document.createElement("div");
    body.className = "ws-body";
    body.innerHTML =
        `<span class="hint">Raw channel equations, layers, blending, display design and the scene source live here.</span>`;
    const btn = document.createElement("button");
    btn.className = "secondary"; btn.style.marginTop = "8px";
    btn.textContent = "Open Advanced";
    btn.addEventListener("click", () => switchTab("advanced"));
    body.appendChild(btn);
    sec.appendChild(body);
    return sec;
}

function buildHelpNote() {
    const d = document.createElement("details");
    d.className = "ws-help";
    d.innerHTML =
        `<summary>How this works</summary>` +
        `<div class="hint">A trace is a moving waveform. Height controls how tall it is · ` +
        `Position moves it up or down · Frequency controls how many waves are visible · ` +
        `Speed controls how quickly it moves · Phase shifts it relative to the others.<br><br>` +
        `Custom expressions define the wave shape: <code>sin(p)</code> is the built-in sine; ` +
        `<code>sin(p) + 0.3*sin(3*p)</code> adds a harmonic. Height and Position still apply afterwards.</div>`;
    return d;
}

function scopeRows() {
    return activeScopeScene()?.rows || [];
}

let _traceSig = "";
function renderTraceWorkspace(force = false) {
    ensureScopeSelection();
    const scope = activeScopeScene();
    document.body.classList.toggle("trace-mode", !!scope);
    const pane = $("pane-traces");
    if (!pane || !workingRaw) return;
    // Commit-driven reloads (every knob drag) must NOT rebuild the DOM —
    // that would steal focus mid-drag. Only structure changes (scene type,
    // trace count, selected layer) or an explicit force trigger a rebuild.
    const sig = `${workingRaw?.scene?.type}:${selected.kind === "layer" ? selected.index : -1}:${
        (scope?.rows || []).filter(r => r?.type === "trace").length}`;
    if (!force && sig === _traceSig) { updateScopeOverlay(); return; }
    _traceSig = sig;
    pane.innerHTML = "";

    if (!scope) {
        // No scope selected: composite scenes may still CONTAIN scope layers
        // — point at them instead of offering a destructive wipe.
        const note = document.createElement("div");
        note.className = "math-empty";
        if (isComposite()) {
            note.innerHTML =
                `This scene is a composite — select a waveform layer in ` +
                `<b>Layers</b> to edit its traces here.`;
            const hasScope = workingRaw.scene.layers.some(l => l?.type === "scope");
            if (!hasScope) {
                const add = document.createElement("button");
                add.style.marginTop = "8px";
                add.textContent = "+ Add waveform layer";
                add.addEventListener("click", () => {
                    workingRaw.scene.layers.push(blankScopeScene());
                    selected = { kind: "layer", index: workingRaw.scene.layers.length - 1 };
                    afterStructureChange();
                    switchTab("traces");
                });
                note.appendChild(add);
            }
        } else {
            note.innerHTML =
                `This scene isn't a waveform scene — it renders unchanged.<br>` +
                `Edit it with the raw tools in <b>Advanced</b>, or start fresh:`;
            const btn = document.createElement("button");
            btn.style.marginTop = "8px";
            btn.textContent = "Start a waveform scene";
            btn.addEventListener("click", () => {
                workingRaw.scene = blankScopeScene();
                selected = { kind: "scene", index: -1 };
                hydrateAll();
                syncSourceFromWorking();
                loadToPlayer();
            });
            note.appendChild(btn);
        }
        pane.appendChild(note);
        updateScopeOverlay();
        return;
    }

    // Editing a scope layer inside a composite: say so explicitly.
    if (isComposite()) {
        const banner = document.createElement("div");
        banner.className = "hint";
        banner.style.marginBottom = "8px";
        // Number matches the top-first chip badge (1 = topmost).
        banner.textContent =
            `Editing waveform layer ${layerCount() - selected.index} — other layers keep rendering underneath.`;
        pane.appendChild(banner);
    }

    // --- TRACES section ---
    const traces = document.createElement("details");
    traces.className = "ws-section";
    traces.open = traceUIState.tracesOpen;
    traces.addEventListener("toggle", () => { traceUIState.tracesOpen = traces.open; });
    const ts = document.createElement("summary");
    ts.textContent = "Traces";
    traces.appendChild(ts);
    const tbody = document.createElement("div");
    tbody.className = "ws-body";
    const rows = scope.rows;
    rows.forEach((row, i) => {
        if (row && row.type === "trace") tbody.appendChild(traceCard(row, i));
    });
    const addRow = document.createElement("div");
    addRow.className = "layer-actions";
    const addT = document.createElement("button");
    addT.textContent = "+ Add trace";
    addT.addEventListener("click", () => {
        const n = rows.filter(r => r && r.type === "trace").length;
        rows.push(addedTrace(n));
        renderTraceWorkspace(true);
        commitEdits();
    });
    const addB = document.createElement("button");
    addB.className = "secondary";
    addB.textContent = "+ Background";
    addB.addEventListener("click", () => {
        rows.unshift({ type: "color", color: "#000000" });
        renderTraceWorkspace(true);
        commitEdits();
    });
    addRow.append(addT, addB);
    tbody.appendChild(addRow);
    appendBackgroundCard(tbody, rows);
    traces.appendChild(tbody);
    pane.appendChild(traces);

    // --- DISPLAY section ---
    pane.appendChild(buildDisplaySection());

    // --- ADVANCED (collapsed by default) ---
    pane.appendChild(buildAdvancedSection());

    // --- small plain-language help affordance ---
    pane.appendChild(buildHelpNote());

    updateScopeOverlay();
}

// --- studio-only scope overlay (grid / center line) ---
function updateScopeOverlay() {
    const ov = $("scope-overlay");
    if (!ov) return;
    ov.innerHTML = "";
    if (localStorage.getItem("grid") === "1") {
        const g = document.createElement("div");
        g.className = "so-grid";
        ov.appendChild(g);
    }
    if (localStorage.getItem("centerline") === "1") {
        const c = document.createElement("div");
        c.className = "so-center";
        ov.appendChild(c);
    }
    ov.style.display = ov.childElementCount ? "block" : "none";
}

// ------------------------------------------------------------------
// Resizable preview/editor split (desktop): drag, touch, keyboard
// nudge, double-click to reset. Persists across reloads.
// ------------------------------------------------------------------
const divider = $("col-divider");
const PREVIEW_W_KEY = "amo.previewWidth";
const PREVIEW_W_DEFAULT = 46;   // vw

function applyPreviewWidth(vw) {
    document.body.style.setProperty("--preview-w", `${vw}vw`);
}
function clampPreviewWidth(px) {
    const bodyW = document.body.clientWidth;
    const min = Math.min(320, Math.max(200, bodyW * 0.18));
    const max = bodyW - 380;   // keep the editor comfortably usable
    return Math.min(Math.max(px, min), Math.max(min, max));
}
(function initDivider() {
    if (!divider) return;
    const saved = parseFloat(localStorage.getItem(PREVIEW_W_KEY));
    applyPreviewWidth(Number.isFinite(saved) ? saved : PREVIEW_W_DEFAULT);
    let dragging = false, dragStartX = 0, startW = 0;

    divider.addEventListener("pointerdown", e => {
        if (window.innerWidth < 1000) return;
        dragging = true;
        dragStartX = e.clientX;
        startW = $("preview-section").getBoundingClientRect().width;
        divider.setPointerCapture(e.pointerId);
        document.body.classList.add("col-resizing");
    });
    divider.addEventListener("pointermove", e => {
        if (!dragging) return;
        const w = clampPreviewWidth(startW + (e.clientX - dragStartX));
        applyPreviewWidth((w / document.body.clientWidth) * 100);
    });
    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove("col-resizing");
        const pv = $("preview-section").getBoundingClientRect().width;
        localStorage.setItem(PREVIEW_W_KEY, String((pv / document.body.clientWidth) * 100));
    };
    divider.addEventListener("pointerup", endDrag);
    divider.addEventListener("pointercancel", endDrag);
    divider.addEventListener("dblclick", () => {
        localStorage.removeItem(PREVIEW_W_KEY);
        applyPreviewWidth(PREVIEW_W_DEFAULT);
    });
    divider.addEventListener("keydown", e => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = (e.shiftKey ? 4 : 1) * document.body.clientWidth / 100;
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const pv = $("preview-section").getBoundingClientRect().width;
        const w = clampPreviewWidth(pv + dir * step);
        const vw = (w / document.body.clientWidth) * 100;
        applyPreviewWidth(vw);
        localStorage.setItem(PREVIEW_W_KEY, String(vw));
    });
})();

// ------------------------------------------------------------------
// Gallery
// ------------------------------------------------------------------
const GALLERY = ["flowfield", "fireflies", "parallax", "plasma", "dots",
    "gradient", "procedural", "rain", "clip", "composite",
    "three-phase", "three-phase-scope", "orbiting-emitters",
    "lissajous", "harmonograph", "rose", "spirograph"];
const GALLERY_LABELS = {
    flowfield: "green flow", fireflies: "fireflies", parallax: "parallax mist",
    plasma: "plasma math", dots: "dot grid",
    "three-phase": "3-phase AC", "three-phase-scope": "3-phase scope",
    "orbiting-emitters": "orbiting emitters"
};

async function initGallery() {
    // Anchored at the bottom of the Advanced shell (not inside the Layers
    // pane): examples load whole scenes, not layers — parking them between
    // the layer list and the layer actions was noise (PLAN_ADVANCED_MATH_POLISH).
    const host = document.getElementById("advanced-shell");

    // file:// mode: fetch() is blocked by the browser — explain instead of
    // silently showing an empty gallery.
    if (location.protocol === "file:") {
        $("env-banner").style.display = "block";
        const note = document.createElement("div");
        note.className = "hint";
        note.textContent =
            "Examples are unavailable over file:// — serve the folder over http to enable them. " +
            "Editing and Export work fine.";
        host.appendChild(note);
        return;
    }

    const galTitle = document.createElement("h2");
    galTitle.textContent = "Examples — tap to load";
    galTitle.id = "gallery-title";
    host.appendChild(galTitle);
    const gal = document.createElement("div");
    gal.className = "layer-actions";
    gal.id = "gallery";
    host.appendChild(gal);

    for (const name of GALLERY) {
        try {
            const res = await fetch(`/scenes/${name}.amo`, { method: "HEAD" });
            if (!res.ok) continue;
        } catch { continue; }
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.textContent = GALLERY_LABELS[name] || name;
        btn.addEventListener("click", async () => {
            try {
                const res = await fetch(`/scenes/${name}.amo`);
                workingRaw = JSON.parse(await res.text());
                parseAmo(workingRaw, location.href);
                selected = isComposite()
                    ? { kind: "layer", index: workingRaw.scene.layers.length - 1 }
                    : { kind: "scene", index: -1 };
                hydrateAll();
                syncSourceFromWorking();
                loadToPlayer();
                window.scrollTo(0, 0);
            } catch (e) {
                setStatus("gallery load failed: " + e.message, "err");
            }
        });
        gal.appendChild(btn);
    }
}

// ------------------------------------------------------------------
// Export / import
// ------------------------------------------------------------------
$("btn-export").addEventListener("click", () => {
    const name = ((workingRaw?.meta?.name) || "scene").replace(/[^\w-]+/g, "-").toLowerCase();
    const blob = new Blob([JSON.stringify(workingRaw, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".amo";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("btn-import").addEventListener("click", () => $("file-import").click());
$("file-import").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        workingRaw = JSON.parse(await file.text());
        parseAmo(workingRaw, location.href);
        selected = isComposite()
            ? { kind: "layer", index: workingRaw.scene.layers.length - 1 }
            : { kind: "scene", index: -1 };
        hydrateAll();
        syncSourceFromWorking();
        loadToPlayer();
    } catch (err) {
        setStatus("import failed: " + err.message, "err");
    }
    e.target.value = "";
});

// ------------------------------------------------------------------
// Wire-up
// ------------------------------------------------------------------
for (const id of ["f-name", "f-author"]) $(id).addEventListener("input", onDesignEdit);
document.querySelectorAll("[data-pane='design'] input, [data-pane='design'] select")
    .forEach(el => {
        if (el.id === "f-name" || el.id === "f-author") return;
        el.addEventListener("input", onDesignEdit);
        el.addEventListener("change", onDesignEdit);
    });
sourceEl.addEventListener("input", onSourceEdit);

$("banner-dismiss")?.addEventListener?.("click", () => {
    $("env-banner").style.display = "none";
});

(function init() {
    if (location.protocol === "file:") {
        $("env-banner").style.display = "block";
    }
    boot();
    // Boot straight into an editable three-phase scope: three moving traces,
    // 120° apart (spec §11). Everything is a normal, editable scene.
    workingRaw = {
        amo: 1,
        meta: { name: "my scene", author: "" },
        display: {
            gamma: 1.7, spill: 0.4,
            brightness: { active: 1, inactive: 0.035 },
            bloom: { intensity: 0.3, threshold: 0.42, radius: 14 }
        },
        quality: { fps: 30 },
        timeline: { duration: 8, loop: true },
        scene: blankScopeScene()
    };
    selected = { kind: "scene", index: -1 };
    hydrateDesign(workingRaw);
    renderLayers();
    renderLayerEditor();
    renderParams();
    renderTraceWorkspace(true);
    updateScopeOverlay();
    syncSourceFromWorking();
    initPresets();
    loadToPlayer().then(() => {
        playing = true;
        $("btn-play").innerHTML = "&#10074;&#10074;";
        if (player) player.play();
    });
    initGallery();
})();

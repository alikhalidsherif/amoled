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
    FUNCTION_NAMES, VARIABLE_NAMES, CONSTANT_NAMES
} from "../src/scene/expression.js";
import { rasterize } from "../src/scene/rasterizer.js";
import AMOLEDPlayer from "../src/player/amoplayer.js";

const GPUPentileSimulator = window.AMOLED.GPUPentileSimulator;

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

function exprVocabulary() {
    const params = Object.keys(workingRaw?.parameters || {});
    return [
        ...VARIABLE_NAMES.map(n => ({ name: n, meta: "variable", cls: "tok-var" })),
        ...CONSTANT_NAMES.map(n => ({ name: n, meta: "constant", cls: "tok-const" })),
        ...params.map(n => ({ name: n, meta: "parameter", cls: "tok-param" })),
        ...FUNCTION_NAMES.map(n => ({ name: n, meta: "function", cls: "tok-fn" }))
    ];
}

const HL_TOKEN_RE = /(\d+\.?\d*(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/%^<>?:(),])|(\s+)|(.)/g;

function highlightExpr(src) {
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
            else if (BASE_VAR_SET.has(word)) cls = "tok-var";
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
 */
function attachExprEditor(textarea) {
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

    function refreshHighlight() {
        hl.innerHTML = highlightExpr(textarea.value) + "\n";
        hl.scrollTop = textarea.scrollTop;
    }

    function validate() {
        errEl.textContent = "";
        textarea.style.borderColor = "";
        const v = textarea.value.trim();
        if (!v) return;
        try {
            compileExpression(v, new Set(Object.keys(workingRaw?.parameters || {})));
        } catch (e) {
            if (e instanceof AmoExprError || e.name === "AmoExprError") {
                errEl.textContent = e.message;
                textarea.style.borderColor = "var(--err)";
            }
            // non-syntax errors (e.g. arity) also come through as AmoExprError
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
        acItems = exprVocabulary()
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
    "shape", "conicGradient", "waves",
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
    image: [{ key: "__assetUrl", label: "Image URL", kind: "asset", def: "../assets/test-portrait.gif" },
            { key: "fit", label: "Fit", kind: "select", options: ["cover", "contain", "stretch"], def: "cover" }],
    gif: [{ key: "__assetUrl", label: "GIF URL", kind: "asset", def: "../assets/test-portrait.gif" },
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

function syncSourceFromWorking() {
    suppressSourceSync = true;
    sourceEl.value = JSON.stringify(workingRaw, null, 2);
    suppressSourceSync = false;
    sourceEl.classList.remove("invalid");
}

async function loadToPlayer() {
    if (!player || !workingRaw) return null;
    try {
        const parsed = parseAmo(JSON.parse(JSON.stringify(workingRaw)), location.href);
        await player.load(parsed.definition);
        if (playing) player.play();
        updateTransport();
        renderLayers();      // reflect adopted state
        setInspectDefinition(parsed.definition);
        return parsed;
    } catch (e) {
        setStatus("load failed: " + e.message, "err");
        return null;
    }
}

function onSourceEdit() {
    if (suppressSourceSync) return;
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
            clampSelection();
            hydrateAll();
            await loadToPlayer();
            setStatus(`valid ✓${parsed.warnings.length ? "\nwarnings:\n - " + parsed.warnings.join("\n - ") : ""}`,
                parsed.warnings.length ? "warn" : "ok");
        } catch (e) {
            lastErrorPath = e.path || "";
            setStatus((e.name === "AmoError" ? "" : (e.stack || "")) + e.message, "err");
            highlightError();
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
        default: break;
    }
    return bits.join(" · ");
}

function renderLayers() {
    const host = $("layer-list");
    host.innerHTML = "";
    if (!workingRaw) return;

    const frags = isComposite()
        ? workingRaw.scene.layers.map((l, i) => ({ frag: l, i }))
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
            `<span class="l-order">${isComposite() ? (i + 1) : "•"}</span>` +
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
    } else {
        const order = document.createElement("div");
        order.className = "hint";
        order.textContent = "Order: bottom → top. Tap to edit.";
        host.appendChild(order);
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
        workingRaw.scene.layers.push(frag);
        selected = { kind: "layer", index: workingRaw.scene.layers.length - 1 };
        afterStructureChange();
        switchTab("layers");
    });
});

$("btn-dup-layer").addEventListener("click", () => {
    if (!isComposite()) return;
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

$("btn-up").addEventListener("click", () => moveLayer(-1));
$("btn-down").addEventListener("click", () => moveLayer(1));
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
    syncSourceFromWorking();
    loadToPlayer();
}

// ------------------------------------------------------------------
// Field editors
// ------------------------------------------------------------------
function buildSceneForType(type) {
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
    title.textContent = `Edit ${type}${isComposite() ? ` · layer ${selected.index + 1}` : ""}`;
    host.appendChild(title);

    const wrap = document.createElement("div");

    for (const f of TYPE_FIELDS[type] || []) {
        if (f.when && !f.when(frag)) continue;
        wrap.appendChild(renderField(f, frag));
    }

    // Cheat-sheet whenever math is involved.
    if (["expression", "curve", "shape", "waves", "conicGradient"].includes(type)) {
        host.appendChild(buildCheatSheet());
    }

    // Transform/blending panel for composite layers.
    if (isComposite()) {
        const th = document.createElement("h2");
        th.textContent = "Transform & blending";
        host.appendChild(wrap);
        host.appendChild(th);
        const tw = document.createElement("div");
        for (const f of TRANSFORM_FIELDS) tw.appendChild(renderField(f, frag));
        const offRow = document.createElement("div");
        offRow.className = "row";
        offRow.appendChild(offsetField(frag, "x"));
        offRow.appendChild(offsetField(frag, "y"));
        tw.appendChild(offRow);
        host.appendChild(tw);
    } else {
        host.appendChild(wrap);
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
            input = document.createElement("input");
            input.type = "color";
            input.value = toHex(frag[f.key]) || f.def;
            if (typeof frag[f.key] === "string" && frag[f.key][0] !== "#") input.disabled = true;
            input.addEventListener("input", () => {
                frag[f.key] = input.value;
                commitEdits();
            });
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
            label.innerHTML = `${f.label} <span class="expr-badge">expression</span>`;
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
        syncSourceFromWorking();
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
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:50;" +
        "display:flex;align-items:center;justify-content:center;padding:16px;";
    const card = document.createElement("div");
    card.style.cssText =
        "background:#101010;border:1px solid #2a2a2a;border-radius:8px;" +
        "padding:14px;max-width:420px;width:100%;max-height:80vh;overflow-y:auto;";
    card.innerHTML = `<h2 style="margin-top:0">Add a layer</h2>`;
    for (const t of SCENE_TYPES) {
        const btn = document.createElement("button");
        btn.style.cssText = "display:block;width:100%;text-align:left;margin-top:6px;";
        btn.innerHTML = `<b>${t}</b><br><span style="color:#888;font-size:11px">${TYPE_DESCRIPTIONS[t] || ""}</span>`;
        btn.addEventListener("click", () => { overlay.remove(); onPick(t); });
        card.appendChild(btn);
    }
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "width:100%;margin-top:10px;";
    cancel.addEventListener("click", () => overlay.remove());
    card.appendChild(cancel);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

// ------------------------------------------------------------------
// Tabs
// ------------------------------------------------------------------
document.querySelectorAll("#tabs button").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
    document.querySelectorAll("#tabs button").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tabpane").forEach(p =>
        p.classList.toggle("active", p.dataset.pane === name));
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
    const host = $("param-list");
    host.innerHTML = "";
    const params = workingRaw?.parameters;
    if (!params) return;
    for (const name of Object.keys(params)) {
        host.appendChild(paramRow(name));
    }
}

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

    // Delete.
    const del = document.createElement("button");
    del.className = "secondary pdel";
    del.textContent = "✕";
    del.title = `Delete ${name}`;
    del.addEventListener("click", () => {
        delete workingRaw.parameters[name];
        if (Object.keys(workingRaw.parameters).length === 0) delete workingRaw.parameters;
        renderParams();
        commitEdits();
    });

    row.append(nameEl, slider, valEl, del);
    return row;
}

$("btn-add-param").addEventListener("click", () => {
    if (!workingRaw) return;
    if (!workingRaw.parameters) workingRaw.parameters = {};
    let i = 1;
    while (workingRaw.parameters[`param${i}`] !== undefined) i++;
    workingRaw.parameters[`param${i}`] = { value: 0.5, min: 0, max: 1, step: 0.01 };
    renderParams();
    commitEdits();
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
    const fps = player.runtime?.definition?.quality?.fps || 30;
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
    const host = $("layer-list");

    // file:// mode: fetch() is blocked by the browser — explain instead of
    // silently showing an empty gallery.
    if (location.protocol === "file:") {
        $("env-banner").style.display = "block";
        const note = document.createElement("div");
        note.className = "hint";
        note.textContent =
            "Examples are unavailable over file:// — serve the folder over http to enable them. " +
            "Editing and Export work fine.";
        host.after(note);
        return;
    }

    const galTitle = document.createElement("h2");
    galTitle.textContent = "Examples — tap to load";
    galTitle.id = "gallery-title";
    host.after(galTitle);
    const gal = document.createElement("div");
    gal.className = "layer-actions";
    gal.id = "gallery";
    galTitle.after(gal);

    for (const name of GALLERY) {
        try {
            const res = await fetch(`../scenes/${name}.amo`, { method: "HEAD" });
            if (!res.ok) continue;
        } catch { continue; }
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.textContent = GALLERY_LABELS[name] || name;
        btn.addEventListener("click", async () => {
            try {
                const res = await fetch(`../scenes/${name}.amo`);
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
    workingRaw = {
        amo: 1,
        meta: { name: "my scene", author: "" },
        display: {
            gamma: 1.7, spill: 0.4,
            brightness: { active: 1, inactive: 0.035 },
            bloom: { intensity: 0.3, threshold: 0.42, radius: 14 }
        },
        quality: { fps: 30 },
        timeline: { duration: 20, loop: true },
        scene: { type: "composite", layers: [
            { type: "flow", palette: ["#010803", "#07230f", "#12471f", "#2f8f4a"],
              scale: 3, speed: 0.08, warp: 0.6, octaves: 3, seed: 4 },
            { type: "particles", behavior: "fireflies", count: 60, seed: 99,
              color: "#c8ffb0", glow: 0.85, speed: 0.15, blend: "add" }
        ] }
    };
    selected = { kind: "layer", index: 1 };
    hydrateDesign(workingRaw);
    renderLayers();
    renderLayerEditor();
    renderParams();
    syncSourceFromWorking();
    initPresets();
    loadToPlayer().then(() => {
        playing = true;
        $("btn-play").innerHTML = "&#10074;&#10074;";
        if (player) player.play();
    });
    initGallery();
})();

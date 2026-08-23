// .amo STUDIO (PLAN-CREATIVE.md §Workstream D): hybrid editor.
// Left: form controls → write into workingRaw. Right: live .amo source
// textarea → parse on edit; valid edits replace workingRaw + hydrate form.
// Center: real player + engine preview with scrubber. Gallery loads the
// committed scenes. Presets expand to plain expressions via src/scene/presets.
//
// Single-writer rule: form edits regenerate the whole source text from
// workingRaw; source edits replace workingRaw wholesale when valid.

import { parseAmo } from "../src/scene/parser.js";
import { applyPreset, listPresets } from "../src/scene/presets.js";
import AMOLEDPlayer from "../src/player/amoplayer.js";

const GPUPentileSimulator = window.AMOLED.GPUPentileSimulator;

const $ = id => document.getElementById(id);
const statusEl = $("status");
const sourceEl = $("source");

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || "";
}

// ------------------------------------------------------------------
// Renderer + player
// ------------------------------------------------------------------
const sim = new GPUPentileSimulator({
    containerSelector: "#shell",
    canvasSelector: "#preview-canvas"
});
let player = null;
let playing = false;
let scrubbing = false;

window.__gsim = sim;
window.__gplayerRef = () => player;
window.__gworking = () => workingRaw;
window.__geditCount = 0;
window.__gsuppressed = () => suppressSourceSync;

function boot() {
    player = new AMOLEDPlayer({
        renderer: sim,
        events: {
            onerror: err => setStatus("error: " + err.message, "err"),
            onload: info => {
                const warns = info.warnings && info.warnings.length
                    ? "\nwarnings:\n - " + info.warnings.join("\n - ") : "";
                setStatus(`loaded "${info.name}" (${info.isStatic ? "static" : "animated"})${warns}`,
                    info.isStatic ? "ok" : "warn");
                updateTransport();
            }
        }
    });
}

// ------------------------------------------------------------------
// Working state
// ------------------------------------------------------------------
let workingRaw = null;      // authoritative raw object
let suppressSourceSync = false;

function defaultScene() {
    return {
        amo: 1,
        meta: { name: "my scene", author: "" },
        display: {
            gamma: 1.7, spill: 0.4,
            brightness: { active: 1, inactive: 0.035 },
            bloom: { intensity: 0.25, threshold: 0.45, radius: 14 }
        },
        quality: { fps: 30 },
        timeline: { duration: 8, loop: true },
        scene: {
            type: "livingGradient",
            direction: "vertical",
            stops: [
                { at: 0, color: "#001208" },
                { at: 0.55, color: "#175c2e" },
                { at: 1, color: "#2a5c34" }
            ],
            wobble: "0.05*sin(t*0.4)"
        }
    };
}

// ------------------------------------------------------------------
// Source pane <-> workingRaw
// ------------------------------------------------------------------
let reparseTimer = null;

function syncSourceFromWorking() {
    suppressSourceSync = true;
    sourceEl.value = JSON.stringify(workingRaw, null, 2);
    suppressSourceSync = false;
}

function onSourceEdit() {
    window.__geditCount++;
    if (suppressSourceSync) return;
    clearTimeout(reparseTimer);
    reparseTimer = setTimeout(() => {
        let raw;
        try {
            raw = JSON.parse(sourceEl.value);
        } catch (e) {
            setStatus("invalid JSON: " + e.message, "err");
            return;
        }
        try {
            const parsed = parseAmo(raw);   // validate before adopting
            workingRaw = raw;
            hydrateForm(raw);
            loadToPlayer();
            setStatus(`valid ✓${parsed.warnings.length ? "\nwarnings:\n - " + parsed.warnings.join("\n - ") : ""}`,
                parsed.warnings.length ? "warn" : "ok");
        } catch (e) {
            setStatus((e.name === "AmoError" ? "" : (e.stack || "")) + e.message, "err");
        }
    }, 250);
}

async function loadToPlayer() {
    if (!player || !workingRaw) return null;
    try {
        const parsed = parseAmo(JSON.parse(JSON.stringify(workingRaw)));
        await player.load(parsed.definition);
        if (playing) player.play();
        updateTransport();
        return parsed;
    } catch (e) {
        setStatus("load failed: " + e.message, "err");
        return null;
    }
}

function rebuildFromForm() {
    // Form is authoritative for meta/display/quality/timeline sections and
    // basic scene fields; everything else in workingRaw is preserved.
    workingRaw.meta = { name: val("f-name"), author: val("f-author") };
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
    if (workingRaw.display.emitters === undefined && workingRaw.display.emitters !== undefined) {} // no-op guard
    const q = {};
    q.fps = num("f-fps", 30);
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

    // Scene type switch resets scene unless same type.
    const typeSel = $("f-type").value;
    if (!workingRaw.scene || workingRaw.scene.type !== typeSel) {
        workingRaw.scene = buildSceneForType(typeSel);
        renderSceneFields();
    } else {
        collectSceneFieldsInto(workingRaw.scene);
    }

    syncSourceFromWorking();
    loadToPlayer();
}

function keepKnown(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
}

// ------------------------------------------------------------------
// Scene type fields
// ------------------------------------------------------------------
const SCENE_TYPES = [
    "color", "gradient", "livingGradient", "pattern", "flow", "particles",
    "expression", "image", "gif", "video", "composite"
];

const FIELD_DEFS = {
    color: [{ key: "color", label: "Color", kind: "color", def: "#06120a" }],
    gradient: [
        { key: "__from", label: "From (hex or {r,g,b})", kind: "text", def: "#001a08" },
        { key: "__to", label: "To", kind: "text", def: "#123f20" },
        { key: "direction", label: "Direction", kind: "select", options: ["vertical", "horizontal", "diagonal", "radial"], def: "vertical" }
    ],
    livingGradient: [
        { key: "direction", label: "Direction", kind: "select", options: ["vertical", "horizontal", "diagonal", "radial"], def: "vertical" },
        { key: "wobble", label: "Wobble (expr)", kind: "text", def: "0.05*sin(t*0.4)" },
        { key: "__stops", label: "Stops JSON [{at,color}]", kind: "textarea", def: "[{\"at\":0,\"color\":\"#001208\"},{\"at\":1,\"color\":\"#2a5c34\"}]" }
    ],
    pattern: [
        { key: "pattern", label: "Variant", kind: "select", options: ["dots", "checks", "stripes", "scanlines", "halftone"], def: "dots" },
        { key: "size", label: "Size (px or expr)", kind: "text", def: "10" },
        { key: "thickness", label: "Thickness (0-1)", kind: "text", def: "0.6" },
        { key: "fg", label: "FG", kind: "color", def: "#39ff6a" },
        { key: "bg", label: "BG", kind: "color", def: "#041008" },
        { key: "softness", label: "Softness", kind: "text", def: "0.1" },
        { key: "angle", label: "Angle (rad or expr)", kind: "text", def: "0" }
    ],
    flow: [
        { key: "__palette", label: "Palette JSON [hex...]", kind: "textarea", def: "[\"#020d06\",\"#0a2e18\",\"#175c2e\",\"#79c98a\"]" },
        { key: "scale", label: "Scale", kind: "text", def: "3.5" },
        { key: "speed", label: "Speed", kind: "text", def: "0.12" },
        { key: "warp", label: "Warp 0-2", kind: "text", def: "0.5" },
        { key: "octaves", label: "Octaves 1-5", kind: "number", def: 3 },
        { key: "seed", label: "Seed", kind: "number", def: 7 }
    ],
    particles: [
        { key: "behavior", label: "Behavior", kind: "select", options: ["drift", "orbit", "rise", "fall", "fireflies", "snow"], def: "fireflies" },
        { key: "count", label: "Count (≤512)", kind: "number", def: 80 },
        { key: "speed", label: "Speed", kind: "text", def: "0.2" },
        { key: "glow", label: "Glow 0-1", kind: "text", def: "0.7" },
        { key: "color", label: "Color", kind: "color", def: "#c8ffb0" },
        { key: "seed", label: "Seed", kind: "number", def: 42 }
    ],
    expression: [
        { key: "r", label: "R expression", kind: "textarea", def: "0.5 + 0.5*sin(x*8 + t*2)" },
        { key: "g", label: "G expression", kind: "textarea", def: "0.5 + 0.45*sin(y*6 - t*1.5)" },
        { key: "b", label: "B expression", kind: "textarea", def: "0.35 + 0.35*noise(u*6 + t*0.4, v*6)" },
        { key: "seed", label: "Seed", kind: "number", def: 7 }
    ],
    image: [
        { key: "__assetUrl", label: "Asset URL (relative)", kind: "text", def: "../assets/test-portrait.gif" },
        { key: "fit", label: "Fit", kind: "select", options: ["cover", "contain", "stretch"], def: "cover" }
    ],
    gif: [
        { key: "__assetUrl", label: "Asset URL (relative)", kind: "text", def: "../assets/test-portrait.gif" },
        { key: "fit", label: "Fit", kind: "select", options: ["cover", "contain", "stretch"], def: "cover" }
    ],
    video: [
        { key: "__assetUrl", label: "Asset URL (relative)", kind: "text", def: "../assets/clip.webm" }
    ],
    composite: []
};

function buildSceneForType(type) {
    const scene = { type };
    for (const f of FIELD_DEFS[type] || []) {
        if (f.key.startsWith("__")) continue;
        scene[f.key] = f.kind === "number" ? Number(f.def) : f.def;
    }
    applySpecialConstructors(scene);
    return scene;
}

/** Turn __-prefixed field values into structured scene properties. */
function applySpecialConstructors(scene) {
    if (scene.__from !== undefined) {
        try { scene.from = JSON.parse(scene.__from); } catch { scene.from = scene.__from; }
        delete scene.__from;
    }
    if (scene.__to !== undefined) {
        try { scene.to = JSON.parse(scene.__to); } catch { scene.to = scene.__to; }
        delete scene.__to;
    }
    if (scene.__stops !== undefined) {
        try { scene.stops = JSON.parse(scene.__stops); } catch { /* keep invalid; validator reports */ scene.stops = scene.__stops; }
        delete scene.__stops;
    }
    if (scene.__palette !== undefined) {
        try { scene.palette = JSON.parse(scene.__palette); } catch { scene.palette = scene.__palette; }
        delete scene.__palette;
    }
    if (scene.__assetUrl !== undefined) {
        scene.asset = "media";
        workingRaw.assets = { ...(workingRaw.assets || {}), media: scene.__assetUrl };
        delete scene.__assetUrl;
    }
}

function renderSceneFields() {
    const type = $("f-type").value;
    const host = $("scene-fields");
    host.innerHTML = "";
    const existing = workingRaw.scene || {};
    for (const f of FIELD_DEFS[type] || []) {
        const label = document.createElement("label");
        label.append(f.label + " ");
        let input;
        if (f.kind === "textarea") input = document.createElement("textarea");
        else if (f.kind === "select") {
            input = document.createElement("select");
            for (const o of f.options) {
                const opt = document.createElement("option");
                opt.value = o; opt.textContent = o;
                input.appendChild(opt);
            }
            input.value = f.def;
        } else {
            input = document.createElement("input");
            input.type = f.kind === "color" ? "color" : f.kind === "number" ? "number" : "text";
            input.step = "any";
            if (f.kind !== "color") input.value = f.def;
        }
        // Hydrate from existing scene object where present.
        let cur = existing[f.key];
        if (f.key === "__stops") {
            cur = existing.stops ? JSON.stringify(existing.stops) : f.def;
            input.value = cur ?? f.def;
        } else if (f.key === "__palette") {
            cur = existing.palette ? JSON.stringify(existing.palette) : f.def;
            input.value = cur ?? f.def;
        } else if (f.key === "__from") {
            cur = existing.from !== undefined ? (typeof existing.from === "string" ? existing.from : JSON.stringify(existing.from)) : f.def;
            input.value = cur;
        } else if (f.key === "__to") {
            cur = existing.to !== undefined ? (typeof existing.to === "string" ? existing.to : JSON.stringify(existing.to)) : f.def;
            input.value = cur;
        } else if (f.key === "__assetUrl") {
            const assetName = existing.asset;
            cur = assetName && workingRaw.assets ? workingRaw.assets[assetName] : f.def;
            input.value = cur ?? f.def;
        } else if (existing[f.key] !== undefined && f.kind !== "select") {
            input.value = String(existing[f.key]);
        }
        input.dataset.fieldKey = f.key;
        input.dataset.kind = f.kind;
        label.appendChild(input);
        host.appendChild(label);
    }
    if (type === "composite") {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "Composites are authored in the source pane →";
        host.appendChild(hint);
    }
}

/** Write form scene-field values back into workingRaw.scene (in place). */
function collectSceneFieldsInto(scene) {
    Object.keys(scene).forEach(k => {
        if ((FIELD_DEFS[scene.type] || []).some(f => f.key === k)) delete scene[k];
    });
    for (const el of $("scene-fields").querySelectorAll("[data-field-key]")) {
        const key = el.dataset.fieldKey;
        let v = el.value;
        if (el.dataset.kind === "number") v = Number(v);
        scene[key] = v;
    }
    applySpecialConstructors(scene);
}

// ------------------------------------------------------------------
// Form hydration from workingRaw
// ------------------------------------------------------------------
function hydrateForm(raw) {
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
    const s = raw.scene;
    if (s && SCENE_TYPES.includes(s.type)) {
        $("f-type").value = s.type;
        renderSceneFields();
    }
}

// ------------------------------------------------------------------
// Transport / scrubber
// ------------------------------------------------------------------
function updateTransport() {
    const dur = player ? player.getDuration() : 0;
    const scrubber = $("scrubber");
    scrubber.max = String(Math.max(1, dur));
    updateTLabel();
}

function updateTLabel() {
    const t = player ? player.getTime() : 0;
    const dur = player ? player.getDuration() : 0;
    $("t-label").textContent = `${t.toFixed(1)}s / ${dur.toFixed(1)}s`;
    if (!scrubbing) $("scrubber").value = String(Math.min(t, dur));
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
    if (e.code === "Space" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") {
        e.preventDefault();
        $("btn-play").click();
    }
});

// ------------------------------------------------------------------
// Presets
// ------------------------------------------------------------------
function initPresets() {
    const sel = $("preset-select");
    for (const p of listPresets()) {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.textContent = `${p.name} — ${p.description}`;
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
    const target = presetTarget();
    if (!target) return;
    try {
        const patched = applyPreset(target, name, params);
        Object.assign(target, patched);
        syncSourceFromWorking();
        loadToPlayer();
    } catch (e) {
        setStatus("preset failed: " + e.message, "err");
    }
});

/** The fragment a preset should modify: scene itself, or a chosen layer. */
function presetTarget() {
    if (!workingRaw || !workingRaw.scene) return null;
    if (workingRaw.scene.type === "composite" && Array.isArray(workingRaw.scene.layers)) {
        const idx = prompt(`Layer index (0-${workingRaw.scene.layers.length - 1}):`, "0");
        const i = parseInt(idx);
        if (!(i >= 0 && i < workingRaw.scene.layers.length)) return null;
        return workingRaw.scene.layers[i];
    }
    return workingRaw.scene;
}

// ------------------------------------------------------------------
// Gallery
// ------------------------------------------------------------------
const GALLERY = [
    "color", "gradient", "image", "dots", "flowfield", "fireflies",
    "parallax", "plasma", "procedural", "rain", "clip", "composite"
];

async function initGallery() {
    const host = $("gallery");
    for (const name of GALLERY) {
        try {
            const res = await fetch(`../scenes/${name}.amo`, { method: "HEAD" });
            if (!res.ok) continue;
        } catch { continue; }
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.textContent = name;
        btn.addEventListener("click", async () => {
            try {
                const res = await fetch(`../scenes/${name}.amo`);
                const raw = JSON.parse(await res.text());
                workingRaw = raw;
                hydrateForm(raw);
                syncSourceFromWorking();
                loadToPlayer();
            } catch (e) {
                setStatus("gallery load failed: " + e.message, "err");
            }
        });
        host.appendChild(btn);
    }
}

// ------------------------------------------------------------------
// Export / import
// ------------------------------------------------------------------
$("btn-export").addEventListener("click", () => {
    const name = ((workingRaw.meta && workingRaw.meta.name) || "scene")
        .replace(/[^\w-]+/g, "-").toLowerCase();
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
        parseAmo(workingRaw);   // validate
        hydrateForm(workingRaw);
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
function num(id, fallback) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
}
function val(id) { return $(id).value; }

for (const id of ["f-name", "f-author"]) $(id).addEventListener("input", rebuildFromForm);
for (const id of ["f-type"]) $(id).addEventListener("change", rebuildFromForm);
document.querySelectorAll("#form-pane input, #form-pane select, #form-pane textarea")
    .forEach(el => {
        if (["f-name", "f-author", "f-type"].includes(el.id)) return;
        if (el.closest("#scene-fields")) return;
        if (el.closest("#preset-params")) return;
        el.addEventListener("input", rebuildFromForm);
        el.addEventListener("change", rebuildFromForm);
    });
$("scene-fields").addEventListener("input", () => { rebuildFromForm(); });
$("scene-fields").addEventListener("change", () => { rebuildFromForm(); });

sourceEl.addEventListener("input", onSourceEdit);

(function init() {
    // Populate type selector.
    const sel = $("f-type");
    for (const t of SCENE_TYPES) {
        const opt = document.createElement("option");
        opt.value = t; opt.textContent = t;
        sel.appendChild(opt);
    }
    boot();
    workingRaw = defaultScene();
    hydrateForm(workingRaw);
    renderSceneFields();
    syncSourceFromWorking();
    initPresets();
    initGallery();
    loadToPlayer().then(() => {
        playing = true;
        $("btn-play").innerHTML = "&#10074;&#10074;";
        if (player) player.play();
    });
})();

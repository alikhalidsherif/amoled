// .amo scene generator — Stage 1 (PLAN.md §Phase 9): form editor + live
// preview through the REAL player + engine + Export. Shares src/scene/*
// and src/player/* verbatim; the generator never renders by itself.

import { parseAmo, AmoError } from "../src/scene/parser.js";
import AMOLEDPlayer from "../src/player/amoplayer.js";

// Engine constructor comes from the classic-script global (PLAN.md §3.1):
// the generator never imports engine internals.
const GPUPentileSimulator = window.AMOLED.GPUPentileSimulator;

const $ = id => document.getElementById(id);
const statusEl = $("status");

// ------------------------------------------------------------------
// Renderer + player on the preview canvas.
// ------------------------------------------------------------------
const sim = new GPUPentileSimulator({
    containerSelector: "#shell",
    canvasSelector: "#preview-canvas"
});
let player = null;
let currentRaw = null;

// Debug/testing hooks.
window.__gsim = sim;
window.__gplayerRef = () => player;

function boot() {
    player = new AMOLEDPlayer({
        renderer: sim,
        events: {
            onerror: err => setStatus("error: " + err.message, "err"),
            onload: info => {
                const warns = info.warnings && info.warnings.length
                    ? "\nwarnings:\n - " + info.warnings.join("\n - ") : "";
                setStatus(`loaded "${info.name}" (${info.isStatic ? "static" : "animated"})${warns}`, "warn");
            }
        }
    });
}

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || "";
}

// ------------------------------------------------------------------
// Scene field UI: dynamic per type.
// ------------------------------------------------------------------
const FIELD_DEFS = {
    color: [
        { key: "color", label: "Color", kind: "color", def: "#06120a" }
    ],
    gradient: [
        { key: "from", label: "From", kind: "color", def: "#001a08" },
        { key: "to", label: "To", kind: "color", def: "#123f20" },
        { key: "direction", label: "Direction", kind: "select", options: ["vertical", "horizontal", "diagonal", "radial"], def: "vertical" }
    ],
    image: [
        { key: "asset-url", label: "Asset URL (relative)", kind: "text", def: "../assets/sample-gradient.png" },
        { key: "fit", label: "Fit", kind: "select", options: ["cover", "contain", "stretch"], def: "cover" }
    ],
    gif: [
        { key: "asset-url", label: "Asset URL (relative)", kind: "text", def: "../assets/test-portrait.gif" },
        { key: "fit", label: "Fit", kind: "select", options: ["cover", "contain", "stretch"], def: "cover" }
    ],
    video: [
        { key: "asset-url", label: "Asset URL (relative)", kind: "text", def: "../assets/clip.webm" }
    ],
    expression: [
        { key: "r-expr", label: "R expression", kind: "textarea", def: "0.5 + 0.5*sin(x*8 + t*2)" },
        { key: "g-expr", label: "G expression", kind: "textarea", def: "0.5 + 0.45*sin(y*6 - t*1.5)" },
        { key: "b-expr", label: "B expression", kind: "textarea", def: "0.35 + 0.35*noise(x*0.15 + t*0.5, y*0.15)" },
        { key: "seed", label: "Seed", kind: "number", def: 7 }
    ]
};

function renderSceneFields() {
    const type = $("f-type").value;
    const host = $("scene-fields");
    host.innerHTML = "";
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
            if (f.kind === "number") { input.step = "any"; input.value = f.def; }
            else if (f.kind !== "color") input.value = f.def;
        }
        input.dataset.fieldKey = f.key;
        input.dataset.kind = f.kind;
        label.appendChild(input);
        host.appendChild(label);
    }
}

function collectSceneFields() {
    const type = $("f-type").value;
    const out = { type };
    for (const el of $("scene-fields").querySelectorAll("[data-field-key]")) {
        const key = el.dataset.fieldKey.replace("-expr", "");
        let v = el.value;
        if (el.dataset.kind === "number") v = Number(v);
        if (key.endsWith("-url")) {
            out.__assetUrl = v;
            out.asset = "media";
        } else {
            out[key] = v;
        }
    }
    return out;
}

// ------------------------------------------------------------------
// Raw object assembly -> parse -> preview.
// ------------------------------------------------------------------
function num(id, fallback) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
}
function val(id) { return $(id).value; }

function buildRaw() {
    const raw = {
        amo: 1,
        meta: { name: val("f-name"), author: val("f-author") },
        display: {
            gamma: num("f-gamma", 1.7),
            spill: num("f-spill", 0.4),
            brightness: { active: num("f-active", 1), inactive: num("f-inactive", 0.035) },
            bloom: {
                intensity: num("f-bloomI", 0.2),
                threshold: num("f-bloomT", 0.45),
                radius: num("f-bloomR", 16)
            }
        },
        quality: (() => {
            const q = { fps: num("f-fps", 30) };
            const ss = val("f-ss");
            if (ss) q.supersample = Number(ss);
            const lw = parseInt(val("f-lw")), lh = parseInt(val("f-lh"));
            if (lw && lh) q.logicalResolution = { width: lw, height: lh };
            return q;
        })(),
        scene: collectSceneFields()
    };

    // Advanced emitters/pentile only when present in DOM.
    if ($("f-sigR")) {
        raw.display.emitters = {
            maxOutput: { r: num("f-maxR", .7), g: num("f-maxG", 1), b: num("f-maxB", .55) },
            sigma: { r: num("f-sigR", .55), g: num("f-sigG", .35), b: num("f-sigB", .65) }
        };
        raw.display.pentile = {
            rowPitchFactor: num("f-rowPitch", .86),
            blackMatrixRatio: num("f-matrix", .22)
        };
    }

    // Media asset registration.
    if (raw.scene.__assetUrl) {
        raw.assets = { media: raw.scene.__assetUrl };
        delete raw.scene.__assetUrl;
    }
    return raw;
}

let rebuildTimer = null;
function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 250);
}

function rebuild() {
    if (!player) return;
    currentRaw = buildRaw();
    try {
        const parsed = parseAmo(currentRaw);
        // Preview through the real player (pre-parsed definition path).
        player.load(parsed.definition).then(() => player.play());
        setStatus(`valid ✓ ${parsed.warnings.length ? "\nwarnings:\n - " + parsed.warnings.join("\n - ") : ""}`,
            parsed.warnings.length ? "warn" : "");
    } catch (e) {
        setStatus((e.name === "AmoError" ? "" : e.stack || "") + e.message, "err");
    }
}

// ------------------------------------------------------------------
// Export / import.
// ------------------------------------------------------------------
$("btn-export").addEventListener("click", () => {
    if (!currentRaw) rebuild();
    const name = (val("f-name") || "scene").replace(/[^\w-]+/g, "-").toLowerCase();
    const blob = new Blob([JSON.stringify(currentRaw, null, 2)], { type: "application/json" });
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
        const text = await file.text();
        const raw = JSON.parse(text);
        hydrateForm(raw);
        rebuild();
    } catch (err) {
        setStatus("import failed: " + err.message, "err");
    }
    e.target.value = "";
});

/** Best-effort form hydration from an imported raw object. */
function hydrateForm(raw) {
    const setV = (id, v) => { if (v !== undefined && $(id)) $(id).value = v; };
    setV("f-name", raw.meta?.name);
    setV("f-author", raw.meta?.author);
    const d = raw.display || {};
    setV("f-gamma", d.gamma); setV("f-spill", d.spill);
    setV("f-active", d.brightness?.active); setV("f-inactive", d.brightness?.inactive);
    setV("f-bloomI", d.bloom?.intensity); setV("f-bloomT", d.bloom?.threshold); setV("f-bloomR", d.bloom?.radius);
    setV("f-sigR", d.emitters?.sigma?.r); setV("f-sigG", d.emitters?.sigma?.g); setV("f-sigB", d.emitters?.sigma?.b);
    setV("f-maxR", d.emitters?.maxOutput?.r); setV("f-maxG", d.emitters?.maxOutput?.g); setV("f-maxB", d.emitters?.maxOutput?.b);
    setV("f-rowPitch", d.pentile?.rowPitchFactor); setV("f-matrix", d.pentile?.blackMatrixRatio);
    const q = raw.quality || {};
    setV("f-fps", q.fps ?? 30); setV("f-ss", q.supersample ?? "");
    setV("f-lw", q.logicalResolution?.width); setV("f-lh", q.logicalResolution?.height);
    const s = raw.scene || {};
    if (FIELD_DEFS[s.type]) {
        $("f-type").value = s.type;
        renderSceneFields();
        for (const el of $("scene-fields").querySelectorAll("[data-field-key]")) {
            const k = el.dataset.fieldKey;
            if (k.endsWith("-url")) continue;
            if (k.endsWith("-expr")) { el.value = s[k] ?? el.value; continue; }
            if (s[k] !== undefined) el.value = s[k];
        }
        const assetName = s.asset;
        if (assetName && raw.assets && raw.assets[assetName]) {
            const urlInput = $("scene-fields").querySelector('[data-field-key$="-url"]');
            if (urlInput) urlInput.value = raw.assets[assetName];
        }
    }
}

// ------------------------------------------------------------------
// Wire-up.
// ------------------------------------------------------------------
for (const id of ["f-name", "f-author"]) $(id).addEventListener("input", scheduleRebuild);
for (const id of ["f-type"]) $(id).addEventListener("change", () => { renderSceneFields(); scheduleRebuild(); });
document.querySelectorAll("#form-pane input, #form-pane select, #form-pane textarea")
    .forEach(el => {
        if (["f-name", "f-author", "f-type"].includes(el.id)) return;
        if (!el.closest("#scene-fields")) {
            el.addEventListener("input", scheduleRebuild);
            el.addEventListener("change", scheduleRebuild);
        }
    });
// Scene-field inputs are dynamic: delegate.
$("scene-fields").addEventListener("input", scheduleRebuild);
$("scene-fields").addEventListener("change", scheduleRebuild);

renderSceneFields();
boot();
scheduleRebuild();

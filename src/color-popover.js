// Color popover: SV square + hue strip + hex field + preset row + the
// native system picker as a fallback. Used by trace/background swatches and
// Advanced layer color fields so every color in the studio is edited the
// same way. One panel instance is shared; opening another closes the first.
//
//   AMOLED.attachColorPopover(trigger, {
//       get: () => "#rrggbb",      // current color (any hex; normalized here)
//       set: (hex) => { ... },     // called on every live change
//       disabled: () => false      // optional; blocks opening when true
//   });
{
    const AMOLED = window.AMOLED || (window.AMOLED = {});
    if (AMOLED.attachColorPopover) {
        // already installed
    } else {

    const PRESETS = [
        "#ff0000", "#ffb454", "#ffd166", "#00ff00", "#7fe0b0", "#4fd6e0",
        "#0000ff", "#b48cff", "#ff8ac2", "#ffffff"
    ];
    const PANEL_W = 236;

    // ---------- color math ----------
    function parseHex(text) {
        if (typeof text !== "string") return null;
        const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
        if (!m) return null;
        let h = m[1].toLowerCase();
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return "#" + h;
    }
    function hexToRgb(hex) {
        const h = parseHex(hex) || "#000000";
        return [
            parseInt(h.slice(1, 3), 16),
            parseInt(h.slice(3, 5), 16),
            parseInt(h.slice(5, 7), 16)
        ];
    }
    function rgbToHex(r, g, b) {
        const c = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
        return "#" + c(r) + c(g) + c(b);
    }
    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0;
        if (d > 0) {
            if (max === r) h = 60 * (((g - b) / d) % 6);
            else if (max === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
        }
        if (h < 0) h += 360;
        return [h, max === 0 ? 0 : d / max, max];
    }
    function hsvToRgb(h, s, v) {
        h = ((h % 360) + 360) % 360;
        const c = v * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 60) [r, g, b] = [c, x, 0];
        else if (h < 120) [r, g, b] = [x, c, 0];
        else if (h < 180) [r, g, b] = [0, c, x];
        else if (h < 240) [r, g, b] = [0, x, c];
        else if (h < 300) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];
        return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
    }
    function hsvToHex(h, s, v) {
        const [r, g, b] = hsvToRgb(h, s, v);
        return rgbToHex(r, g, b);
    }

    // ---------- shared panel ----------
    const panel = document.createElement("div");
    panel.className = "cp-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Color");

    const svBox = document.createElement("div");
    svBox.className = "cp-sv";
    const svCanvas = document.createElement("canvas");
    const svHandle = document.createElement("div");
    svHandle.className = "cp-sv-handle";
    svBox.append(svCanvas, svHandle);

    const hueBox = document.createElement("div");
    hueBox.className = "cp-hue";
    const hueCanvas = document.createElement("canvas");
    const hueHandle = document.createElement("div");
    hueHandle.className = "cp-hue-handle";
    hueBox.append(hueCanvas, hueHandle);

    const row = document.createElement("div");
    row.className = "cp-row";
    const hexInput = document.createElement("input");
    hexInput.className = "cp-hex";
    hexInput.spellcheck = false;
    hexInput.type = "text";
    hexInput.setAttribute("aria-label", "Hex color");
    hexInput.placeholder = "#rrggbb";
    const native = document.createElement("input");
    native.className = "cp-native";
    native.type = "color";
    native.title = "System color picker";
    row.append(hexInput, native);

    const presetRow = document.createElement("div");
    presetRow.className = "cp-presets";
    for (const hex of PRESETS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cp-preset";
        b.style.background = hex;
        b.title = hex;
        b.addEventListener("click", () => applyHex(hex, { fromHexField: false }));
        presetRow.appendChild(b);
    }

    panel.append(svBox, hueBox, row, presetRow);
    document.body.appendChild(panel);

    let current = null;      // { trigger, opts, h, s, v }
    let outsideDown = null;
    let onKey = null;

    function draw() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const svW = svBox.clientWidth || 216, svH = svBox.clientHeight || 130;
        if (svCanvas.width !== svW * dpr) {
            svCanvas.width = svW * dpr; svCanvas.height = svH * dpr;
            hueCanvas.width = hueBox.clientWidth * dpr;
            hueCanvas.height = hueBox.clientHeight * dpr;
        }
        const ctx = svCanvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = hsvToHex(current.h, 1, 1);
        ctx.fillRect(0, 0, svW, svH);
        const white = ctx.createLinearGradient(0, 0, svW, 0);
        white.addColorStop(0, "rgba(255,255,255,1)");
        white.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = white;
        ctx.fillRect(0, 0, svW, svH);
        const black = ctx.createLinearGradient(0, 0, 0, svH);
        black.addColorStop(0, "rgba(0,0,0,0)");
        black.addColorStop(1, "rgba(0,0,0,1)");
        ctx.fillStyle = black;
        ctx.fillRect(0, 0, svW, svH);

        const hctx = hueCanvas.getContext("2d");
        hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const hw = hueBox.clientWidth, hh = hueBox.clientHeight;
        const grad = hctx.createLinearGradient(0, 0, hw, 0);
        for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 100%, 50%)`);
        hctx.fillStyle = grad;
        hctx.fillRect(0, 0, hw, hh);
    }

    function syncHandles() {
        svHandle.style.left = (current.s * 100) + "%";
        svHandle.style.top = ((1 - current.v) * 100) + "%";
        hueHandle.style.left = (current.h / 360 * 100) + "%";
    }

    function applyHex(hex, { fromHexField = false } = {}) {
        const norm = parseHex(hex);
        if (!norm) return false;
        const [r, g, b] = hexToRgb(norm);
        const [h, s, v] = rgbToHsv(r, g, b);
        current.h = h; current.s = s; current.v = v;
        draw();
        syncHandles();
        if (!fromHexField) hexInput.value = norm;
        hexInput.classList.remove("cp-invalid");
        native.value = norm;
        current.trigger.style.background = norm;
        current.opts.set(norm);
        return true;
    }

    function applyHsv() {
        applyHexInternal(hsvToHex(current.h, current.s, current.v));
    }
    function applyHexInternal(norm) {
        hexInput.value = norm;
        hexInput.classList.remove("cp-invalid");
        native.value = norm;
        current.trigger.style.background = norm;
        current.opts.set(norm);
        draw();
        syncHandles();
    }

    // --- SV square drag ---
    function svFromEvent(e) {
        const r = svBox.getBoundingClientRect();
        current.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        current.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
        applyHsv();
    }
    svBox.addEventListener("pointerdown", e => {
        if (!current) return;
        e.preventDefault();
        svBox.setPointerCapture(e.pointerId);
        svFromEvent(e);
    });
    svBox.addEventListener("pointermove", e => {
        if (!current || !svBox.hasPointerCapture(e.pointerId)) return;
        svFromEvent(e);
    });

    // --- hue strip drag ---
    function hueFromEvent(e) {
        const r = hueBox.getBoundingClientRect();
        current.h = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 360;
        applyHsv();
    }
    hueBox.addEventListener("pointerdown", e => {
        if (!current) return;
        e.preventDefault();
        hueBox.setPointerCapture(e.pointerId);
        hueFromEvent(e);
    });
    hueBox.addEventListener("pointermove", e => {
        if (!current || !hueBox.hasPointerCapture(e.pointerId)) return;
        hueFromEvent(e);
    });

    // --- hex field ---
    hexInput.addEventListener("input", () => {
        if (!current) return;
        const norm = parseHex(hexInput.value);
        if (norm) {
            const [r, g, b] = hexToRgb(norm);
            const [h, s, v] = rgbToHsv(r, g, b);
            current.h = h; current.s = s; current.v = v;
            hexInput.classList.remove("cp-invalid");
            native.value = norm;
            current.trigger.style.background = norm;
            current.opts.set(norm);
            draw();
            syncHandles();
        } else {
            hexInput.classList.add("cp-invalid");
        }
    });
    hexInput.addEventListener("change", () => {
        if (!current) return;
        if (!parseHex(hexInput.value)) hexInput.value = hsvToHex(current.h, current.s, current.v);
        hexInput.classList.remove("cp-invalid");
        hexInput.blur();
    });
    hexInput.addEventListener("keydown", e => {
        if (e.key === "Enter") hexInput.blur();
    });

    // --- native picker (fallback) ---
    native.addEventListener("input", () => applyHex(native.value));

    // ---------- open / close ----------
    function position(trigger) {
        const r = trigger.getBoundingClientRect();
        const ph = panel.offsetHeight || 250;
        let left = Math.min(Math.max(8, r.left), window.innerWidth - PANEL_W - 8);
        let top = r.bottom + 6;
        if (top + ph > window.innerHeight - 8) {
            top = r.top - ph - 6;
            if (top < 8) top = Math.max(8, window.innerHeight - ph - 8);
        }
        panel.style.left = left + "px";
        panel.style.top = top + "px";
    }

    function close() {
        if (!current) return;
        panel.hidden = true;
        document.removeEventListener("pointerdown", outsideDown, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", close, true);
        window.removeEventListener("resize", close);
        current = null;
    }

    function open(trigger, opts) {
        if (opts.disabled && opts.disabled()) return;
        close();
        const hex = parseHex(opts.get ? opts.get() : null) || "#000000";
        const [r, g, b] = hexToRgb(hex);
        const [h, s, v] = rgbToHsv(r, g, b);
        current = { trigger, opts, h, s, v };
        panel.hidden = false;
        hexInput.value = hex;
        native.value = hex;
        trigger.style.background = hex;
        draw();
        syncHandles();
        position(trigger);
        outsideDown = e => {
            if (panel.contains(e.target) || trigger.contains(e.target)) return;
            close();
        };
        onKey = e => { if (e.key === "Escape") { close(); trigger.focus?.(); } };
        document.addEventListener("pointerdown", outsideDown, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
    }

    AMOLED.attachColorPopover = function attachColorPopover(trigger, opts) {
        trigger.addEventListener("click", e => {
            e.preventDefault();          // don't fold a <summary> card
            open(trigger, opts);
        });
        if (opts.get) trigger.style.background = parseHex(opts.get()) || "";
        return {
            refresh() {
                const hex = parseHex(opts.get ? opts.get() : null);
                if (hex) trigger.style.background = hex;
            }
        };
    };
    }
}

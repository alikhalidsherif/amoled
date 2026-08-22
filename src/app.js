import { createQualityGovernor } from "./player/quality.js";
import AMOLEDPlayer from "./player/amoplayer.js";

{
    const AMOLED = window.AMOLED || (window.AMOLED = {});

    const AMOLEDRenderer = AMOLED.AMOLEDRenderer;
    const GPUPentileSimulator = AMOLED.GPUPentileSimulator;
    const ClientMediaLoader = AMOLED.ClientMediaLoader;
    const createTestPattern = AMOLED.createTestPattern;

    if (!AMOLEDRenderer || !ClientMediaLoader || !createTestPattern) {
        throw new Error("AMOLED client boot failed: modules are missing.");
    }

    // Coarse device tiering before first render: weak devices get a light
    // configuration up front instead of freezing on the first frame. The
    // runtime governor below refines this from actual measurements.
    function detectLowTier() {
        const nav = navigator;
        const mem = nav.deviceMemory || 8;            // GB, Chromium-only
        const cores = nav.hardwareConcurrency || 8;
        const smallScreen = Math.min(screen.width, screen.height) <= 500;
        return mem <= 2 || cores <= 4 || smallScreen;
    }

    function createSimulator() {
        const lowTier = detectLowTier();
        const options = {
            containerSelector: "#display-shell",
            canvasSelector: "#display",
            maxDevicePixelRatio: lowTier ? 1 : 2
        };
        if (lowTier) {
            options.supersample = 1;
            options.targetLogicalWidth = 240;
            options.targetLogicalHeight = 144;
        }

        // Prefer the GPU physical-emitter pipeline; fall back to the
        // Canvas 2D renderer when WebGL2 is unavailable. A failed GPU
        // attempt leaves a webgl2 context bound to the canvas, so swap in
        // a clean clone before handing it to the 2D renderer.
        if (GPUPentileSimulator && GPUPentileSimulator.isSupported()) {
            try {
                return new GPUPentileSimulator(options);
            } catch (err) {
                console.warn("[amoled] GPU simulator unavailable, using Canvas 2D:", err);
                const old = document.getElementById("display");
                const fresh = old.cloneNode(false);
                old.parentNode.replaceChild(fresh, old);
            }
        }
        return new AMOLEDRenderer(options);
    }

    const sim = createSimulator();

    const loader = new ClientMediaLoader();

    // Keep the media loop's target size in sync with the live grid. Without
    // this, any pitch/supersample/window change leaves the loop feeding
    // frames at a stale size and content renders squeezed into a corner.
    function syncMediaTarget() {
        if (currentMode !== "media") return;
        const stats = sim.getStats();
        loader.resizeTarget(stats.gridCols, stats.gridRows);
    }

    sim.onGridChange = syncMediaTarget;

    const ui = {
        panelToggle: document.getElementById("panel-toggle"),
        panel: document.getElementById("sim-ui"),
        scaleMode: document.getElementById("scale-mode"),
        manualScaleRow: document.getElementById("manual-scale-row"),
        pixelScaleInput: document.getElementById("pixel-scale-input"),
        fpsInput: document.getElementById("fps-input"),
        status: document.getElementById("sim-status"),
        activeBrightness: document.getElementById("active-brightness"),
        activeBrightnessVal: document.getElementById("active-brightness-val"),
        inactiveBrightness: document.getElementById("inactive-brightness"),
        inactiveBrightnessVal: document.getElementById("inactive-brightness-val"),
        bloomSlider: document.getElementById("bloom-slider"),
        bloomSliderVal: document.getElementById("bloom-slider-val"),
        gammaSlider: document.getElementById("gamma-slider"),
        gammaSliderVal: document.getElementById("gamma-slider-val"),
        spillSlider: document.getElementById("spill-slider"),
        spillSliderVal: document.getElementById("spill-slider-val"),
        spreadR: document.getElementById("spread-r"),
        spreadRVal: document.getElementById("spread-r-val"),
        spreadG: document.getElementById("spread-g"),
        spreadGVal: document.getElementById("spread-g-val"),
        spreadB: document.getElementById("spread-b"),
        spreadBVal: document.getElementById("spread-b-val"),
        bloomThreshold: document.getElementById("bloom-threshold"),
        bloomThresholdVal: document.getElementById("bloom-threshold-val"),
        bloomRadius: document.getElementById("bloom-radius"),
        bloomRadiusVal: document.getElementById("bloom-radius-val"),
        supersampleSelect: document.getElementById("supersample-select"),
        uploadArea: document.getElementById("upload-area"),
        fileUploadInput: document.getElementById("file-upload-input"),
        uploadStatus: document.getElementById("upload-status"),
        testPatternBtn: document.getElementById("test-pattern-btn"),
        clearBtn: document.getElementById("clear-btn"),
        mediaInfo: document.getElementById("media-info")
    };

    function getDefaultImage() {
        const isPortrait = window.innerHeight > window.innerWidth;
        return isPortrait ? "assets/test-portrait.gif" : "assets/test-landscape.gif";
    }

    let currentMode = "test-pattern";

    function testRender() {
        currentMode = "test-pattern";
        const w = ENGINE_CONFIG.defaultFrameWidth;
        const h = ENGINE_CONFIG.defaultFrameHeight;
        const data = createTestPattern(w, h);
        sim.loadFrameBuffer(w, h, data);
        updateStatus("test-pattern");
    }

    function loadDefaultImage() {
        const src = getDefaultImage();
        loader.load(src).then(function () {
            currentMode = "media";
            const stats = sim.getStats();
            const frameW = stats.gridCols;
            const frameH = stats.gridRows;
            loader.setFps(Number(ui.fpsInput.value) || 12);
            loader.startLoop(function (frame) {
                if (document.hidden) return; // skip decode/upload while hidden
                sim.loadFrameBuffer(frame.width, frame.height, frame.data);
            }, frameW, frameH);
            updateStatus("media");
        }).catch(function () {
            testRender();
        });
    }

    const ENGINE_CONFIG = AMOLED.DEFAULT_ENGINE_CONFIG;

    // ------------------------------------------------------------------
    // Adaptive quality governor — implementation lives in
    // src/player/quality.js (ES module). Only quality variables are ever
    // touched; artistic/display params are never written (PLAN.md Rule 3).
    // TODO(Phase 8): internals replaced by quality negotiation.
    // ------------------------------------------------------------------
    let perfLabel = "ok";
    let qualityGovernor = null;

    function updateStatus(label) {
        if (!ui.status) return;
        const stats = sim.getStats();
        const activeLevel = Math.round((sim.config.activeLevel || 1) * 100);
        const inactiveLevel = Math.round((sim.config.inactiveLevel || 0.035) * 100);
        const bloomLevel = Math.round((sim.config.bloomIntensity || 0) * 100);
        const gamma = (sim.config.emitterGamma || 1.8).toFixed(1);
        const spillPct = Math.round((sim.config.opticalSpill || 0) * 100);

        let mediaLine = "";
        if (currentMode === "media" && loader._element) {
            const native = loader.getNativeSize();
            mediaLine = "\nmedia: " + native.width + "x" + native.height +
                (loader.isAnimated() ? " (animated)" : " (static)");
        }

        let engineLine = "engine=" + (stats.engine || "canvas2d");
        if (stats.supersample) {
            engineLine += " ss=" + stats.supersample + "x internal=" + stats.internalResolution;
        }

        ui.status.textContent =
            label + " | " +
            stats.viewportWidth + "x" + stats.viewportHeight +
            "  pitch=" + stats.pixelScale +
            "  grid=" + stats.gridCols + "x" + stats.gridRows +
            "\nactive=" + activeLevel + "%  off=" + inactiveLevel + "%  bloom=" + bloomLevel + "%" +
            "\n" + engineLine +
            "  gamma=" + gamma + "  spill=" + spillPct + "%" +
            "  perf=" + perfLabel +
            mediaLine;
    }

    function setScaleMode(mode) {
        if (mode === "manual") {
            ui.manualScaleRow.style.display = "grid";
            const manualPitch = Number(ui.pixelScaleInput.value);
            sim.updateConfig({ autoPixelScale: false, pixelScale: manualPitch });
        } else {
            ui.manualScaleRow.style.display = "none";
            sim.updateConfig({ autoPixelScale: true, pixelScale: null });
        }
        refreshPitchUI();
        updateStatus("scale-change");
    }

    // Reflect the simulator's actual scale state into the controls so
    // programmatic pitch changes (e.g. animated media forcing a coarser
    // pitch) never leave stale values in the UI.
    function refreshPitchUI() {
        if (!ui.scaleMode || !ui.pixelScaleInput) return;
        if (sim.config.autoPixelScale) {
            ui.scaleMode.value = "auto";
            ui.manualScaleRow.style.display = "none";
        } else {
            ui.scaleMode.value = "manual";
            ui.manualScaleRow.style.display = "grid";
            const pitch = Number(sim.config.pixelScale) ||
                sim.getStats().pixelScale;
            ui.pixelScaleInput.value = String(Math.round(pitch * 4) / 4);
        }
    }

    function togglePanel() {
        const isOpen = ui.panel.classList.toggle("open");
        ui.panelToggle.classList.toggle("open", isOpen);
        ui.panelToggle.innerHTML = isOpen ? "&#10005;" : "&#9776;";
    }

    async function handleFileUpload(file) {
        if (!ui.uploadStatus) return;
        ui.uploadStatus.textContent = "loading " + file.name + "...";
        ui.uploadStatus.style.color = "#888";

        try {
            await loader.load(file);
            currentMode = "media";

            // For animated content, use a coarser pitch so rendering stays fast.
            // The getFrame() method handles AR preservation with black padding.
            // The user's scale choice is respected as-is; the adaptive
            // quality governor handles weak devices instead.
            refreshPitchUI();

            const native = loader.getNativeSize();
            const stats = sim.getStats();

            // Frame size = grid size. getFrame() handles letterbox/pillarbox.
            const frameW = stats.gridCols;
            const frameH = stats.gridRows;

            loader.setFps(Number(ui.fpsInput.value) || 12);

            loader.startLoop(function (frame) {
                if (document.hidden) return; // skip decode/upload while hidden
                sim.loadFrameBuffer(frame.width, frame.height, frame.data);
            }, frameW, frameH);

            if (ui.mediaInfo) {
                ui.mediaInfo.textContent = file.name + " (" + native.width + "x" + native.height + ")";
                ui.mediaInfo.style.display = "";
            }

            ui.uploadStatus.textContent = "loaded: " + file.name;
            ui.uploadStatus.style.color = "#8c8";
            updateStatus("media");
        } catch (err) {
            ui.uploadStatus.textContent = "error: " + err.message;
            ui.uploadStatus.style.color = "#c66";
        }
    }

    async function handleUrlLoad(url) {
        if (!ui.uploadStatus) return;
        ui.uploadStatus.textContent = "loading...";
        ui.uploadStatus.style.color = "#888";

        try {
            await loader.load(url);
            currentMode = "media";

            // The user's scale choice is respected as-is; the adaptive
            // quality governor handles weak devices instead.
            refreshPitchUI();

            const native = loader.getNativeSize();
            const stats = sim.getStats();

            const frameW = stats.gridCols;
            const frameH = stats.gridRows;

            loader.setFps(Number(ui.fpsInput.value) || 12);

            loader.startLoop(function (frame) {
                if (document.hidden) return; // skip decode/upload while hidden
                sim.loadFrameBuffer(frame.width, frame.height, frame.data);
            }, frameW, frameH);

            if (ui.mediaInfo) {
                ui.mediaInfo.textContent = url.split("/").pop() + " (" + native.width + "x" + native.height + ")";
                ui.mediaInfo.style.display = "";
            }

            ui.uploadStatus.textContent = "loaded";
            ui.uploadStatus.style.color = "#8c8";
            updateStatus("media");
        } catch (err) {
            ui.uploadStatus.textContent = "error: " + err.message;
            ui.uploadStatus.style.color = "#c66";
        }
    }

    function clearMedia() {
        loader.stop();
        currentMode = "test-pattern";
        if (ui.mediaInfo) ui.mediaInfo.style.display = "none";
        // Restore normal pixel scale
        setScaleMode(ui.scaleMode.value);
        testRender();
    }

    function bindUiEvents() {
        ui.panelToggle.addEventListener("click", togglePanel);

        var headers = document.querySelectorAll(".section-header[data-section]");
        for (var i = 0; i < headers.length; i++) {
            headers[i].addEventListener("click", function () {
                var section = this.dataset.section;
                var body = document.querySelector('.section-body[data-section="' + section + '"]');
                if (body) {
                    this.classList.toggle("collapsed");
                    body.classList.toggle("collapsed");
                }
            });
        }

        ui.scaleMode.addEventListener("change", function () {
            setScaleMode(ui.scaleMode.value);
        });

        ui.pixelScaleInput.addEventListener("change", function () {
            if (ui.scaleMode.value !== "manual") return;
            setScaleMode("manual");
        });

        ui.fpsInput.addEventListener("change", function () {
            const fps = Number(ui.fpsInput.value) || 12;
            loader.setFps(fps);
            updateStatus("fps-change");
        });

        ui.activeBrightness.addEventListener("input", function () {
            const pct = Number(ui.activeBrightness.value);
            sim.updateConfig({ activeLevel: pct / 100 });
            ui.activeBrightnessVal.textContent = pct + "%";
            updateStatus("brightness");
        });

        ui.inactiveBrightness.addEventListener("input", function () {
            const pct = Number(ui.inactiveBrightness.value);
            sim.updateConfig({ inactiveLevel: pct / 100 });
            ui.inactiveBrightnessVal.textContent = pct + "%";
            updateStatus("brightness");
        });

        ui.bloomSlider.addEventListener("input", function () {
            const pct = Number(ui.bloomSlider.value);
            sim.updateConfig({ bloomIntensity: pct / 100 });
            ui.bloomSliderVal.textContent = pct + "%";
            updateStatus("bloom");
        });

        ui.gammaSlider.addEventListener("input", function () {
            const gamma = Number(ui.gammaSlider.value) / 10;
            sim.updateConfig({ emitterGamma: gamma });
            ui.gammaSliderVal.textContent = gamma.toFixed(1);
            updateStatus("emitter-response");
        });

        ui.spillSlider.addEventListener("input", function () {
            const pct = Number(ui.spillSlider.value);
            sim.updateConfig({ opticalSpill: pct / 100 });
            ui.spillSliderVal.textContent = pct + "%";
            updateStatus("optical-spill");
        });

        function bindSpread(input, val, key) {
            input.addEventListener("input", function () {
                const sigma = Number(input.value) / 100;
                sim.updateConfig({ [key]: sigma });
                val.textContent = sigma.toFixed(2);
                updateStatus(key);
            });
        }
        bindSpread(ui.spreadR, ui.spreadRVal, "redSigma");
        bindSpread(ui.spreadG, ui.spreadGVal, "greenSigma");
        bindSpread(ui.spreadB, ui.spreadBVal, "blueSigma");

        ui.bloomThreshold.addEventListener("input", function () {
            const pct = Number(ui.bloomThreshold.value);
            sim.updateConfig({ bloomThreshold: pct / 100 });
            ui.bloomThresholdVal.textContent = pct + "%";
            updateStatus("bloom-threshold");
        });

        ui.bloomRadius.addEventListener("input", function () {
            const r = Number(ui.bloomRadius.value);
            sim.updateConfig({ bloomRadius: r });
            ui.bloomRadiusVal.textContent = r + "px";
            updateStatus("bloom-radius");
        });

        ui.supersampleSelect.addEventListener("change", function () {
            sim.updateConfig({ supersample: Number(ui.supersampleSelect.value) || 1 });
            updateStatus("supersample");
        });

        ui.testPatternBtn.addEventListener("click", function () {
            clearMedia();
        });

        ui.clearBtn.addEventListener("click", function () {
            clearMedia();
        });

        ui.uploadArea.addEventListener("click", function () {
            ui.fileUploadInput.click();
        });

        ui.fileUploadInput.addEventListener("change", function () {
            if (ui.fileUploadInput.files && ui.fileUploadInput.files[0]) {
                handleFileUpload(ui.fileUploadInput.files[0]);
                ui.fileUploadInput.value = "";
            }
        });

        ui.uploadArea.addEventListener("dragover", function (e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.add("dragover");
        });

        ui.uploadArea.addEventListener("dragleave", function (e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("dragover");
        });

        ui.uploadArea.addEventListener("drop", function (e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("dragover");
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleFileUpload(e.dataTransfer.files[0]);
            }
        });

        window.addEventListener("resize", function () {
            syncMediaTarget();
            updateStatus("resize");
        });

        // Reload correct orientation test image on orientation change
        window.addEventListener("orientationchange", function () {
            if (currentMode === "media" && loader._element) {
                const newSrc = getDefaultImage();
                if (loader._blobUrl !== newSrc && !loader._playing) {
                    loader.stop();
                    loadDefaultImage();
                }
            }
        });
    }

    function init() {
        ui.scaleMode.value = "auto";
        ui.pixelScaleInput.value = "8";
        ui.fpsInput.value = "24";
        ui.activeBrightness.value = "100";
        ui.activeBrightnessVal.textContent = "100%";
        ui.inactiveBrightness.value = "4";
        ui.inactiveBrightnessVal.textContent = "4%";
        ui.bloomSlider.value = "0";
        ui.bloomSliderVal.textContent = "0%";
        ui.gammaSlider.value = String(Math.round((sim.config.emitterGamma || 1.8) * 10));
        ui.gammaSliderVal.textContent = (sim.config.emitterGamma || 1.8).toFixed(1);
        ui.spillSlider.value = String(Math.round((sim.config.opticalSpill || 0.05) * 100));
        ui.spillSliderVal.textContent = Math.round((sim.config.opticalSpill || 0.05) * 100) + "%";
        for (const [input, val, key] of [
            [ui.spreadR, ui.spreadRVal, "redSigma"],
            [ui.spreadG, ui.spreadGVal, "greenSigma"],
            [ui.spreadB, ui.spreadBVal, "blueSigma"]
        ]) {
            const sigma = sim.config[key];
            input.value = String(Math.round(sigma * 100));
            val.textContent = sigma.toFixed(2);
        }
        ui.bloomThreshold.value = String(Math.round((sim.config.bloomThreshold || 0.7) * 100));
        ui.bloomThresholdVal.textContent = Math.round((sim.config.bloomThreshold || 0.7) * 100) + "%";
        ui.bloomRadius.value = String(sim.config.bloomRadius || 12);
        ui.bloomRadiusVal.textContent = (sim.config.bloomRadius || 12) + "px";
        if (ui.supersampleSelect) {
            ui.supersampleSelect.value = String(sim.config.supersample || 2);
        }
        if (ui.mediaInfo) ui.mediaInfo.style.display = "none";

        setScaleMode("auto");
        loadDefaultImage();
        bindUiEvents();
        qualityGovernor = createQualityGovernor(sim, {
            getTargetFps: function () {
                return Number(ui.fpsInput.value) || 24;
            },
            isActive: function () {
                return currentMode === "media" && loader.isPlaying();
            },
            onStateChange: function (labelText) {
                perfLabel = labelText;
                if (ui.supersampleSelect) {
                    ui.supersampleSelect.value =
                        String(sim.config.supersample);
                }
                updateStatus("perf");
            }
        });

        // Open panel by default
        togglePanel();
    }

    window.amoledClient = {
        loadFile: handleFileUpload,
        loadUrl: handleUrlLoad,
        loadPattern: testRender,
        clear: clearMedia,
        getStats: function () { return sim.getStats(); },
        resize: function () { sim.resize(); }
    };

    // Debug/testing hook (not part of the public API).
    window.__sim = sim;

    // INVARIANT: exactly ONE owner of the renderer instance. When a scene
    // is requested via ?scene=, the player drives the renderer and the
    // legacy demo media loop never starts.
    const sceneParam = new URLSearchParams(location.search).get("scene");
    if (sceneParam) {
        const player = new AMOLEDPlayer({
            renderer: sim,
            events: {
                onerror: function (err) {
                    console.error("[amoled-player]", err);
                    const el = document.getElementById("sim-status");
                    if (el) el.textContent = "scene error: " + err.message;
                }
            }
        });
        window.__player = player;
        player.load(sceneParam).then(function () { return player.play(); });
        updateStatus("scene:" + sceneParam);
    } else {
        init();
    }
}

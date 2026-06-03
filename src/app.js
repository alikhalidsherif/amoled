(function bootstrapAmoledClient(global) {
    "use strict";

    const AMOLED = global.AMOLED || (global.AMOLED = {});

    const AMOLEDRenderer = AMOLED.AMOLEDRenderer;
    const ClientMediaLoader = AMOLED.ClientMediaLoader;
    const createTestPattern = AMOLED.createTestPattern;

    if (!AMOLEDRenderer || !ClientMediaLoader || !createTestPattern) {
        throw new Error("AMOLED client boot failed: modules are missing.");
    }

    const sim = new AMOLEDRenderer({
        containerSelector: "#display-shell",
        canvasSelector: "#display"
    });

    const loader = new ClientMediaLoader();

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
        uploadArea: document.getElementById("upload-area"),
        fileUploadInput: document.getElementById("file-upload-input"),
        uploadStatus: document.getElementById("upload-status"),
        testPatternBtn: document.getElementById("test-pattern-btn"),
        clearBtn: document.getElementById("clear-btn"),
        mediaInfo: document.getElementById("media-info")
    };

    const DEFAULT_IMAGE = "assets/default-test.png";

    let currentMode = "test-pattern";

    function testRender() {
        const w = ENGINE_CONFIG.defaultFrameWidth;
        const h = ENGINE_CONFIG.defaultFrameHeight;
        const data = createTestPattern(w, h);
        sim.loadFrameBuffer(w, h, data);
        updateStatus("test-pattern");
    }

    function loadDefaultImage() {
        const img = new Image();
        img.onload = function () {
            loader._element = img;
            loader._isAnimated = false;
            loader._isVideo = false;
            currentMode = "media";

            const stats = sim.getStats();
            const frameW = stats.gridCols;
            const frameH = stats.gridRows;
            loader.resizeTarget(frameW, frameH);

            const frame = loader.getFrame(frameW, frameH);
            if (frame) {
                sim.loadFrameBuffer(frame.width, frame.height, frame.data);
            }
            updateStatus("media");
        };
        img.onerror = function () {
            testRender();
        };
        img.src = DEFAULT_IMAGE;
    }

    const ENGINE_CONFIG = AMOLED.DEFAULT_ENGINE_CONFIG;

    function updateStatus(label) {
        if (!ui.status) return;
        const stats = sim.getStats();
        const activeLevel = Math.round((sim.config.activeLevel || 1) * 100);
        const inactiveLevel = Math.round((sim.config.inactiveLevel || 0.035) * 100);
        const bloomLevel = Math.round((sim.config.bloomIntensity || 0) * 100);

        let mediaLine = "";
        if (currentMode === "media" && loader._element) {
            const native = loader.getNativeSize();
            mediaLine = "\nmedia: " + native.width + "x" + native.height +
                (loader.isAnimated() ? " (animated)" : " (static)");
        }

        ui.status.textContent =
            label + " | " +
            stats.viewportWidth + "x" + stats.viewportHeight +
            "  pitch=" + stats.pixelScale +
            "  grid=" + stats.gridCols + "x" + stats.gridRows +
            "\nactive=" + activeLevel + "%  off=" + inactiveLevel + "%  bloom=" + bloomLevel + "%" +
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
        updateStatus("scale-change");
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
            const isAnim = loader.isAnimated();
            if (isAnim) {
                sim.updateConfig({ pixelScale: 8, autoPixelScale: false });
            } else {
                setScaleMode(ui.scaleMode.value);
            }

            const native = loader.getNativeSize();
            const stats = sim.getStats();

            // Frame size = grid size. getFrame() handles letterbox/pillarbox.
            const frameW = stats.gridCols;
            const frameH = stats.gridRows;

            loader.setFps(Number(ui.fpsInput.value) || 12);

            loader.startLoop(function (frame) {
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

            const isAnim = loader.isAnimated();
            if (isAnim) {
                sim.updateConfig({ pixelScale: 8, autoPixelScale: false });
            } else {
                setScaleMode(ui.scaleMode.value);
            }

            const native = loader.getNativeSize();
            const stats = sim.getStats();

            const frameW = stats.gridCols;
            const frameH = stats.gridRows;

            loader.setFps(Number(ui.fpsInput.value) || 12);

            loader.startLoop(function (frame) {
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

        global.addEventListener("resize", function () {
            if (currentMode === "media" && loader._element) {
                const stats = sim.getStats();
                loader.resizeTarget(stats.gridCols, stats.gridRows);
            }
            updateStatus("resize");
        });
    }

    function init() {
        ui.scaleMode.value = "auto";
        ui.pixelScaleInput.value = "8";
        ui.fpsInput.value = "12";
        ui.activeBrightness.value = "100";
        ui.activeBrightnessVal.textContent = "100%";
        ui.inactiveBrightness.value = "4";
        ui.inactiveBrightnessVal.textContent = "4%";
        ui.bloomSlider.value = "0";
        ui.bloomSliderVal.textContent = "0%";
        if (ui.mediaInfo) ui.mediaInfo.style.display = "none";

        setScaleMode("auto");
        loadDefaultImage();
        bindUiEvents();
    }

    global.amoledClient = {
        loadFile: handleFileUpload,
        loadUrl: handleUrlLoad,
        loadPattern: testRender,
        clear: clearMedia,
        getStats: function () { return sim.getStats(); },
        resize: function () { sim.resize(); }
    };

    init();
})(window);

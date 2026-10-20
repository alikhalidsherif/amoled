// Landing page boot (px.ali.et): a live AMOLED simulation behind the hero.
// Frame source is the butterfly attract animation (src/attract.js); falls
// back to the static test pattern if anything is unavailable.
{
    const AMOLED = window.AMOLED || (window.AMOLED = {});

    const GPUPentileSimulator = AMOLED.GPUPentileSimulator;
    const AMOLEDRenderer = AMOLED.AMOLEDRenderer;
    const createButterflyFrame = AMOLED.createButterflyFrame;

    // Device capacity -> pitch (px per subpixel cell), DPR cap, and logical
    // resolution. Low-tier phones get a visibly coarser grid with fewer
    // butterflies; desktops get the fine grid. Supersampling stays at 1x
    // here — the attract loop is ambient, not a specimen render.
    function detectTier() {
        const mem = navigator.deviceMemory || 8;          // Chromium-only
        const cores = navigator.hardwareConcurrency || 8;
        const small = Math.min(screen.width, screen.height) <= 500;
        const coarse = window.devicePixelRatio > 1.5 ? 1 : 0;
        const score = (mem <= 2 ? 2 : mem <= 4 ? 1 : 0) + (cores <= 4 ? 1 : 0) + small + coarse;
        if (score >= 3) return { pitch: 10, dpr: 1, width: 190, butterflies: 5 };
        if (score >= 1) return { pitch: 6, dpr: 1.5, width: 300, butterflies: 8 };
        return { pitch: 4, dpr: 2, width: 380, butterflies: 12 };
    }

    const tier = detectTier();

    function createSimulator() {
        const options = {
            containerSelector: "#display-shell",
            canvasSelector: "#display",
            maxDevicePixelRatio: tier.dpr,
            supersample: 1,
            autoPixelScale: false,
            pixelScale: tier.pitch,
            targetLogicalWidth: tier.width
        };
        if (GPUPentileSimulator && GPUPentileSimulator.isSupported()) {
            try {
                return new GPUPentileSimulator(options);
            } catch (err) {
                console.warn("[landing] GPU simulator unavailable, using Canvas 2D:", err);
                const old = document.getElementById("display");
                const fresh = old.cloneNode(false);
                old.parentNode.replaceChild(fresh, old);
            }
        }
        return new AMOLEDRenderer(options);
    }

    const sim = createSimulator();
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    let frame = null;
    let last = 0;
    let raf = 0;
    const FPS = 30;

    function renderFrame(t) {
        if (!createButterflyFrame) return;
        const stats = sim.getStats();
        const w = stats.gridCols;
        const h = stats.gridRows;
        frame = createButterflyFrame(w, h, t, { count: tier.butterflies, seed: 7 });
        sim.loadFrameBuffer(w, h, frame);
    }

    function loop(now) {
        raf = requestAnimationFrame(loop);
        if (now - last < 1000 / FPS) return;
        last = now;
        renderFrame(now / 1000);
    }

    function start() {
        if (raf) return;
        if (!heroVisible || document.hidden) return;
        if (reduceMotion) { renderFrame(4.2); return; }
        raf = requestAnimationFrame(loop);
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }

    // The hero is only the first screen — once it scrolls out of view the
    // fixed canvas is hidden behind the content tray, so stop burning frames.
    let heroVisible = true;
    const heroEl = document.getElementById("hero");
    if (heroEl && "IntersectionObserver" in window) {
        new IntersectionObserver(entries => {
            heroVisible = entries[0].isIntersecting;
            if (heroVisible) start(); else stop();
        }, { threshold: 0 }).observe(heroEl);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) stop(); else start();
    });

    window.__landing = { sim, tier, renderFrame };
    start();
}

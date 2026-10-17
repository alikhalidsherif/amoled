// Accent hue drift: rotates --h through the color wheel once per
// --hue-cycle (theme.css). Deliberately stepped — one style update per
// second instead of a CSS animation: an animating custom property forces
// a full style recalc every frame, which starves low-power devices for a
// change nobody can see at 2°/s. Driven by requestAnimationFrame rather
// than setInterval so heavy main-thread work (the 30fps preview) cannot
// throttle the drift into visible jumps. Reduced motion leaves the static
// fallback hue; hidden tabs stop entirely and resync on return.
{
    const root = document.documentElement;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    function cycleMs() {
        const v = getComputedStyle(root).getPropertyValue("--hue-cycle").trim();
        const m = /^([\d.]+)(ms|s)$/.exec(v);
        if (!m) return 180000;
        const n = parseFloat(m[1]);
        return m[2] === "s" ? n * 1000 : n;
    }

    const CYCLE = cycleMs();
    const STEP_MS = 1000;
    const BASE = parseFloat(getComputedStyle(root).getPropertyValue("--h")) || 250;

    let raf = 0;
    let lastStep = -1;

    function tick() {
        raf = requestAnimationFrame(tick);
        const step = Math.floor(performance.now() / STEP_MS);
        if (step === lastStep) return;
        lastStep = step;
        const h = BASE + ((performance.now() / CYCLE) * 360) % 360;
        root.style.setProperty("--h", h.toFixed(1));
    }

    function start() {
        if (raf || reduceMotion) return;
        lastStep = -1;
        raf = requestAnimationFrame(tick);
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) stop(); else start();
    });

    window.__hueDrift = {
        cycle: CYCLE,
        step: STEP_MS,
        current: () => parseFloat(root.style.getPropertyValue("--h")) || BASE
    };

    start();
}

// Landing acceptance (/): butterflies attract on a live AMOLED canvas,
// tier-based pitch at 1x supersample, serif hero, CTAs, accent drift
// running — and a reduced-motion page that renders one static frame.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = "/home/ali/dev/amoled-client";
const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".gif": "image/gif", ".woff2": "font/woff2", ".webm": "video/webm"
};
const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let f = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN,
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 1200, height: 800 }
});
let failures = 0;
const fail = m => { failures++; console.log("FAIL:", m); };

function wire(page, tag) {
    page.on("pageerror", e => fail(`${tag} PAGEERROR: ${e.message}`));
    page.on("console", m => { if (m.type() === "error") fail(`${tag} CONSOLE: ${m.text()}`); });
}

// Poll in the main world (page.waitForFunction runs in an isolated world,
// which cannot see the page's window globals).
async function waitForMain(page, expr, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await page.evaluate(expr).catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

// Probe the canvas via drawImage (the landing renders on WebGL, so a 2d
// getContext on the same canvas is unavailable). renderFrame is
// deterministic at t=4.2s, so "lit" must be > 0 whenever rendering works.
const LIT_PROBE = () => {
    const c = document.getElementById("display");
    window.__landing.renderFrame(4.2);
    const t = document.createElement("canvas");
    t.width = c.width; t.height = c.height;
    const g = t.getContext("2d");
    g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, t.width, t.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    }
    return lit;
};

// --- normal-motion page ---
const page = await browser.newPage();
wire(page, "land");
await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
if (!await waitForMain(page, () => !!window.__landing)) fail("landing did not boot");
await new Promise(r => setTimeout(r, 2500));

const boot = await page.evaluate(() => ({
    renderer: window.__landing.sim.constructor.name,
    tier: window.__landing.tier,
    stats: window.__landing.sim.getStats()
}));
if (![4, 6, 10].includes(boot.tier.pitch)) fail(`unexpected tier pitch ${boot.tier.pitch}`);
if (![5, 8, 12].includes(boot.tier.butterflies)) fail(`unexpected tier butterfly count ${boot.tier.butterflies}`);
if (boot.stats.supersample !== 1) fail(`landing supersample must be 1x (got ${boot.stats.supersample})`);

if (!(await page.evaluate(LIT_PROBE) > 20)) fail("landing canvas rendered no lit subpixels");

// canvas must actually animate: two frames sampled ~2.5s apart differ
const frames = await page.evaluate(async () => {
    const snap = () => {
        const c = document.getElementById("display");
        const t = document.createElement("canvas");
        t.width = c.width; t.height = c.height;
        const g = t.getContext("2d");
        g.drawImage(c, 0, 0);
        const d = g.getImageData(0, 0, t.width, t.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 16) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
        return h;
    };
    window.__landing.renderFrame(4.2);
    await new Promise(r => setTimeout(r, 2500));
    const a = snap();
    window.__landing.renderFrame(6.7);
    await new Promise(r => setTimeout(r, 2500));
    const b = snap();
    return { a, b };
});
if (frames.a === frames.b) fail("landing canvas is not animating (identical frame hashes)");

// hero + serif + CTAs + footer
const hero = await page.evaluate(() => {
    const h1 = document.querySelector("#hero h1");
    const primary = document.querySelector(".hero-actions .btn.primary");
    const secondary = document.querySelector(".hero-actions .btn.secondary");
    return {
        h1: h1 ? h1.textContent.trim() : null,
        serif: h1 ? getComputedStyle(h1).fontFamily : "",
        primaryHref: primary ? primary.getAttribute("href") : null,
        secondaryHref: secondary ? secondary.getAttribute("href") : null,
        mail: !!document.querySelector('a[href^="mailto:px@ali.et"]'),
        github: !!document.querySelector('a[href*="github.com/alikhalidsherif/amoled"]'),
        wordmarkAccent: (() => {
            const w = document.querySelector(".wordmark i");
            const b = document.querySelector(".wordmark");
            if (!w || !b) return false;
            return getComputedStyle(w).color !== getComputedStyle(b).color;
        })()
    };
});
if (!hero.h1 || !/Your Display, Magnified/.test(hero.h1)) fail(`hero headline missing (${hero.h1})`);
if (!/Instrument Serif/.test(hero.serif)) fail(`hero must use the serif face (got ${hero.serif})`);
if (hero.primaryHref !== "/sim/") fail(`primary CTA should point to /sim/ (got ${hero.primaryHref})`);
if (hero.secondaryHref !== "/gen/") fail(`secondary CTA should point to /gen/ (got ${hero.secondaryHref})`);
if (!hero.mail) fail("px@ali.et mailto link missing");
if (!hero.github) fail("GitHub link missing");
if (!hero.wordmarkAccent) fail("wordmark dot is not accent-colored");

// theme tokens actually loaded
const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
        bg: s.getPropertyValue("--bg").trim(),
        accent: s.getPropertyValue("--accent").trim(),
        fontLoaded: document.fonts.check('16px "Instrument Serif"')
    };
});
if (tokens.bg !== "#08080a") fail(`theme.css not applied (--bg: ${tokens.bg})`);
if (!/^oklch\(65% 0\.14 [\d.]+\)$/.test(tokens.accent)) fail(`accent token malformed (${tokens.accent})`);
if (!tokens.fontLoaded) fail("Instrument Serif woff2 did not load");

// accent drift: __h advances through a random starting hue at 3°/s of wall
// clock (120s cycle) and the resolved accent hue follows it. Sampled inside
// one evaluate: under SwiftShader a round trip between evaluates can take
// seconds.
const drift = await page.evaluate(async () => {
    const h0 = window.__hueDrift.current();
    const t0 = performance.now();
    await new Promise(r => setTimeout(r, 3500));
    const t1 = performance.now();
    const h1 = window.__hueDrift.current();
    const v = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    const m = /\(65% 0\.14 ([\d.]+)\)/.exec(v);
    return {
        h0, h1, dt: t1 - t0,
        cycle: window.__hueDrift.cycle,
        base: window.__hueDrift.base,
        accent: m ? parseFloat(m[1]) : NaN
    };
});
if (drift.cycle !== 120000) fail(`hue cycle should be 120s (got ${drift.cycle}ms)`);
if (!(drift.base >= 0 && drift.base < 360)) fail(`hue base should be a random 0..360 hue (got ${drift.base})`);
if (!(drift.h0 >= 0 && drift.h0 < 360)) fail(`current hue should wrap to 0..360 (got ${drift.h0})`);
const expected = drift.dt / drift.cycle * 360;
// shortest signed delta — the random starting hue can wrap mid-sample
let delta = drift.h1 - drift.h0;
if (delta < -180) delta += 360;
if (delta > 180) delta -= 360;
if (!(Math.abs(delta - expected) <= 3)) {
    fail(`accent hue drifted ${delta.toFixed(1)} over ${drift.dt.toFixed(0)}ms (expected ~${expected.toFixed(1)})`);
}
if (!(Math.abs(drift.accent - drift.h1) < 1)) {
    fail(`resolved accent hue does not follow --h (${drift.accent} vs ${drift.h1})`);
}
await page.close();

// --- reduced-motion page: one static frame, static hue ---
const rmPage = await browser.newPage();
wire(rmPage, "rm");
await rmPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await rmPage.setViewport({ width: 1200, height: 800 });
await rmPage.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
if (!await waitForMain(rmPage, () => !!window.__landing)) fail("reduced-motion landing did not boot");
await new Promise(r => setTimeout(r, 2000));
const rm = await rmPage.evaluate(() => ({
    lit: (() => {
        const c = document.getElementById("display");
        const t = document.createElement("canvas");
        t.width = c.width; t.height = c.height;
        const g = t.getContext("2d");
        g.drawImage(c, 0, 0);
        const d = g.getImageData(0, 0, t.width, t.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
        }
        return lit;
    })(),
    hue: window.__hueDrift.current(),
    hVar: document.documentElement.style.getPropertyValue("--h")
}));
if (!(rm.lit > 20)) fail("reduced-motion landing rendered no static frame");
if (rm.hVar !== "") fail(`reduced-motion must not drift (--h set to ${rm.hVar})`);
if (rm.hue !== 250) fail(`reduced-motion fallback hue should be 250 (got ${rm.hue})`);
await rmPage.close();

await browser.close();
server.close();
if (failures) {
    console.log(`\nLANDING: ${failures} FAILURES`);
    process.exit(1);
} else {
    console.log("LANDING ACCEPTANCE PASS");
}

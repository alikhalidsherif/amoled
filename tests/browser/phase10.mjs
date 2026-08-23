// Phase 10 acceptance: GPU procedural path active + CPU fallback parity.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream" };
const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox","--disable-gpu","--enable-unsafe-swiftshader"], defaultViewport: { width: 800, height: 600 } });
const page = await browser.newPage();
let failures = 0;
const fail = m => { failures++; console.log("FAIL:", m); };
page.on("pageerror", e => fail("PAGEERROR: " + e.message));
page.on("console", m => { if (!m.text().includes(".WebGL")) console.log("CONSOLE:", m.text()); });

async function waitForRender(maxMs = 25000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await page.evaluate(() => window.__sim?.getRenderCost?.() > 0).catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}
async function nextFramePair() {
    return page.evaluate(() => new Promise(res => {
        let n = 0; (function raf() { if (++n >= 2) return res(); requestAnimationFrame(raf); })();
    }));
}

const PLASMA = {
    amo: 1,
    display: { gamma: 1.4 },
    quality: { fps: 30 },
    timeline: { duration: 8, loop: true },
    scene: {
        type: "expression", seed: 7,
        r: "0.5 + 0.5*sin(x*8 + t*2)",
        g: "0.5 + 0.45*sin(y*6 - t*1.5)",
        b: "u"
    }
};

await page.goto(`http://127.0.0.1:${port}/?scene=scenes/color.amo`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 1500));

// GPU fast path is opt-in (PLAN.md §Phase 10): enable before loading plasma.
await page.evaluate(() => { window.__sim.updateConfig({ gpuRaster: true }); });

const loadOutcome = await page.evaluate(async (d) => {
    const p = window.__player;
    let err = null;
    p._events.onerror = e => { err = e && e.message; };
    const result = await Promise.race([
        p.load(d).then(() => "resolved"),
        new Promise(r => setTimeout(() => r("PENDING-3s"), 3000))
    ]);
    p.play();
    return { result, err };
}, PLASMA);
console.log("plasma load outcome:", JSON.stringify(loadOutcome));
if (!await waitForRender()) fail("no render completed");
await new Promise(r => setTimeout(r, 800));

const gpuState = await page.evaluate(async () => {
    const m = await import("/src/player/gpu-rasterizer.js");
    return {
        usingGpu: Boolean(window.__player._usingGpuRaster),
        forceCpu: Boolean(window.__player._forceCpuRaster),
        supported: m.GpuExpressionRasterizer.isSupported(),
        sceneType: window.__player.runtime.definitionRef?.scene?.type,
        isStatic: window.__player.runtime.definitionRef?.isStatic,
        frames: window.amoledClient.getStats().framesRendered
    };
});
console.log("gpu:", JSON.stringify(gpuState));
if (!gpuState.usingGpu) fail("GPU rasterizer not selected");

const sample = () => page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 48; p.height = 32;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 48, 32);
    const d = x.getImageData(0, 0, 48, 32).data;
    let sumR = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) { sumR += d[i]; if (d[i]+d[i+1]+d[i+2] > 12) lit++; }
    return { meanR: Math.round(sumR/(48*32)), lit };
});

await nextFramePair();
await sample();
await new Promise(r => setTimeout(r, 1200));
await nextFramePair();
const g2 = await sample();
console.log("gpu sample:", JSON.stringify(g2));
if (g2.lit < 20) fail(`GPU plasma black (${g2.lit} lit)`);

// evolution
const evolved = await page.evaluate(async () => {
    const c = document.getElementById("display");
    const grab = () => {
        const p = document.createElement("canvas"); p.width = 32; p.height = 24;
        const x = p.getContext("2d"); x.drawImage(c, 0, 0, 32, 24);
        return [...x.getImageData(0, 0, 32, 24).data];
    };
    const d1 = grab();
    await new Promise(r => setTimeout(r, 2000));
    const d2 = grab();
    let changed = 0;
    for (let i = 0; i < d1.length; i += 4) if (Math.abs(d1[i] - d2[i]) > 3) changed++;
    return changed;
});
console.log("gpu evolving samples:", evolved);
if (evolved < 20) fail(`GPU output not evolving (${evolved})`);

// --- CPU fallback parity on a static expression ---
const STATIC_EXPR = {
    amo: 1,
    display: { gamma: 1 },
    quality: { logicalResolution: { width: 240, height: 160 } },
    scene: { type: "expression", seed: 3, r: "u", g: "v*0.6", b: "noise(u*6,v*6)" }
};
async function loadAndSample(forceCpu) {
    await page.evaluate(async (force, STATIC_EXPR) => {
        window.__player._forceCpuRaster = force;
        if (!force && window.__player._gpuRasterizer) {
            window.__player._gpuRasterizer.destroy();
            window.__player._gpuRasterizer = null;
        }
        await window.__player.load(JSON.parse(JSON.stringify(STATIC_EXPR)));
        window.__player.play();
    }, forceCpu, STATIC_EXPR);
    await new Promise(r => setTimeout(r, 1200));
    await nextFramePair();
    return page.evaluate(() => {
        const c = document.getElementById("display");
        const p = document.createElement("canvas"); p.width = 64; p.height = 40;
        const x = p.getContext("2d"); x.drawImage(c, 0, 0, 64, 40);
        return [...x.getImageData(0, 0, 64, 40).data.filter((_, i) => i % 4 === 1)];
    });
}

// GPU first (clear _forceCpuRaster)
await page.evaluate(() => { window.__player._forceCpuRaster = false; });
const gpuBuf = await loadAndSample(false);
const cpuBuf = await loadAndSample(true);
let maxDiff = 0;
for (let i = 0; i < Math.min(gpuBuf.length, cpuBuf.length); i++) {
    const d = Math.abs(gpuBuf[i] - cpuBuf[i]);
    if (d > maxDiff) maxDiff = d;
}
console.log("GPU vs CPU static parity: max channel delta =", maxDiff);
if (maxDiff > 8) fail(`GPU/CPU divergence too large (${maxDiff})`);

await browser.close(); await server.close();
if (failures) { console.log(`\nPHASE 10: ${failures} FAILURES`); process.exit(1); }
console.log("\nPHASE 10 ACCEPTANCE PASS");

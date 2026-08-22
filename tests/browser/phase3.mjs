// Phase 3 acceptance: .amo -> parser -> player -> PenTile canvas.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream", ".gif": "image/gif", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { console.log("HTTP404", urlPath); res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox","--disable-gpu","--enable-unsafe-swiftshader"], defaultViewport: { width: 800, height: 600 } });
const page = await browser.newPage();
let failures = 0;
function fail(m) { failures++; console.log("FAIL:", m); }
page.on("pageerror", e => { failures++; console.log("PAGEERROR:", e.message); });
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE:", m.text()); });

async function waitForRender(maxMs = 25000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(() => window.__sim?.getRenderCost?.() > 0).catch(() => false);
        if (ready) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

// --- static gradient scene ---
await page.goto(`http://127.0.0.1:${port}/?scene=scenes/gradient.amo`, { waitUntil: "domcontentloaded", timeout: 60000 });
if (!await waitForRender()) fail("no render completed");
await new Promise(r => setTimeout(r, 800));

const s1 = await page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 64; p.height = 40;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 64, 40);
    const d = x.getImageData(0, 0, 64, 40).data;
    let lit = 0, sumR = 0, sumG = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i+1] + d[i+2] > 6) lit++;
        sumR += d[i]; sumG += d[i+1];
    }
    return { frames: window.amoledClient.getStats().framesRendered,
             lit, greenish: sumG >= sumR, player: !!window.__player };
});
console.log("gradient scene:", JSON.stringify(s1));
if (s1.lit === 0) fail("gradient rendered nothing");
if (!s1.player) fail("window.__player hook missing");

// Static scene must NOT accumulate renders while idle.
const f1 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
await new Promise(r => setTimeout(r, 1500));
const f2 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
console.log("idle frames:", f1, "->", f2);
if (f2 > f1 + 1) fail(`static scene keeps rendering (${f1} -> ${f2})`);

// --- switch scene via player.load (cache hit on repeat) ---
const sw = await page.evaluate(async () => {
    const t0 = performance.now();
    await window.__player.load("/scenes/color.amo");
    const first = performance.now() - t0;
    const t1 = performance.now();
    await window.__player.load("scenes/color.amo");
    const second = performance.now() - t1;
    return { first: Math.round(first), second: Math.round(second) };
});
console.log("scene switch ms:", JSON.stringify(sw));
const cacheState = await page.evaluate(() => ({
    keys: [...window.__player._caches.sceneCache.keys()],
    hasColorSlash: window.__player._caches.sceneCache.has("/scenes/color.amo"),
    hasColorPlain: window.__player._caches.sceneCache.has("scenes/color.amo")
}));
console.log("scene cache:", JSON.stringify(cacheState));
if (!cacheState.hasColorSlash && !cacheState.hasColorPlain) {
    fail("parsed-scene cache miss on repeat load");
}

// bright color scene via pre-parsed object -> near-uniform bright field
await page.evaluate(() => window.__player.load({
    amo: 1,
    display: { gamma: 1.0 },
    scene: { type: "gradient", from: "#ffffff", to: "#e8e8e8" }
}));
await new Promise(r => setTimeout(r, 1000));
const s3 = await page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 32; p.height = 20;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 32, 20);
    const d = x.getImageData(0, 0, 32, 20).data;
    let r=0,g=0,b=0,n=32*20;
    for (let i = 0; i < d.length; i += 4) { r+=d[i]; g+=d[i+1]; b+=d[i+2]; }
    return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
});
console.log("bright gradient mean rgb:", JSON.stringify(s3));
if (s3[1] < 40 || Math.abs(s3[0] - s3[2]) > 25) fail("bright gradient wrong: " + JSON.stringify(s3));

// framebuffer introspection on the bright scene
const fbInfo = await page.evaluate(() => {
    const sim = window.__sim;
    const fb = sim.frameBuffer;
    const rt = window.__player.runtime;
    if (!fb || !fb.width) return { fb: null };
    // fb stores only dims; sample the source texture instead via a tiny GL readback
    return {
        fbDims: [fb.width, fb.height],
        logical: rt.logicalSize,
        staticFlag: rt.isStatic,
        running: rt.isRunning,
        frames: window.amoledClient.getStats().framesRendered,
        cost: Math.round(sim.getRenderCost())
    };
});
console.log("fb introspect:", JSON.stringify(fbInfo));

// image scene
await page.evaluate(() => window.__player.load("/scenes/image.amo"));
await new Promise(r => setTimeout(r, 1200));
const img = await page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 32; p.height = 20;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 32, 20);
    const d = x.getImageData(0, 0, 32, 20).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]+d[i+1]+d[i+2] > 30) lit++;
    return lit;
});
console.log("image scene lit:", img);
if (img === 0) fail("image scene rendered nothing");

// gradient still cached?
const cacheHit = await page.evaluate(async () => {
    const t1 = performance.now();
    await window.__player.load("/scenes/gradient.amo");
    return Math.round(performance.now() - t1);
});
console.log("re-load gradient (cached):", cacheHit + "ms");

await browser.close(); await server.close();
if (failures) { console.log(`\nPHASE 3: ${failures} FAILURES`); process.exit(1); }
console.log("\nPHASE 3 ACCEPTANCE PASS");

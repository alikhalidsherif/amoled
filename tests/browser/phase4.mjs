// Phase 4 acceptance: timelines, GIF scenes driven by the runtime clock,
// tab-visibility pause, no FBO churn during animation.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream", ".gif": "image/gif", ".png": "image/png", ".webm": "video/webm", ".svg": "image/svg+xml" };
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

async function waitForRender(maxMs = 25000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await page.evaluate(() => window.__sim?.getRenderCost?.() > 0).catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

await page.goto(`http://127.0.0.1:${port}/?scene=scenes/rain.amo`, { waitUntil: "domcontentloaded", timeout: 60000 });
if (!await waitForRender()) fail("no render completed");
await new Promise(r => setTimeout(r, 1000));

// --- GIF scene animates via runtime clock ---
const a1 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
await new Promise(r => setTimeout(r, 1500));
const a2 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
console.log("gif frames:", a1, "->", a2);
if (a2 <= a1) fail(`GIF scene not animating (${a1} -> ${a2})`);

// --- pause stops it ---
await page.evaluate(() => window.__player.pause());
await new Promise(r => setTimeout(r, 300));
const p1 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
await new Promise(r => setTimeout(r, 1200));
const p2 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
console.log("paused frames:", p1, "->", p2);
if (p2 > p1 + 1) fail("pause did not stop rendering");

// resume for next test
await page.evaluate(() => window.__player.play());
await new Promise(r => setTimeout(r, 500));

// --- keyframe animation without FBO churn ---
await page.evaluate(async () => {
    await window.__player.load({
        amo: 1,
        display: { gamma: 1.0, bloom: { intensity: 0 } },
        timeline: {
            duration: 4,
            loop: true,
            keyframes: [{ property: "display.bloom.intensity", keys: [[0, 0], [2, 0.8], [4, 0.2]] }]
        },
        scene: { type: "gradient", from: "#404040", to: "#c0c0c0", direction: "radial" }
    });
});
// load() leaves the runtime stopped (setScene renders once); start it.
await page.evaluate(() => window.__player.play());
await new Promise(r => setTimeout(r, 400));

// FBO identity must be compared INSIDE the page (evaluate serializes).
await page.evaluate(() => { window.__fboRef = window.__sim.sceneTarget; });
const bloomA = await page.evaluate(() => window.__sim.config.bloomIntensity);
await new Promise(r => setTimeout(r, 1300));
const bloomB = await page.evaluate(() => window.__sim.config.bloomIntensity);
const fboStable = await page.evaluate(() => window.__fboRef === window.__sim.sceneTarget);
console.log("bloomIntensity over time:", bloomA.toFixed(3), "->", bloomB.toFixed(3));
if (Math.abs(bloomB - bloomA) < 0.01) fail("keyframes not applied (bloom static)");
if (!fboStable) fail("FBO targets recreated during animation!");
else console.log("sceneTarget identity stable across animation ✓");

// --- visibility pause [A2] ---
await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
});
await new Promise(r => setTimeout(r, 400));
const vRunning = await page.evaluate(() => window.__player.runtime.isRunning);
console.log("hidden -> running:", vRunning);

await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
});
await new Promise(r => setTimeout(r, 400));
const vResumed = await page.evaluate(() => window.__player.runtime.isRunning);
console.log("visible -> running:", vResumed);
if (vRunning) fail("runtime still running while hidden");
if (!vResumed) fail("runtime did not resume when visible");

await browser.close(); await server.close();
if (failures) { console.log(`\nPHASE 4: ${failures} FAILURES`); process.exit(1); }
console.log("\nPHASE 4 ACCEPTANCE PASS");

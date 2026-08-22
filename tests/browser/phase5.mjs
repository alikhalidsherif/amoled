// Phase 5 acceptance: procedural expression scenes through emitter physics.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream", ".gif": "image/gif", ".png": "image/png", ".webm": "video/webm" };
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
const sampleCanvas = () => page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 48; p.height = 32;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 48, 32);
    return [...x.getImageData(0, 0, 48, 32).data.filter((_, i) => i % 4 === 1)]; // green channel strip
});

await page.goto(`http://127.0.0.1:${port}/?scene=scenes/procedural.amo`, { waitUntil: "domcontentloaded", timeout: 60000 });
if (!await waitForRender()) fail("no render completed");

// --- plasma animates ---
const a1 = await page.evaluate(() => ({
    frames: window.amoledClient.getStats().framesRendered,
    time: window.__player.runtime.time
}));
const s1 = await sampleCanvas();
await new Promise(r => setTimeout(r, 4000));
const a2 = await page.evaluate(() => ({
    frames: window.amoledClient.getStats().framesRendered,
    time: window.__player.runtime.time
}));
const s2 = await sampleCanvas();
console.log("frames:", a1.frames, "->", a2.frames,
    "| sceneTime:", a1.time.toFixed(2), "->", a2.time.toFixed(2));

const changed = s1.filter((v, i) => Math.abs(v - s2[i]) > 4).length;
console.log("changed samples:", changed, "/", s1.length);
if (a2.frames <= a1.frames) fail("plasma scene not animating");
if (!(a2.time > a1.time)) fail("scene clock not advancing");
if (a2.time > a1.time + 0.2 && changed < 10) {
    // Output must evolve given >= 0.25s of scene-time delta.
}
if (changed < 10 && a2.time - a1.time > 0.2) {
    fail(`plasma output not evolving (${changed} changed, dt=${(a2.time-a1.time).toFixed(2)})`);
}

// --- static expression scene renders exactly once ---
await page.evaluate(async () => {
    await window.__player.load({
        amo: 1,
        display: { gamma: 1.0 },
        scene: {
            type: "expression",
            r: "(x / width)",          // horizontal ramp — static math image
            g: "(y / height)",
            b: "0.3"
        }
    });
});
if (!await waitForRender(10000)) fail("static expression did not render");
await new Promise(r => setTimeout(r, 300));
const f1 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
const st1 = await sampleCanvas();
await new Promise(r => setTimeout(r, 1200));
const f2 = await page.evaluate(() => window.amoledClient.getStats().framesRendered);
const st2 = await sampleCanvas();
console.log("static expr frames:", f1, "->", f2, "| identical:", JSON.stringify(st1) === JSON.stringify(st2));
if (f2 > f1) fail("static expression keeps rendering (AST walk failed)");
if (JSON.stringify(st1) !== JSON.stringify(st2)) fail("static expression output drifted");
// ramp sanity: left edge dark-green channel low, right high
if (!(st1[0] < st1[st1.length - 1])) fail("ramp direction wrong");

await browser.close(); await server.close();
if (failures) { console.log(`\nPHASE 5: ${failures} FAILURES`); process.exit(1); }
console.log("\nPHASE 5 ACCEPTANCE PASS");

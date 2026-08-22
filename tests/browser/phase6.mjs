// Phase 6 acceptance: composite scene renders through player + engine.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream", ".gif": "image/gif", ".png": "image/png" };
const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox","--disable-gpu","--enable-unsafe-swiftshader"], defaultViewport: { width: 800, height: 600 } });
const page = await browser.newPage();
let failures = 0;
const fail = m => { failures++; console.log("FAIL:", m); };
page.on("pageerror", e => fail("PAGEERROR: " + e.message));
page.on("console", m => { if (m.type() === "error") console.log("CONSOLE-ERR:", m.text()); });

async function waitForRender(maxMs = 25000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await page.evaluate(() => window.__sim?.getRenderCost?.() > 0).catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

await page.goto(`http://127.0.0.1:${server.address().port}/?scene=scenes/composite.amo`, { waitUntil: "domcontentloaded", timeout: 60000 });
if (!await waitForRender()) fail("no render completed");
await new Promise(r => setTimeout(r, 1500));

const probe = async () => page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 48; p.height = 32;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 48, 32);
    const d = x.getImageData(0, 0, 48, 32).data;
    let lit = 0, sumG = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i]+d[i+1]+d[i+2] > 8) lit++; sumG += d[i+1]; }
    return { lit, meanG: Math.round(sumG / (48*32)), frames: window.amoledClient.getStats().framesRendered };
});

const a = await probe();
console.log("composite:", JSON.stringify(a));
if (a.lit < 200) fail(`composite mostly black (lit=${a.lit}/1536)`);

// animated shimmer layer -> output evolves
const s1 = await page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 48; p.height = 32;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 48, 32);
    return [...x.getImageData(0, 0, 48, 32).data];
});
await new Promise(r => setTimeout(r, 4000));
const s2 = await page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 48; p.height = 32;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 48, 32);
    return [...x.getImageData(0, 0, 48, 32).data];
});
const changed = s1.filter((v, i) => Math.abs(v - s2[i]) >= 1).length;
console.log("evolving samples:", changed, "/", s1.length);
if (changed < 100) fail(`shimmer layer not evolving (${changed})`);

await browser.close(); await server.close();
if (failures) { console.log(`\nPHASE 6: ${failures} FAILURES`); process.exit(1); }
console.log("\nPHASE 6 ACCEPTANCE PASS");

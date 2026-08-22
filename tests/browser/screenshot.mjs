// Screenshot gate: renders a fixed scene at a fixed viewport and writes the
// canvas pixels as raw bytes + PNG-able dump. Usage:
//   node tests/browser/screenshot.mjs out.bin [sceneUrl]
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
const sceneUrl = process.argv[3] || "/scenes/composite.amo";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox","--disable-gpu","--enable-unsafe-swiftshader"], defaultViewport: { width: 640, height: 400 } });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/?scene=${sceneUrl}`, { waitUntil: "domcontentloaded", timeout: 60000 });
// deterministic static frame: force time-independent content by loading color.amo composite? Use gradient (static) for determinism.
if (!process.argv[3]) {
    await page.evaluate(() => window.__player.load("/scenes/gradient.amo"));
}
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__sim?.getRenderCost?.() > 0).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 200));
}
await page.evaluate(() => new Promise(res => {
    let n = 0; (function raf() { if (++n >= 2) return res(); requestAnimationFrame(raf); })();
}));
const data = await page.evaluate(() => {
    const c = document.getElementById("display");
    const p = document.createElement("canvas"); p.width = 160; p.height = 100;
    const x = p.getContext("2d"); x.drawImage(c, 0, 0, 160, 100);
    return [...x.getImageData(0, 0, 160, 100).data];
});
fs.writeFileSync(process.argv[2], Buffer.from(data));
console.log("wrote", process.argv[2], data.length, "bytes");
await browser.close(); await server.close();

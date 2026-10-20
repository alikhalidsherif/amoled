// Regenerates the Open Graph share image (assets/icons/og-preview.png,
// 1200x630) from the designed card at tools/og-card.html — a deterministic,
// hand-composed layout (magnified Diamond PenTile lattice + headline), NOT a
// screenshot of the live site. Waits for the Instrument Serif woff2 before
// capturing so the headline never falls back to a system serif.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "assets/icons/og-preview.png");
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
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"]
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.goto(`${base}/tools/og-card.html`, { waitUntil: "networkidle0", timeout: 60000 });

// Fonts + the one-shot canvas paint must both be settled before capture.
await page.evaluate(() => document.fonts.ready);
const loaded = await page.evaluate(() => document.fonts.check('16px "Instrument Serif"'));
if (!loaded) console.warn("warn: Instrument Serif did not load — headline may fall back");
await new Promise(r => setTimeout(r, 400));

await page.screenshot({ path: OUT });
console.log("wrote", OUT);
await browser.close();
server.close();

// Regenerates the Open Graph share image (assets/icons/og-preview.png,
// 1200x630) from the live landing page. Runs with prefers-reduced-motion
// so the butterfly pose (t=4.2) and the accent hue (static 250) are
// deterministic across runs.
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
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.goto(`${base}/`, { waitUntil: "networkidle0", timeout: 60000 });

// Wait for boot, then re-render the deterministic reduced-motion pose so the
// captured frame is exactly t=4.2 regardless of capture timing.
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
    if (await page.evaluate(() => !!window.__landing)) break;
    await new Promise(r => setTimeout(r, 250));
}
await page.evaluate(() => window.__landing.renderFrame(4.2));
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: OUT });
console.log("wrote", OUT);
await browser.close();
server.close();

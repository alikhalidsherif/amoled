// Screenshot helper (dev tool, not part of the test suite).
//   node tools/shot.mjs <url-path> <out.png> [width] [height] [waitMs] [reduce]
// Serves the repo root on an ephemeral port and captures a viewport shot.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
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

const [urlPath, out, w, h, waitMs, reduce] = process.argv.slice(2);
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN,
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"]
});
const page = await browser.newPage();
await page.setViewport({ width: +(w || 1440), height: +(h || 900), deviceScaleFactor: 1 });
if (reduce) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await page.goto(base + (urlPath || "/"), { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, +(waitMs || 3000)));
await page.screenshot({ path: out || "screenshots/shot.png" });
console.log("saved", out);
await browser.close();
server.close();

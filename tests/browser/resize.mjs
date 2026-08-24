// Resize convergence: rapid viewport changes (devtools docking) must leave
// the canvas matching the FINAL container size, not a transitional one.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = "/home/ali/dev/amoled-client";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".gif": "image/gif" };
const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(ROOT, u === "/" ? "/index.html" : u);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN,
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 1280, height: 800 }
});
const page = await browser.newPage();
let failures = 0;
page.on("pageerror", e => { failures++; console.log("PAGEERROR:", e.message); });
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 2500));

// Simulate devtools docking: two rapid resizes, second slightly larger.
await page.setViewport({ width: 640, height: 400 });
await new Promise(r => setTimeout(r, 30));
await page.setViewport({ width: 660, height: 430 });

// Give the 180 ms settle pass time to converge.
await new Promise(r => setTimeout(r, 900));

const check = await page.evaluate(() => {
    const shell = document.getElementById("display-shell");
    const rect = shell.getBoundingClientRect();
    const canvas = document.getElementById("display");
    return {
        cssW: Math.floor(rect.width), cssH: Math.floor(rect.height),
        canvasW: canvas.width, canvasH: canvas.height,
        dpr: window.devicePixelRatio
    };
});
console.log("container:", check.cssW + "x" + check.cssH,
    "| canvas backing:", check.canvasW + "x" + check.canvasH, "| dpr:", check.dpr);
const expectW = Math.min(check.dpr, 2) * check.cssW;
const expectH = Math.min(check.dpr, 2) * check.cssH;
if (Math.abs(check.canvasW - expectW) > 2 || Math.abs(check.canvasH - expectH) > 2) {
    failures++;
    console.log(`FAIL: canvas stuck at wrong geometry (expected ~${expectW}x${expectH})`);
}

await browser.close();
server.close();
if (failures) { console.log(`RESIZE: ${failures} FAILURES`); process.exit(1); }
console.log("\nRESIZE CONVERGENCE PASS");

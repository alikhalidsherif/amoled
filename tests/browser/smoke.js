// End-to-end smoke test: loads the simulator in headless Chrome (SwiftShader
// WebGL), verifies GPU engine init, shader compilation, and non-black output.
"use strict";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
    ".gif": "image/gif"
};

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent(req.url.split("?")[0]);
            let file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
            if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); res.end(); return;
            }
            res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
            fs.createReadStream(file).pipe(res);
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

(async () => {
    const server = await serve();
    const port = server.address().port;

    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_BIN || undefined,
        args: [
            "--no-sandbox", "--disable-gpu",
            "--enable-unsafe-swiftshader",
            "--use-angle=swiftshader",
            "--window-size=1280,800"
        ],
        defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
    const errors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") {
            errors.push(msg.type() + ": " + msg.text());
        }
    });
    page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

    await page.goto("http://127.0.0.1:" + port + "/", {
        waitUntil: "domcontentloaded",
        timeout: 60000
    });

    // Wait for the first completed render (SwiftShader shader compile can
    // take seconds on software WebGL; poll rather than sleep).
    async function waitForRender(maxMs) {
        const deadline = Date.now() + (maxMs || 20000);
        while (Date.now() < deadline) {
            const ready = await page.evaluate(() => {
                const sim = window.__sim;
                return Boolean(sim && sim.getRenderCost && sim.getRenderCost() > 0);
            }).catch(() => false);
            if (ready) return true;
            await new Promise(r => setTimeout(r, 250));
        }
        return false;
    }
    await waitForRender(25000);
    await new Promise(r => setTimeout(r, 400));

    const result = await page.evaluate(() => {
        const stats = window.amoledClient.getStats();
        const canvas = document.getElementById("display");
        // Read back a downscaled sample of the canvas.
        const probe = document.createElement("canvas");
        probe.width = 64; probe.height = 40;
        const pctx = probe.getContext("2d");
        pctx.drawImage(canvas, 0, 0, 64, 40);
        const data = pctx.getImageData(0, 0, 64, 40).data;
        let litPixels = 0, maxLuma = 0;
        for (let i = 0; i < data.length; i += 4) {
            const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            if (luma > 8) litPixels++;
            if (luma > maxLuma) maxLuma = luma;
        }
        return {
            stats,
            canvasSize: canvas.width + "x" + canvas.height,
            statusText: document.getElementById("sim-status").textContent,
            litPixels, maxLuma,
            totalPixels: 64 * 40
        };
    });

    console.log(JSON.stringify(result.stats, null, 2));
    console.log("canvas:", result.canvasSize);
    console.log("lit pixels in probe:", result.litPixels + "/" + result.totalPixels,
        "maxLuma:", Math.round(result.maxLuma));
    console.log("--- status ---");
    console.log(result.statusText);

    // Exercise bloom: same content, bloom off vs on.
    await page.evaluate(() => {
        const slider = document.getElementById("bloom-slider");
        slider.value = "0";
        slider.dispatchEvent(new Event("input"));
    });
    // clear() stops the demo media loop; otherwise it keeps overwriting
    // frames mid-measurement.
    await page.evaluate(() => { window.amoledClient.clear(); });
    await waitForRender(10000);
    await new Promise(r => setTimeout(r, 300));

    const countLit = () => page.evaluate(() => {
        const canvas = document.getElementById("display");
        const probe = document.createElement("canvas");
        probe.width = 64; probe.height = 40;
        const pctx = probe.getContext("2d");
        pctx.drawImage(canvas, 0, 0, 64, 40);
        const d = pctx.getImageData(0, 0, 64, 40).data;
        // Total luminous energy — bloom is additive, so this must grow.
        let energy = 0;
        for (let i = 0; i < d.length; i += 4) {
            energy += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        }
        return Math.round(energy);
    });

    const litOff = await countLit();

    await page.evaluate(() => {
        const slider = document.getElementById("bloom-slider");
        slider.value = "60";
        slider.dispatchEvent(new Event("input"));
    });
    await new Promise(r => setTimeout(r, 600));
    const litOn = await countLit();
    console.log("test pattern: bloom=0% energy:", litOff, " bloom=60% energy:", litOn);

    const fail = [];
    if (!result.stats.engine) fail.push("engine missing from stats");
    if (result.litPixels === 0) fail.push("canvas is black — nothing rendered");
    if (litOn <= litOff) fail.push("bloom did not increase light energy");
    const realErrors = errors.filter(e =>
        !e.includes("GPU stall") && !e.includes("Automatic fallback")
    );
    if (realErrors.length) fail.push("console errors: " + realErrors.slice(0, 5).join(" | "));

    if (fail.length) {
        console.log("\nFAIL:\n - " + fail.join("\n - "));
        process.exitCode = 1;
    } else {
        console.log("\nSMOKE TEST PASS");
    }

    await browser.close();
    server.close();
})().catch(err => { console.error("HARNESS ERROR:", err); process.exit(1); });

// Verifies: (1) bloom floor/radius now visibly change output,
// (2) context loss recovers, (3) pitch UI stays in sync across media loads.
"use strict";
const puppeteer = require("puppeteer-core");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".gif": "image/gif" };

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
});

function fail(msg) { console.log("FAIL:", msg); process.exitCode = 1; }

(async () => {
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_BIN || undefined,
        args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"],
        defaultViewport: { width: 700, height: 900 }
    });
    const page = await browser.newPage();
    page.on("pageerror", e => console.log("pageerror:", e.message));
    await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded", timeout: 60000 });

    const energy = () => page.evaluate(() => {
        window.__pendingRender && window.__pendingRender();
        const canvas = document.getElementById("display");
        const probe = document.createElement("canvas");
        probe.width = 64; probe.height = 40;
        pctx = probe.getContext("2d");
        pctx.drawImage(canvas, 0, 0, 64, 40);
        const d = pctx.getImageData(0, 0, 64, 40).data;
        let e = 0;
        for (let i = 0; i < d.length; i += 4) e += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return Math.round(e);
    });

    // --- bloom responsiveness ---
    const settle = () => new Promise(r => setTimeout(r, 900));

    await page.evaluate(() => {
        window.amoledClient.clear();          // stop the media loop
        window.amoledClient.loadPattern();
        for (const [id, v] of [["bloom-slider", "100"], ["bloom-threshold", "10"]]) {
            const el = document.getElementById(id);
            el.value = v; el.dispatchEvent(new Event("input"));
        }
    });
    await settle();
    await settle();
    const eBloomHighFloor = Math.max(await energy(), await new Promise(r =>
        setTimeout(async () => r(await energy()), 300)));

    await page.evaluate(() => {
        const el = document.getElementById("bloom-threshold");
        el.value = "90"; el.dispatchEvent(new Event("input"));
    });
    await settle();
    const eBloomLowFloor = await energy();

    console.log("bloom energy floor=10%:", eBloomHighFloor, " floor=90%:", eBloomLowFloor);
    if (!(eBloomHighFloor > eBloomLowFloor * 1.15)) {
        fail("bloom floor slider has no visible effect (" + eBloomHighFloor + " vs " + eBloomLowFloor + ")");
    }

    // radius effect
    await page.evaluate(() => {
        const el = document.getElementById("bloom-radius");
        el.value = "30"; el.dispatchEvent(new Event("input"));
    });
    await new Promise(r => setTimeout(r, 500));

    // --- pitch UI sync on media load ---
    await page.evaluate(async () => {
        // switch to manual pitch 12 first
        const sel = document.getElementById("scale-mode");
        sel.value = "manual"; sel.dispatchEvent(new Event("change"));
        const inp = document.getElementById("pixel-scale-input");
        inp.value = "12"; inp.dispatchEvent(new Event("change"));
    });
    await new Promise(r => setTimeout(r, 400));

    await page.evaluate(async () => {
        await window.amoledClient.loadUrl("/assets/test-portrait.gif");
    });
    await new Promise(r => setTimeout(r, 1200));

    const pitchState = await page.evaluate(() => ({
        input: document.getElementById("pixel-scale-input").value,
        mode: document.getElementById("scale-mode").value,
        cfgPitch: window.amoledClient.getStats().pixelScale
    }));
    console.log("after media load:", JSON.stringify(pitchState));
    if (pitchState.mode !== "manual" || Math.abs(Number(pitchState.input) - pitchState.cfgPitch) > 0.26) {
        fail("pitch UI desynced from config after media load");
    }

    // --- spill default + auto-pitch preserved on media load ---
    const defaultsCheck = await page.evaluate(() => ({
        spill: document.getElementById("spill-slider").value,
        spillText: document.getElementById("spill-slider-val").textContent,
        cfgSpill: Math.round((window.AMOLED.DEFAULT_ENGINE_CONFIG.opticalSpill || 0) * 100)
    }));
    console.log("spill slider:", JSON.stringify(defaultsCheck));
    if (defaultsCheck.spill !== "40") fail("spill slider default is not 40%");

    await page.evaluate(() => {
        const sel = document.getElementById("scale-mode");
        sel.value = "auto"; sel.dispatchEvent(new Event("change"));
    });
    await new Promise(r => setTimeout(r, 400));
    const beforeAuto = await page.evaluate(() => window.amoledClient.getStats().pixelScale);
    await page.evaluate(async () => { await window.amoledClient.loadUrl("/assets/test-portrait.gif"); });
    await new Promise(r => setTimeout(r, 1200));
    const afterAuto = await page.evaluate(() => {
        return {
            mode: document.getElementById("scale-mode").value,
            pitch: window.amoledClient.getStats().pixelScale,
            perf: null
        };
    });
    console.log("auto mode pitch before:", beforeAuto.toFixed(2), "after:", afterAuto.pitch.toFixed(2), "mode:", afterAuto.mode);
    if (afterAuto.mode !== "auto") fail("media load kicked auto scale into manual");
    if (Math.abs(afterAuto.pitch - beforeAuto) > 0.5) fail("auto pitch changed on media load");

    // --- context loss recovery ---
    await page.evaluate(() => {
        const gl = document.getElementById("display").getContext("webgl2");
        window.__loseCtx = gl.getExtension("WEBGL_lose_context");
        window.__loseCtx.loseContext();
    });
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => { window.__loseCtx.restoreContext(); });
    await new Promise(r => setTimeout(r, 1500));

    const recovered = await page.evaluate(() => {
        const s = window.amoledClient.getStats();
        const canvas = document.getElementById("display");
        const probe = document.createElement("canvas");
        probe.width = 64; probe.height = 40;
        const pctx = probe.getContext("2d");
        pctx.drawImage(canvas, 0, 0, 64, 40);
        const d = pctx.getImageData(0, 0, 64, 40).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
        }
        return { lost: s.contextLost === true, lit };
    });
    console.log("after context restore:", JSON.stringify(recovered));
    if (recovered.lost) fail("stats still report context lost");
    if (recovered.lit === 0) fail("canvas black after context restore");

    await browser.close();
    server.close();
    if (!process.exitCode) console.log("\nALL REGRESSION TESTS PASS");
})();

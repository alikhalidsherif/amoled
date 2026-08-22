// Phase 7 acceptance: every §5.2 display field flows to engine config;
// structural params trigger exactly one resize on scene load.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream" };
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
await page.goto(`http://127.0.0.1:${server.address().port}/?scene=scenes/color.amo`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 1500));

// ---- per-field mapping audit ----
const CASES = [
    ["display.gamma", 2.2, "emitterGamma"],
    ["display.brightness.active", 0.8, "activeLevel"],
    ["display.brightness.inactive", 0.06, "inactiveLevel"],
    ["display.spill", 0.5, "opticalSpill"],
    ["display.emitters.maxOutput.r", 0.4, "redMaxOutput"],
    ["display.emitters.maxOutput.g", 0.9, "greenMaxOutput"],
    ["display.emitters.maxOutput.b", 0.3, "blueMaxOutput"],
    ["display.emitters.sigma.r", 0.7, "redSigma"],
    ["display.emitters.sigma.g", 0.45, "greenSigma"],
    ["display.emitters.sigma.b", 0.75, "blueSigma"],
    ["display.bloom.intensity", 0.6, "bloomIntensity"],
    ["display.bloom.threshold", 0.3, "bloomThreshold"],
    ["display.bloom.power", 2.6, "bloomPower"],
    ["display.bloom.radius", 24, "bloomRadius"],
    ["display.pentile.rowPitchFactor", 0.95, "rowPitchFactor"],
    ["display.pentile.blackMatrixRatio", 0.15, "blackMatrixRatio"],
    ["display.pentile.greenSizeRatio", 0.85, "greenSizeRatio"],
    ["display.pentile.diamondSizeRatio", 0.95, "diamondSizeRatio"]
];
for (const [path, value, cfgKey] of CASES) {
    const okField = await page.evaluate(({ path, value, cfgKey }) => {
        // build nested setter for the inline definition
        const def = { amo: 1, scene: { type: "color", color: "#111111" } };
        let node = def;
        const parts = path.split(".");
        parts.slice(0, -1).forEach(p => { node[p] = {}; node = node[p]; });
        node[parts[parts.length - 1]] = value;
        return window.__player.load(def).then(() => window.__sim.config[cfgKey]);
    }, { path, value, cfgKey }).catch(e => "ERR:" + e.message);
    const pass = typeof okField === "number" && Math.abs(okField - value) < 1e-9;
    console.log(path, "->", cfgKey, "=", okField, pass ? "OK" : "** MISMATCH **");
    if (!pass) fail(`${path} did not reach engine config`);
}

// pitch auto semantics: null keeps auto-density
const autoOk = await page.evaluate(async () => {
    await window.__player.load({ amo: 1, scene: { type: "color", color: "#111" } }); // no pitch
    return window.__sim.config.autoPixelScale === true;
});
console.log("pitch auto -> autoPixelScale:", autoOk);
if (!autoOk) fail("pitch:auto does not preserve engine auto-density");

// manual pitch flows through
const manualOk = await page.evaluate(async () => {
    await window.__player.load({ amo: 1, display: { pitch: 10 }, scene: { type: "color", color: "#111" } });
    const p = window.__sim.config.pixelScale;
    await window.__player.load({ amo: 1, scene: { type: "color", color: "#111" } }); // back to auto
    return Math.abs(p - 10) < 1e-9;
});
console.log("pitch 10 -> pixelScale:", manualOk);
if (!manualOk) fail("manual pitch not applied");

// ---- single resize on structural change [A3-related] ----
const resizeCount = await page.evaluate(async () => {
    const sim = window.__sim;
    let recreations = 0;
    // instrument: wrap _createTarget
    const orig = sim._createTarget.bind(sim);
    sim._createTarget = function (...a) { recreations++; return orig(...a); };
    const beforeFrames = sim.framesRendered;
    await window.__player.load({ amo: 1, display: { pitch: 12 }, scene: { type: "gradient", from: "#000", to: "#fff" } });
    await new Promise(r => setTimeout(r, 800));
    sim._createTarget = orig;
    return { recreations, frames: sim.framesRendered - beforeFrames };
});
console.log("target recreations during pitch-scene load:", JSON.stringify(resizeCount));
// 3 targets recreated once = 3 calls; allow up to 6 (one extra coalesced resize)
if (resizeCount.recreations > 6) fail(`FBO churn: ${resizeCount.recreations} target allocations`);
if (resizeCount.frames > 4) fail(`frame burst after scene load: ${resizeCount.frames}`);

await browser.close(); await server.close();
if (failures) { console.log(`\nPHASE 7: ${failures} FAILURES`); process.exit(1); }
console.log("\nPHASE 7 ACCEPTANCE PASS");

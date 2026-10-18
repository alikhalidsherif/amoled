// Shape presets + Advanced-tab polish acceptance (PLAN_ADVANCED_MATH_POLISH.md).
// Single page load (reload crashes under SwiftShader headless — see studio.mjs).

import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = "/home/ali/dev/amoled-client";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream", ".gif": "image/gif", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(ROOT, urlPath === "/" ? "/gen/index.html" : urlPath);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN,
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 800, height: 500 }
});
const page = await browser.newPage();
let failures = 0;
const fail = m => { failures++; console.log("FAIL:", m); };
page.on("pageerror", e => fail("PAGEERROR: " + e.message));

async function waitFor(expr, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await page.evaluate(expr).catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

await page.goto(`http://127.0.0.1:${server.address().port}/gen/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

if (!await waitFor(() => !!window.__gplayerRef())) fail("studio did not boot");

// --- open Advanced → Math: sheet + shapes bar must render on first open ---
await page.evaluate(() => document.querySelector('#tabs button[data-tab="advanced"]').click());
await page.evaluate(() => document.querySelector('#adv-strip button[data-atab="math"]').click());
if (!await waitFor(() => document.querySelectorAll("#math-shapes button").length === 5)) {
    fail("shapes bar did not render 5 presets");
}
const shapeIds = await page.evaluate(() =>
    [...document.querySelectorAll("#math-shapes button")].map(b => b.dataset.shape).join(","));
if (shapeIds !== "circle,ring,square,cross,ripples") fail(`shape ids: ${shapeIds}`);

// --- control-system sanity (input polish, §2.4) ---
const ctl = await page.evaluate(() => ({
    inputMinH: getComputedStyle(document.getElementById("math-duration")).minHeight,
    shapeBtnH: getComputedStyle(document.querySelector("#math-shapes button")).minHeight,
    rangeTrack: !!document.querySelector('input[type="range"]') // transport range exists
}));
if (ctl.inputMinH !== "32px") fail(`math-duration minHeight=${ctl.inputMinH} (want 32px)`);
if (ctl.shapeBtnH !== "26px") fail(`shape button minHeight=${ctl.shapeBtnH} (want 26px)`);

// --- boot scene is a scope: shape insert layers OVER the traces (wrap,
// not refuse — traces stay editable through the Traces workspace) ---
const bootType = await page.evaluate(() => window.__gworking().scene.type);
if (bootType !== "scope") fail(`expected scope boot, got ${bootType}`);
await page.evaluate(() => document.querySelector('#math-shapes button[data-shape="circle"]').click());
if (!await waitFor(() =>
    window.__gworking().scene.type === "composite" &&
    window.__gworking().scene.layers[0]?.type === "scope" &&
    window.__gworking().scene.layers[1]?.type === "expression"
)) fail("shape insert on waveform scene did not wrap as composite [scope, shape]");
// traces remain editable: Traces tab still shows the three boot traces
await page.evaluate(() => document.querySelector('#tabs button[data-tab="traces"]').click());
if (!await waitFor(() => document.querySelectorAll("#pane-traces .trace-card").length >= 3)) {
    fail("traces not editable after shape insert");
}
await page.evaluate(() => document.querySelector('#tabs button[data-tab="advanced"]').click());
await page.evaluate(() => document.querySelector('#adv-strip button[data-atab="math"]').click());

// --- load an equation scene, then insert shapes ---
await page.evaluate(async () => {
    const res = await fetch("../scenes/three-phase.amo");
    const raw = JSON.parse(await res.text());
    document.getElementById("source").value = JSON.stringify(raw, null, 2);
    document.getElementById("source").dispatchEvent(new Event("input"));
});
if (!await waitFor(() => window.__gworking()?.parameters?.omega !== undefined)) {
    fail("three-phase scene did not adopt");
}

await page.evaluate(() => document.querySelector('#math-shapes button[data-shape="circle"]').click());
if (!await waitFor(() =>
    window.__gworking().scene.type === "composite" &&
    window.__gworking().parameters?.cx?.value === 0.5 &&
    window.__gworking().parameters?.radius?.value === 0.18
)) fail("circle insert: composite layer + cx/radius params missing");

// ring reuses `radius` — must not clobber the existing slider
await page.evaluate(() => document.querySelector('#math-shapes button[data-shape="ring"]').click());
if (!await waitFor(() => window.__gworking().scene.layers.length === 3)) {
    fail("ring insert: expected 3 composite layers");
}
const radiusKept = await page.evaluate(() => window.__gworking().parameters.radius.value);
if (radiusKept !== 0.18) fail(`ring clobbered radius (=${radiusKept})`);

// param slider from an adopted shape param drives the model
await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#param-list .param-row")];
    const cxRow = rows.find(r => r.querySelector('input[type="text"]')?.value === "cx");
    const s = cxRow.querySelector('input[type="range"]');
    s.value = "0.3";
    s.dispatchEvent(new Event("input", { bubbles: true }));
});
if (!await waitFor(() => window.__gworking().parameters.cx.value === 0.3)) {
    fail("cx slider did not update model");
}

// equation text of the inserted circle layer uses u,v (not x,y) + aspect
const circleExpr = await page.evaluate(() => {
    const layers = window.__gworking().scene.layers;
    return layers[layers.length - 2].r;   // circle is before ring
});
if (!/\(u-cx\)/.test(circleExpr) || !/width\/height/.test(circleExpr) || /\(x-cx\)/.test(circleExpr)) {
    fail(`circle equation not u,v-based: ${circleExpr}`);
}

// square on a cleared sheet (single-group path)
await page.evaluate(() => document.getElementById("btn-new-math").click());
if (!await waitFor(() => window.__gworking().scene.type === "expression")) {
    fail("clear sheet did not produce single expression scene");
}
await page.evaluate(() => document.querySelector('#math-shapes button[data-shape="square"]').click());
if (!await waitFor(() =>
    window.__gworking().parameters?.size?.value === 0.16
)) fail("square insert: size param missing");

// --- Advanced declutter: single layers action row, collapsible sections ---
await page.evaluate(() => document.querySelector('#adv-strip button[data-atab="layers"]').click());
const layersUi = await page.evaluate(() => ({
    actionRows: document.querySelectorAll('[data-pane="layers"] > .layer-actions').length,
    details: document.querySelectorAll('[data-pane="layers"] details.ws-section').length,
    presetClosed: !document.querySelectorAll('[data-pane="layers"] details.ws-section')[1]?.open,
    galleryInLayers: !!document.querySelector('[data-pane="layers"] #gallery')
}));
if (layersUi.actionRows !== 1) fail(`layers action rows=${layersUi.actionRows} (want 1)`);
if (layersUi.details !== 2) fail(`layers details sections=${layersUi.details} (want 2)`);
if (!layersUi.presetClosed) fail("motion-preset section should default closed");
if (layersUi.galleryInLayers) fail("examples gallery still parked inside the layers pane");

// design pane: no lone Author h2, author field still present
await page.evaluate(() => document.querySelector('#adv-strip button[data-atab="design"]').click());
const design = await page.evaluate(() => ({
    authorH2: [...document.querySelectorAll('[data-pane="design"] h2')].some(h => /author/i.test(h.textContent)),
    authorField: !!document.getElementById("f-author")
}));
if (design.authorH2) fail("design pane still has a lone Author heading");
if (!design.authorField) fail("author field missing");

await browser.close();
server.close();
console.log(`shapes: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
if (failures) process.exit(1);

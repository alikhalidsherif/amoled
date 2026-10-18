// Layers overhaul + AI round-trip acceptance (PLAN_ADVANCED_MATH_POLISH.md §5).
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
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN,
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 1000, height: 700 }
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

await page.goto(`${origin}/gen/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
if (!await waitFor(() => !!window.__gplayerRef())) fail("studio did not boot");

// --- boot: pure scope scene — layer actions reflect reality ---
await page.evaluate(() => document.querySelector('#tabs button[data-tab="advanced"]').click());
await page.evaluate(() => document.querySelector('#adv-strip button[data-atab="layers"]').click());
const bootBtns = await page.evaluate(() => ({
    chips: document.querySelectorAll(".layer-chip").length,
    del: document.getElementById("btn-del-layer").disabled,
    up: document.getElementById("btn-up").disabled,
    down: document.getElementById("btn-down").disabled,
    dup: document.getElementById("btn-dup-layer").disabled
}));
if (bootBtns.chips !== 0) fail(`scope scene should show no chips, got ${bootBtns.chips}`);
if (!bootBtns.del || !bootBtns.up || !bootBtns.down) fail("del/up/down must be disabled on a single scene");
if (bootBtns.dup) fail("duplicate must stay enabled (wraps + copies)");

// --- Duplicate on a single scene wraps into a two-layer composite ---
await page.evaluate(() => document.getElementById("btn-dup-layer").click());
if (!await waitFor(() =>
    window.__gworking()?.scene?.type === "composite" &&
    window.__gworking().scene.layers.length === 2 &&
    window.__gworking().scene.layers[0].type === "scope" &&
    window.__gworking().scene.layers[1].type === "scope"
)) fail("duplicate on single scene did not wrap into [scope, copy]");

// --- chips render top-first; badges count from the top (1 = topmost) ---
const chips = await page.evaluate(() =>
    [...document.querySelectorAll(".layer-chip")].map(c => ({
        type: c.querySelector(".l-type")?.textContent,
        badge: c.querySelector(".l-order")?.textContent
    })));
if (chips.length !== 2 || chips[0].type !== "scope" || chips[1].type !== "scope") {
    fail(`unexpected chips: ${JSON.stringify(chips)}`);
}
if (chips[0].badge !== "1" || chips[1].badge !== "2") {
    fail(`top-first badges expected 1,2 got ${chips[0].badge},${chips[1].badge}`);
}
const onComposite = await page.evaluate(() => ({
    del: document.getElementById("btn-del-layer").disabled,
    up: document.getElementById("btn-up").disabled
}));
if (onComposite.del || onComposite.up) fail("del/up must enable on composites");

// --- scope layer editor routes to the Traces workspace ---
await page.evaluate(() => document.querySelectorAll(".layer-chip")[0].click());
if (!await waitFor(() => /Edit traces/i.test(document.getElementById("layer-editor")?.textContent || ""))) {
    fail("scope layer editor missing 'Edit traces' button");
}
const editorTitle = await page.evaluate(() => document.querySelector("#layer-editor h2")?.textContent);
if (!/layer 1/.test(editorTitle || "")) fail(`editor title should say layer 1 (topmost), got: ${editorTitle}`);

// --- Traces tab edits the selected scope layer, with a banner ---
await page.evaluate(() => document.querySelector('#tabs button[data-tab="traces"]').click());
if (!await waitFor(() => /waveform layer 1/.test(document.getElementById("pane-traces")?.textContent || ""))) {
    fail("traces banner should identify waveform layer 1");
}
const traceCards = await page.evaluate(() => document.querySelectorAll("#pane-traces .trace-card").length);
if (traceCards !== 3) fail(`expected 3 trace cards, got ${traceCards}`);

// add a trace: only the SELECTED scope layer grows
await page.evaluate(() => {
    [...document.querySelectorAll("#pane-traces button")]
        .find(b => b.textContent === "+ Add trace")?.click();
});
if (!await waitFor(() => window.__gworking().scene.layers[1].rows.filter(r => r.type === "trace").length === 4)) {
    fail("add-trace did not grow the selected scope layer");
}
const otherLayer = await page.evaluate(() =>
    window.__gworking().scene.layers[0].rows.filter(r => r.type === "trace").length);
if (otherLayer !== 3) fail(`sibling scope layer mutated (${otherLayer} traces)`);

// --- arrows: ↑ raises toward the top of the stack (index + 1) ---
await page.evaluate(() => document.querySelector('#tabs button[data-tab="advanced"]').click());
await page.evaluate(() => document.querySelector('#adv-strip button[data-atab="layers"]').click());
await page.evaluate(() => document.querySelectorAll(".layer-chip")[1].click());  // bottom scope (3 traces)
const descBefore = await page.evaluate(() =>
    document.querySelectorAll(".layer-chip")[1].querySelector(".l-desc")?.textContent);
await page.evaluate(() => document.getElementById("btn-up").click());
// raised layer is now the top of the stack: first chip, higher array index
// (closure vars are invisible inside evaluate — pass descBefore as arg)
async function waitForUp(desc) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const hit = await page.evaluate(d => {
            const c = [...document.querySelectorAll(".layer-chip")];
            return c[0]?.querySelector(".l-desc")?.textContent === d &&
                /4 traces/.test(c[1]?.querySelector(".l-desc")?.textContent || "");
        }, desc).catch(() => false);
        if (hit) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}
if (!await waitForUp(descBefore)) fail("btn-up did not raise the layer (top-first display)");
const arrOrder = await page.evaluate(() => window.__gworking().scene.layers.map(l =>
    l.rows.filter(r => r.type === "trace").length).join(","));
if (arrOrder !== "4,3") fail(`array order after raise expected 4,3 got ${arrOrder}`);

// --- type picker: themed classes (no inline hex), scope option present ---
await page.evaluate(() => document.getElementById("btn-add-layer").click());
if (!await waitFor(() => !!document.getElementById("type-picker"))) fail("type picker did not open");
const picker = await page.evaluate(() => {
    const card = document.querySelector("#type-picker .tp-card");
    const btns = [...document.querySelectorAll("#type-picker .tp-btn")];
    return {
        themed: !!card && !/#101010/.test(card.style.cssText),
        hasScope: btns.some(b => b.textContent.includes("scope")),
        desc: !!document.querySelector("#type-picker .tp-desc")
    };
});
if (!picker.themed) fail("type picker card not themed via CSS classes");
if (!picker.hasScope) fail("scope missing from type picker");
if (!picker.desc) fail("type picker descriptions not styled");

// new layer defaults to additive blending
await page.evaluate(() => {
    [...document.querySelectorAll("#type-picker .tp-btn")]
        .find(b => b.textContent.includes("particles"))?.click();
});
if (!await waitFor(() => window.__gworking().scene.layers[2]?.type === "particles")) {
    fail("particles layer not added");
}
const blend = await page.evaluate(() => window.__gworking().scene.layers[2].blend);
if (blend !== "add") fail(`new layer blend should default to "add", got ${blend}`);

// --- AI round-trip: copy prompt, paste a reply ---
await page.evaluate(() => document.querySelector('#adv-strip button[data-atab="math"]').click());
await page.evaluate(() => document.getElementById("btn-ai-prompt").click());
await new Promise(r => setTimeout(r, 400));
const copyStatus = await page.evaluate(() => document.getElementById("statusbar").textContent);
if (!/engine prompt copied|copy failed/i.test(copyStatus)) {
    fail(`AI copy handler did not report, got: ${copyStatus}`);
}

// paste: override prompt() so the flow is deterministic regardless of clipboard
await page.evaluate(() => {
    window.prompt = () =>
        "Here you go!\n```\nR: 0.5+0.5*sin(t*wobble)\nG: 0.5+0.5*sin(t*wobble)\nB: 0\n```";
});
await page.evaluate(() => document.getElementById("btn-ai-paste").click());
if (!await waitFor(() =>
    window.__gworking().scene.layers[3]?.type === "expression" &&
    window.__gworking().parameters?.wobble !== undefined
)) fail("AI paste did not insert an expression layer with adopted params");
const aiLayer = await page.evaluate(() => window.__gworking().scene.layers[3]);
if (aiLayer.r !== "0.5+0.5*sin(t*wobble)" || aiLayer.b !== "0") {
    fail(`AI layer equations wrong: ${JSON.stringify(aiLayer)}`);
}

// paste garbage → warn, no structural change
const layersBefore = await page.evaluate(() => window.__gworking().scene.layers.length);
await page.evaluate(() => { window.prompt = () => "no equations here, sorry"; });
await page.evaluate(() => document.getElementById("btn-ai-paste").click());
if (!await waitFor(() => /couldn't find R:\/G:\/B:/i.test(document.getElementById("statusbar").textContent))) {
    fail("garbage paste not reported");
}
const layersAfter = await page.evaluate(() => window.__gworking().scene.layers.length);
if (layersAfter !== layersBefore) fail("garbage paste mutated the scene");

await browser.close();
server.close();
console.log(`layers: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
if (failures) process.exit(1);

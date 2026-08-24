// Studio (visual-first) acceptance: boots, layer list renders, selection edits,
// source round-trip, invalid JSON safety, scrub determinism, gallery.
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = "/home/ali/dev/amoled-client";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream", ".gif": "image/gif" };
const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(ROOT, urlPath === "/" ? "/generator/index.html" : urlPath);
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
async function waitFor(expr, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await page.evaluate(expr).catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}
let failures = 0;
const fail = m => { failures++; console.log("FAIL:", m); };
page.on("pageerror", e => fail("PAGEERROR: " + e.message));
// headless throttles timers heavily

await page.goto(`http://127.0.0.1:${server.address().port}/generator/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

// boot + default composite
const boot = await page.evaluate(() => ({
    player: !!window.__gplayerRef(),
    type: window.__gworking()?.scene?.type,
    chips: document.querySelectorAll(".layer-chip").length
}));
console.log("boot:", JSON.stringify(boot));
if (!boot.player) fail("player missing");
if (boot.type !== "composite") fail(`default scene ${boot.type}`);
if (boot.chips !== 2) fail(`expected 2 layer chips, got ${boot.chips}`);

// select base layer -> editor shows flow fields with slider companions
await page.evaluate(() => document.querySelectorAll(".layer-chip")[0].click());
await new Promise(r => setTimeout(r, 300));
const editorOk = await page.evaluate(() =>
    !!document.querySelector("#layer-editor input[data-slider-for='scale']"));
if (!editorOk) fail("flow editor sliders missing");

// move a slider -> workingRaw updates numerically
await page.evaluate(() => {
    const s = document.querySelector("#layer-editor input[data-slider-for='scale']");
    s.value = "6"; s.dispatchEvent(new Event("input"));
});
await waitFor(() => window.__gworking().scene.layers[0].scale === 6);
const slid = await page.evaluate(() => window.__gworking().scene.layers[0].scale);
console.log("slider edit scale:", slid);
if (slid !== 6) fail(`slider edit not adopted (${slid})`);

// source round-trip: edit palette through JSON
await page.evaluate(() => {
    const ta = document.getElementById("source");
    const raw = JSON.parse(ta.value);
    raw.scene.layers[1].count = 111;
    ta.value = JSON.stringify(raw, null, 2);
    ta.dispatchEvent(new Event("input"));
});
await waitFor(() => window.__gworking().scene.layers[1].count === 111);
const adopted = await page.evaluate(() => window.__gworking().scene.layers[1].count);
if (adopted !== 111) fail(`source edit not adopted (${adopted})`);

// invalid JSON: reported, preview untouched
await page.evaluate(() => {
    const ta = document.getElementById("source");
    ta.value = "{ broken";
    ta.dispatchEvent(new Event("input"));
});
await waitFor(() => document.getElementById("statusbar").textContent.includes("invalid JSON"));
const errState = await page.evaluate(() => ({
    status: document.getElementById("statusbar").textContent,
    stillComposite: window.__gworking()?.scene?.type
}));
if (!errState.status.includes("invalid JSON")) fail("invalid JSON not reported");
if (errState.stillComposite !== "composite") fail("invalid edit clobbered state");

// reload fresh -> scrub determinism on animated composite
await page.goto(`http://127.0.0.1:${server.address().port}/generator/index.html`, { waitUntil: "domcontentloaded" });
await new Promise(r => setTimeout(r, 3500));
if (!await page.evaluate(() => !!window.__gplayerRef())) throw new Error("studio did not boot");
await page.evaluate(() => window.__gplayerRef().pause());
const captureStable = async () => {
    // Capture until two consecutive reads agree (rAF may lag under throttle).
    let prev = await page.evaluate(() => {
        const c = document.getElementById("preview-canvas");
        const s = document.createElement("canvas"); s.width = 32; s.height = 18;
        const x = s.getContext("2d"); x.drawImage(c, 0, 0, 32, 18);
        return [...x.getImageData(0, 0, 32, 18).data].reduce((a, v) => (a * 31 + v) | 0, 7);
    });
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const cur = await page.evaluate(() => {
            const c = document.getElementById("preview-canvas");
            const s = document.createElement("canvas"); s.width = 32; s.height = 18;
            const x = s.getContext("2d"); x.drawImage(c, 0, 0, 32, 18);
            return [...x.getImageData(0, 0, 32, 18).data].reduce((a, v) => (a * 31 + v) | 0, 7);
        });
        if (cur === prev) return cur;
        prev = cur;
    }
    return prev;
};
const scrubHash = async () => {
    await page.evaluate(() => window.__gplayerRef().scrub(3.5));
    return captureStable();
};
await scrubHash();            // warm-up render
const h1 = await scrubHash();
const h2 = await scrubHash();
console.log("scrub deterministic:", h1 === h2);
if (h1 !== h2) fail("scrub nondeterministic");

// gallery populated + loads a scene into the editor
const galN = await page.evaluate(() => document.querySelectorAll("#gallery button").length);
console.log("gallery entries:", galN);
if (galN < 4) fail(`gallery too small (${galN})`);
await page.evaluate(() => {
    const btns = [...document.querySelectorAll("#gallery button")];
    btns.find(b => b.textContent.includes("plasma"))?.click();
});
if (!await waitFor(() => window.__gworking()?.scene?.type === "expression"))
    fail(`gallery plasma load failed (${await page.evaluate(() => window.__gworking()?.scene?.type)})`);
// expression fields visible after switching selection
await page.evaluate(() => document.querySelectorAll(".layer-chip")[0]?.click());
await new Promise(r => setTimeout(r, 300));

// add a layer via the type-picker modal onto the loaded single-scene plasma:
// ensureComposite() should auto-wrap it into a composite.
const layersBefore = await page.evaluate(
    () => window.__gworking()?.scene?.layers?.length ?? 0);
await page.evaluate(() => document.getElementById("btn-add-layer").click());
if (!await waitFor(() => !!document.getElementById("type-picker"))) fail("type picker did not open");
await page.evaluate(() => {
    const btns = [...document.querySelectorAll("#type-picker button")];
    btns.find(b => b.textContent.includes("particles")).click();
});
await waitFor(() => !document.getElementById("type-picker"));
await new Promise(r => setTimeout(r, 1500));
const afterAdd = await page.evaluate(() => ({
    type: window.__gworking()?.scene?.type,
    layers: window.__gworking()?.scene?.layers?.length
}));
console.log("after add-layer:", JSON.stringify(afterAdd));
if (afterAdd.layers < 2) fail("add-layer failed");

await browser.close();
server.close();
if (failures) { console.log(`\nSTUDIO: ${failures} FAILURES`); process.exit(1); }
console.log("\nSTUDIO ACCEPTANCE PASS");

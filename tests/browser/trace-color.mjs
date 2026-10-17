// Trace color + emitter-channel acceptance: the color popover edits any
// color (hex + SV square + presets), ordinary traces render their full
// color, channel binding is opt-in in More with a missing-component
// warning, and colors round-trip to the Source pane / export JSON.
// Single page load (reload crashes under SwiftShader headless — see studio.mjs).
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const ROOT = "/home/ali/dev/amoled-client";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".amo": "application/octet-stream" };
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
    defaultViewport: { width: 900, height: 760 }
});
const page = await browser.newPage();
let failures = 0;
const fail = m => { failures++; console.log("FAIL:", m); };
page.on("pageerror", e => fail("PAGEERROR: " + e.message));

async function waitFor(expr, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await page.evaluate(expr).catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 150));
    }
    return false;
}
async function waitUntil(fn, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn().catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

await page.goto(`http://127.0.0.1:${server.address().port}/gen/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
if (!await waitFor(() => !!window.__gplayerRef())) fail("studio did not boot");

// --- boot scene: three-phase, all traces unbound (color != channel) ---
const boot = await page.evaluate(() => {
    const rows = window.__gworking().scene.rows.filter(r => r.type === "trace");
    return rows.map(r => ({ name: r.name, color: r.color, channel: r.channel ?? null }));
});
if (boot.length !== 3) fail(`expected 3 boot traces, got ${boot.length}`);
if (boot.some(r => r.channel !== null)) fail(`boot traces must be unbound: ${JSON.stringify(boot)}`);
if (boot[0].color !== "#ff0000") fail(`boot trace 1 color ${boot[0].color}`);

// --- rendered pixels change when an unbound trace gets a non-RGB color ---
async function meanRGB() {
    return page.evaluate(() => {
        const src = document.getElementById("preview-canvas");
        const probe = document.createElement("canvas");
        probe.width = 64; probe.height = 48;
        const ctx = probe.getContext("2d");
        ctx.drawImage(src, 0, 0, 64, 48);
        const d = ctx.getImageData(0, 0, 64, 48).data;
        let r = 0, g = 0, b = 0, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
            const l = d[i] + d[i + 1] + d[i + 2];
            if (l > 24) { r += d[i]; g += d[i + 1]; b += d[i + 2]; lit++; }
        }
        return lit ? { r: r / lit, g: g / lit, b: b / lit, lit } : { r: 0, g: 0, b: 0, lit: 0 };
    });
}
// Isolate trace 1 (pure red, unbound) so the aggregate pixel means are
// attributable: a bound-vs-unbound difference would vanish if G/B traces
// still painted the canvas.
await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#pane-traces .trace-card")];
    cards[1].querySelector(".trace-enable").click();
    cards[2].querySelector(".trace-enable").click();
});
if (!await waitUntil(async () => (await meanRGB()).g < 6)) {
    fail("disabling the G/B traces did not take effect");
}
const before = await meanRGB();
if (!(before.lit > 10 && before.r > 6 && before.g < 5 && before.b < 5)) {
    fail(`pure-red trace should light only R (${JSON.stringify(before)})`);
}

// --- popover: open on the first trace swatch ---
await page.click("#pane-traces .trace-card .trace-swatch");
if (!await waitFor(() => {
    const p = document.querySelector(".cp-panel");
    return p && !p.hidden;
})) fail("color popover did not open");

// hex path: #ffb454 (amber — strong R+G, weak B)
await page.evaluate(() => {
    const h = document.querySelector(".cp-hex");
    h.value = "#ffb454";
    h.dispatchEvent(new Event("input", { bubbles: true }));
});
if (!await waitFor(() => window.__gworking().scene.rows[0].color === "#ffb454")) {
    fail("hex edit did not reach the model");
}
if (await page.evaluate(() => document.querySelector(".cp-hex").value) !== "#ffb454") {
    fail("hex field did not keep the edited value");
}
if (!await waitUntil(async () => (await meanRGB()).g > 15)) {
    fail("amber trace does not light the G channel (still red-only?)");
}
const amber = await meanRGB();
if (!(amber.r > 6 && amber.g > amber.b * 1.5)) {
    fail(`amber trace should light R+G over B (before ${JSON.stringify(before)}, after ${JSON.stringify(amber)})`);
}

// source pane / export JSON retains the hex
if (!await waitFor(() => document.getElementById("source").value.includes("#ffb454"))) {
    fail("source pane does not retain the hex color");
}

// SV square drag: color must move away from amber (picked off the square)
const svBox = await page.evaluate(() => {
    const r = document.querySelector(".cp-sv").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
});
await page.mouse.move(svBox.x + svBox.w * 0.75, svBox.y + svBox.h * 0.5);
await page.mouse.down();
await page.mouse.move(svBox.x + svBox.w * 0.9, svBox.y + svBox.h * 0.75, { steps: 4 });
await page.mouse.up();
if (!await waitFor(() => window.__gworking().scene.rows[0].color !== "#ffb454")) {
    fail("SV drag did not change the color");
}
const hexAfterDrag = await page.evaluate(() => document.querySelector(".cp-hex").value);
if (hexAfterDrag !== await page.evaluate(() => window.__gworking().scene.rows[0].color)) {
    fail("hex field out of sync with model after SV drag");
}

// preset click: exact hex lands in the model
await page.evaluate(() => {
    [...document.querySelectorAll(".cp-preset")].find(b => b.title === "#4fd6e0").click();
});
if (!await waitFor(() => window.__gworking().scene.rows[0].color === "#4fd6e0")) {
    fail("preset click did not apply #4fd6e0");
}

// Esc closes the popover
await page.keyboard.press("Escape");
if (!await waitFor(() => document.querySelector(".cp-panel").hidden)) fail("Esc did not close the popover");

// --- added traces: palette color, unbound ---
await page.evaluate(() => {
    [...document.querySelectorAll("#pane-traces button")].find(b => b.textContent.includes("Add trace")).click();
});
if (!await waitFor(() => window.__gworking().scene.rows.filter(r => r.type === "trace").length === 4)) {
    fail("add trace did not append a row");
}
const added = await page.evaluate(() => {
    const r = window.__gworking().scene.rows[3];
    return { color: r.color, channel: r.channel ?? null, name: r.name };
});
if (added.channel !== null) fail(`added trace must be unbound (got ${added.channel})`);
if (added.color !== "#ffb454") fail(`added trace should take the first palette color (got ${added.color})`);

// --- channel binding: opt-in in More, warning when the color lacks it ---
const moreOpened = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#pane-traces .trace-card")];
    cards[1].querySelector(".more-wrap").open = true;
    const sel = [...cards[1].querySelectorAll(".trace-body select")]
        .find(s => s.closest("label")?.textContent.startsWith("Emitter channel"));
    if (!sel) return null;
    sel.value = "b";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
});
if (!moreOpened) fail("emitter channel select missing from More");
if (!await waitFor(() => window.__gworking().scene.rows[1].channel === "b")) {
    fail("channel binding did not reach the model");
}
if (!await waitFor(() => {
    const w = document.querySelector("#pane-traces .ch-warn");
    return w && /no B/i.test(w.textContent);
})) fail("missing-component warning not shown for green trace bound to B");

// unbinding removes channel + warning
await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#pane-traces .trace-card")];
    cards[1].querySelector(".more-wrap").open = true;
    const sel = [...cards[1].querySelectorAll(".trace-body select")]
        .find(s => s.closest("label")?.textContent.startsWith("Emitter channel"));
    sel.value = "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
});
if (!await waitFor(() => window.__gworking().scene.rows[1].channel === undefined)) {
    fail("unbinding did not remove the channel key");
}
if (!await waitFor(() => !document.querySelector("#pane-traces .ch-warn"))) {
    fail("warning still present after unbinding");
}

// --- export JSON retains the color; re-import restores it ---
// (values must live page-side: puppeteer serializes the callback, so Node
// closure variables are not visible inside waitFor's expression)
const round = await page.evaluate(() => {
    const src = document.getElementById("source");
    const color = window.__gworking().scene.rows[0].color;
    return { color, json: src.value, kept: src.value.includes(color) };
});
if (!round.kept) fail(`export/source JSON lost the color ${round.color}`);
await page.evaluate((j, c) => {
    window.__roundColor = c;
    const src = document.getElementById("source");
    src.value = j;
    src.dispatchEvent(new Event("input", { bubbles: true }));
}, round.json, round.color);
if (!await waitFor(() => window.__gworking().scene.rows[0].color === window.__roundColor)) {
    fail("re-parsing the export JSON lost the trace color");
}

await browser.close();
server.close();
if (failures) {
    console.log(`\nTRACE-COLOR: ${failures} FAILURES`);
    process.exit(1);
} else {
    console.log("TRACE-COLOR ACCEPTANCE PASS");
}

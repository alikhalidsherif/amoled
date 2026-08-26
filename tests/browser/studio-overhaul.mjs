// Studio overhaul acceptance (PLAN_GENERATOR_OVERHAUL.md §6/§8/§22/§23):
// Desmos-style expression editing, parameter panel sliders, new primitive
// types in the type picker, transport extras, pixel inspector.
// Single page load (reload crashes under SwiftShader headless — see studio.mjs).

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

await page.goto(`http://127.0.0.1:${server.address().port}/generator/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

if (!await waitFor(() => !!window.__gplayerRef())) fail("studio did not boot");

// --- load the three-phase example through the Source pane ---
await page.evaluate(async () => {
    const res = await fetch("../scenes/three-phase.amo");
    const raw = JSON.parse(await res.text());
    document.getElementById("source").value = JSON.stringify(raw, null, 2);
    document.getElementById("source").dispatchEvent(new Event("input"));
});
if (!await waitFor(() => window.__gworking()?.parameters?.omega !== undefined)) {
    fail("parameterized scene did not adopt");
}

// --- parameters panel renders a slider row ---
const paramRows = await page.evaluate(() => document.querySelectorAll("#param-list .param-row").length);
if (paramRows !== 1) fail(`expected 1 param row, got ${paramRows}`);

// slider drag updates working value + preview adopts
await page.evaluate(() => {
    const s = document.querySelector("#param-list input[type=range]");
    s.value = "6";
    s.dispatchEvent(new Event("input"));
});
if (!await waitFor(() => window.__gworking()?.parameters?.omega?.value === 6)) {
    fail("param slider edit not adopted");
}

// add + delete a parameter
await page.evaluate(() => document.getElementById("btn-add-param").click());
if (!await waitFor(() => Object.keys(window.__gworking().parameters).length === 2)) {
    fail("add-parameter failed");
}
await page.evaluate(() => {
    document.querySelector("#param-list .pdel").click();
});
if (!await waitFor(() => Object.keys(window.__gworking().parameters || {}).length === 1)) {
    fail("delete-parameter failed");
}

// --- type picker lists the new primitives ---
await page.evaluate(() => document.getElementById("btn-add-layer").click());
if (!await waitFor(() => !!document.getElementById("type-picker"))) fail("type picker did not open");
const pickerText = await page.evaluate(() =>
    [...document.querySelectorAll("#type-picker button")].map(b => b.textContent).join("|"));
for (const t of ["shape", "conicGradient", "waves"]) {
    if (!pickerText.includes(t)) fail(`type picker missing "${t}"`);
}
// add a waves layer via the picker
await page.evaluate(() => {
    [...document.querySelectorAll("#type-picker button")].find(b => b.textContent.includes("waves")).click();
});
if (!await waitFor(() => {
    const w = window.__gworking();
    return w.scene.type === "composite" && w.scene.layers.some(l => l.type === "waves");
})) fail("waves layer was not added");
// conditional field editor rendered (wavelength slider visible)
const hasWavelength = await page.evaluate(() =>
    [...document.querySelectorAll("#layer-editor label")].some(l => l.textContent.includes("Wavelength")));
if (!hasWavelength) fail("waves editor missing wavelength field");

// --- expression editor: highlight layer, inline error, autocomplete ---
await page.evaluate(async () => {
    const res = await fetch("../scenes/plasma.amo");
    const raw = JSON.parse(await res.text());
    document.getElementById("source").value = JSON.stringify(raw, null, 2);
    document.getElementById("source").dispatchEvent(new Event("input"));
});
if (!await waitFor(() => !!document.querySelector(".expr-wrap textarea"))) {
    fail("expression editor wrap not created");
} else {
    // typing an invalid expression surfaces the parser message
    await page.evaluate(() => {
        const ta = document.querySelector(".expr-wrap textarea");
        ta.value = "sin(";
        ta.dispatchEvent(new Event("input"));
    });
    if (!await waitFor(() => (document.querySelector(".expr-err")?.textContent || "").length > 3)) {
        fail("inline expression error not shown");
    }
    // autocomplete suggests functions while typing
    await page.evaluate(() => {
        const ta = document.querySelector(".expr-wrap textarea");
        ta.value = "0.5 + 0.5*si";
        ta.dispatchEvent(new Event("input"));
    });
    if (!await waitFor(() => {
        const items = [...document.querySelectorAll(".ac-item")].map(e => e.textContent);
        return items.some(t => t.startsWith("sin"));
    })) fail("autocomplete did not suggest sin");
    // accept suggestion -> valid expression adopted into workingRaw
    await page.evaluate(() => {
        const item = [...document.querySelectorAll(".ac-item")].find(e => e.textContent.startsWith("sin"));
        item.click();
    });
    if (!await waitFor(() => {
        const r = window.__gworking()?.scene?.r;
        return typeof r === "string" && r.includes("sin");
    })) fail("autocomplete acceptance did not adopt");
}

// --- transport: restart scrubs to 0 ---
// Pause via one UI button click so the studio's internal playing flag
// stays in sync (restart resumes only when the flag says it was playing).
// The scene autoplays on boot, so a single click pauses.
await page.evaluate(() => document.getElementById("btn-play").click());
await page.evaluate(() => window.__gplayerRef().scrub(3));
await new Promise(r => setTimeout(r, 400));
await page.evaluate(() => document.getElementById("btn-restart").click());
const tAfterRestart = await page.evaluate(() => window.__gplayerRef().getTime());
if (!(tAfterRestart < 0.2)) fail(`restart did not scrub to 0 (t=${tAfterRestart})`);

// frame stepping moves time by exactly 1/fps
await page.evaluate(() => document.getElementById("btn-step-fwd").click());
const tStepped = await page.evaluate(() => window.__gplayerRef().getTime());
const expectedStep = 1 / 30;
if (Math.abs(tStepped - expectedStep) > 0.01) fail(`frame step wrong: ${tStepped}`);

// speed selector reaches the player
await page.evaluate(() => {
    const sel = document.getElementById("f-speed");
    sel.value = "0.5";
    sel.dispatchEvent(new Event("change"));
});
const rate = await page.evaluate(() => window.__gplayerRef().runtime.getPlaybackRate());
if (rate !== 0.5) fail(`playback rate not applied (${rate})`);

// --- pixel inspector responds to hover ---
await page.evaluate(() => {
    const shell = document.getElementById("shell");
    const r = shell.getBoundingClientRect();
    shell.dispatchEvent(new PointerEvent("pointermove", {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: "mouse"
    }));
});
if (!await waitFor(() => document.getElementById("inspector").style.display === "block")) {
    fail("pixel inspector did not appear on hover");
} else {
    const txt = await page.evaluate(() => document.getElementById("inspector").textContent);
    if (!/x 0\.\d{3}/.test(txt)) fail(`inspector content unexpected: ${txt}`);
}

// --- forgiving editing: incomplete expressions hold the preview, not fail ---
// Load lissajous (curve scene) and clear the y(p) equation via the editor.
await page.evaluate(async () => {
    const res = await fetch("../scenes/lissajous.amo");
    const raw = JSON.parse(await res.text());
    document.getElementById("source").value = JSON.stringify(raw, null, 2);
    document.getElementById("source").dispatchEvent(new Event("input"));
});
if (!await waitFor(() => window.__gworking()?.scene?.type === "curve")) fail("lissajous did not adopt");
await page.evaluate(async () => {
    const res = await fetch("../scenes/three-phase.amo");   // keep a valid scene loaded for hold-check
    const raw = JSON.parse(await res.text());
    document.getElementById("source").value = JSON.stringify(raw, null, 2);
    document.getElementById("source").dispatchEvent(new Event("input"));
});
if (!await waitFor(() => window.__gworking()?.scene?.r !== undefined)) fail("three-phase did not adopt");

// Now break it: type an incomplete expression into the r channel.
await page.evaluate(() => {
    const ta = document.querySelector(".expr-wrap textarea");
    ta.value = "0.5 + 0.5*si";
    ta.dispatchEvent(new Event("input"));
});
if (!await waitFor(() => document.getElementById("statusbar").textContent.includes("still typing"))) {
    fail(`incomplete expression not reported gently: ${await page.evaluate(() => document.getElementById("statusbar").textContent)}`);
}
// preview must still hold a valid scene (not torn down)
const heldType = await page.evaluate(() => window.__gplayerRef().runtime.definitionRef.scene.type);
if (heldType !== "expression") fail(`preview did not hold last valid scene (${heldType})`);

// finishing the expression recovers automatically
await page.evaluate(() => {
    const ta = document.querySelector(".expr-wrap textarea");
    ta.value = "0.5 + 0.5*sin(omega*tau*t)";
    ta.dispatchEvent(new Event("input"));
});
if (!await waitFor(() => document.getElementById("statusbar").textContent.includes("valid"))) {
    fail("completing the expression did not recover");
}

// --- pure math sheet mode (Desmos-style) ---
await page.evaluate(() => {
    [...document.querySelectorAll("#tabs button")].find(b => b.dataset.tab === "math").click();
});
if (!await waitFor(() => document.querySelectorAll("#math-sheet .math-card").length === 1)) {
    fail("math sheet did not render a card for the expression scene");
}
// edit the G equation through the math sheet
await page.evaluate(() => {
    const gRow = document.querySelectorAll("#math-sheet .ch-row")[1];
    const ta = gRow.querySelector("textarea");
    ta.value = "0.5 + 0.5*sin(y*4 - t)";
    ta.dispatchEvent(new Event("input"));
});
if (!await waitFor(() => window.__gworking()?.scene?.g === "0.5 + 0.5*sin(y*4 - t)")) {
    fail("math sheet G equation edit not adopted");
}
// add a second color field -> composite of two expression layers
await page.evaluate(() => document.getElementById("btn-add-field").click());
if (!await waitFor(() =>
    window.__gworking()?.scene?.type === "composite" &&
    window.__gworking().scene.layers.length === 2
)) fail("add color field failed");
if (!await waitFor(() => document.querySelectorAll("#math-sheet .math-card").length === 2)) {
    fail("math sheet did not show the second card");
}
// variables: add one, it appears in the math sheet (three-phase already
// declares omega, so the sheet must show existing + new)
await page.evaluate(() => document.getElementById("btn-add-var").click());
if (!await waitFor(() => {
    const rows = document.querySelectorAll("#math-vars .param-row").length;
    const params = Object.keys(window.__gworking()?.parameters || {}).length;
    return rows === params && rows >= 2;
})) {
    fail("math-sheet variable rows did not track parameters");
}
// duration edits the timeline
await page.evaluate(() => {
    const d = document.getElementById("math-duration");
    d.value = "12";
    d.dispatchEvent(new Event("input"));
});
if (!await waitFor(() => window.__gworking()?.timeline?.duration === 12)) {
    fail("math duration not adopted into timeline");
}

await browser.close();
server.close();
if (failures) { console.log(`\nSTUDIO-OVERHAUL: ${failures} FAILURES`); process.exit(1); }
console.log("\nSTUDIO-OVERHAUL ACCEPTANCE PASS");

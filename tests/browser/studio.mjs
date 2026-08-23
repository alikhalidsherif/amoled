// Studio acceptance: boots, loads default scene, source edits round-trip,
// scrub API works, gallery buttons appear.
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
let failures = 0;
const fail = m => { failures++; console.log("FAIL:", m); };
page.on("pageerror", e => fail("PAGEERROR: " + e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/generator/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

// player booted with the default livingGradient
const booted = await page.evaluate(() => ({
    hasPlayer: !!window.__gplayerRef(),
    defType: window.__gplayerRef()?.runtime?.definitionRef?.scene?.type
}));
console.log("boot:", JSON.stringify(booted));
if (!booted.hasPlayer) fail("player missing");
if (booted.defType !== "livingGradient") fail(`default scene type ${booted.defType}`);

// source edit round-trip: replace scene with a flow field via the textarea
await page.evaluate(() => {
    const ta = document.getElementById("source");
    const raw = JSON.parse(ta.value);
    raw.scene = { type: "flow", palette: ["#000000", "#00ff00"], scale: 5, speed: 0.3, warp: 0.5, seed: 1 };
    ta.value = JSON.stringify(raw, null, 2);
    ta.dispatchEvent(new Event("input"));
});
await new Promise(r => setTimeout(r, 4000));
const afterEdit = await page.evaluate(() => ({
    type: window.__gplayerRef()?.runtime?.definitionRef?.scene?.type,
    static: window.__gplayerRef()?.runtime?.definitionRef?.isStatic
}));
console.log("after source edit:", JSON.stringify(afterEdit));
if (afterEdit.type !== "flow") fail("source edit did not adopt flow scene");

// invalid JSON keeps preview alive and reports error
await page.evaluate(() => {
    const ta = document.getElementById("source");
    ta.value = "{ not json";
    ta.dispatchEvent(new Event("input"));
});
await new Promise(r => setTimeout(r, 4000));
const errState = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    stillFlow: window.__gplayerRef()?.runtime?.definitionRef?.scene?.type
}));
if (!errState.status.includes("invalid JSON")) fail("invalid JSON not reported");
if (errState.stillFlow !== "flow") fail("invalid edit clobbered preview");

// scrub API determinism: reload fresh, then same t twice -> identical hash
await page.goto(`http://127.0.0.1:${server.address().port}/generator/index.html`, { waitUntil: "domcontentloaded" });
await new Promise(r => setTimeout(r, 2500));
if (!await page.evaluate(() => !!window.__gplayerRef)) throw new Error("studio did not boot");
// pause first so background animation cannot race the capture
await page.evaluate(() => window.__gplayerRef().pause());
const scrub = async () => {
    await page.evaluate(() => window.__gplayerRef().scrub(2.5));
    await new Promise(r => setTimeout(r, 250));   // let renderer rAF settle
    return page.evaluate(() => {
        const c = document.getElementById("preview-canvas");
        const s = document.createElement("canvas"); s.width = 32; s.height = 18;
        const x = s.getContext("2d"); x.drawImage(c, 0, 0, 32, 18);
        return [...x.getImageData(0, 0, 32, 18).data].reduce((a, v) => (a * 31 + v) | 0, 7);
    });
};
const h1 = await scrub();
const h2 = await scrub();
console.log("scrub deterministic:", h1 === h2);
if (h1 !== h2) fail(`scrub nondeterministic (${h1} vs ${h2})`);
if (!h1 && h1 !== 0) fail("scrub produced nothing");

// gallery populated
const galleryN = await page.evaluate(() => document.querySelectorAll("#gallery button").length);
console.log("gallery entries:", galleryN);
if (galleryN < 5) fail(`gallery too small (${galleryN})`);

await browser.close();
server.close();
if (failures) { console.log(`\nSTUDIO: ${failures} FAILURES`); process.exit(1); }
console.log("\nSTUDIO ACCEPTANCE PASS");

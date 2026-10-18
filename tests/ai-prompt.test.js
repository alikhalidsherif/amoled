// AI round-trip (PLAN_ADVANCED_MATH_POLISH.md §5): the engine prompt must
// teach the coordinate reality (u,v vs x,y) and the R:/G:/B: reply format;
// parseAIReply must recover expressions from realistic bot replies.
import { ENGINE_PROMPT, parseAIReply } from "../src/scene/ai-prompt.js";
import { parseAmo } from "../src/scene/parser.js";

let passed = 0, failed = 0;
function ok(cond, name) {
    if (cond) { passed++; }
    else { failed++; console.log("FAIL:", name); }
}

// --- prompt contract ---
ok("prompt: teaches u,v as normalized, x,y as pixels", () => {
    if (!/u,\s*v.*normalized/i.test(ENGINE_PROMPT)) throw new Error("no u,v normalized note");
    if (!/PIXEL/i.test(ENGINE_PROMPT)) throw new Error("no pixel-coordinates warning");
});
ok("prompt: demands exactly three R:/G:/B: lines", () => {
    if (!/^R:/m.test(ENGINE_PROMPT) || !/^G:/m.test(ENGINE_PROMPT) || !/^B:/m.test(ENGINE_PROMPT)) {
        throw new Error("output format block missing channel lines");
    }
});
ok("prompt: lists available functions and constants", () => {
    for (const name of ["sin", "cos", "atan2", "smoothstep", "noise", "pi", "tau"]) {
        if (!ENGINE_PROMPT.includes(name)) throw new Error(`missing ${name}`);
    }
});
ok("prompt: mentions aspect-correction for circles", () => {
    if (!/width\/height/.test(ENGINE_PROMPT)) throw new Error("no aspect factor note");
});
ok("prompt: warns against reserved names so params adopt cleanly", () => {
    if (!/reserved/i.test(ENGINE_PROMPT)) throw new Error("no reserved-names note");
});

// --- parser: clean triple ---
ok("parse: clean three-line reply", () => {
    const p = parseAIReply("R: 0.5+0.5*sin(t)\nG: 0.4\nB: 0.2");
    if (!p || p.r !== "0.5+0.5*sin(t)" || p.g !== "0.4" || p.b !== "0.2") {
        throw new Error(JSON.stringify(p));
    }
});

// --- parser: code fences + prose ---
ok("parse: reply wrapped in a code fence with prose", () => {
    const p = parseAIReply(
        "Sure! Here you go:\n```js\nR: u\nG: v\nB: 0\n```\nLet me know if you want it animated.");
    if (!p || p.r !== "u" || p.g !== "v" || p.b !== "0") throw new Error(JSON.stringify(p));
});

// --- parser: R= style and bold markers ---
ok("parse: R= / **G**: styles", () => {
    const p = parseAIReply("R = 1\n**G**: 0.5\nB= 0.25");
    if (!p || p.r !== "1" || p.g !== "0.5" || p.b !== "0.25") throw new Error(JSON.stringify(p));
});

// --- parser: single line → all channels ---
ok("parse: lone channel applies to all three", () => {
    const p = parseAIReply("R: 0.5+0.5*sin(t*2)");
    if (!p || p.r !== "0.5+0.5*sin(t*2)" || p.g !== p.r || p.b !== p.r) {
        throw new Error(JSON.stringify(p));
    }
});

// --- parser: rejects garbage ---
ok("parse: prose without channels → null", () => {
    if (parseAIReply("I cannot help with that.") !== null) throw new Error("accepted prose");
});
ok("parse: empty → null", () => {
    if (parseAIReply("") !== null || parseAIReply(null) !== null) throw new Error("accepted empty");
});
ok("parse: only two channels → null", () => {
    if (parseAIReply("R: u\nG: v") !== null) throw new Error("accepted partial triple");
});

// --- round-trip: a prompt-shaped answer must validate as an .amo scene ---
ok("round-trip: parsed reply validates through parseAmo", () => {
    const p = parseAIReply(
        "R: 1/(1+exp(400*((u-0.5)*(u-0.5)*(width/height)*(width/height)+(v-0.5)*(v-0.5)-0.04)))\n" +
        "G: 1/(1+exp(400*((u-0.5)*(u-0.5)*(width/height)*(width/height)+(v-0.5)*(v-0.5)-0.04)))\n" +
        "B: 0");
    if (!p) throw new Error("parse failed");
    const def = parseAmo({ amo: 1, scene: { type: "expression", ...p } }).definition;
    if (def.scene.type !== "expression") throw new Error("scene type lost");
});

console.log(`ai-prompt: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

// AI round-trip support for the studio Math pane
// (PLAN_ADVANCED_MATH_POLISH.md §5).
//
// The "copy AI prompt" button hands this exact text to any chat bot; the
// bot's reply is parsed back by parseAIReply() and inserted as an equation
// group. DOM-free on purpose: node tests verify the prompt contract and
// the parser against realistic replies.

/**
 * Paste-ready engine prompt. Keep it self-contained — it is the entire
 * context the bot gets. The output-format block at the end is what
 * parseAIReply() expects back.
 */
export const ENGINE_PROMPT = `You write color equations for an AMOLED pixel-matrix engine.
Each equation is evaluated once per pixel and returns that pixel's channel
brightness. You will be given a request (a shape, an animation, a look) and
must reply with three equations — one per color channel.

COORDINATES (critical, get this wrong and the screen is black):
- u, v   normalized position 0..1 (u left→right, v top→bottom)
- x, y   PIXEL coordinates (0..width, 0..height) — NOT normalized
- width, height   canvas size in pixels; canvases are usually wider than
  tall, so multiply horizontal distances by (width/height) to keep shapes
  circular:  dx = (u-cx)*(width/height),  dy = (v-cy)
- t       time in seconds (loops over the scene duration)
- frame, seed, progress also exist (progress = t/duration, 0..1)

OUTPUT: each equation returns 0..1 (0 = black, 1 = full brightness);
out-of-range values are clamped. R, G, B are independent channels — write
the same equation in all three for white, or only in R for red.

AVAILABLE: sin cos tan asin acos atan atan2 abs sqrt pow min max floor ceil
fract mod clamp mix lerp smoothstep step exp log sign distance(x1,y1,x2,y2)
length(x,y) noise(x,y) — constants pi, tau (=2pi), e.
No statements, no assignments, no if/else keywords (the ternary
"cond ? a : b" works). One expression per channel.

PARAMETERS: any invented name (cx, speed, amp...) automatically becomes a
slidable parameter — use descriptive names instead of burying magic
numbers. Do not use these reserved names: x y t u v frame width height
seed progress p pi tau e and the function names.

STYLE NOTES:
- Soft edges read better on a subpixel matrix: prefer
  1/(1+exp(k*(d2-r*r))) (k≈300-500) over hard (d2<r*r) tests.
- Animate with t: cx = 0.5+0.3*cos(t), brightness pulses with
  0.5+0.5*sin(t*2), travel with fract(u*count - t*speed).

REPLY FORMAT — exactly three lines, no commentary, no code fences:
R: <expression>
G: <expression>
B: <expression>`;

/**
 * Parse a bot reply into {r,g,b} channel expressions.
 * Tolerates code fences, "R ="/"**R**:" styles, blank lines and prose
 * around the three lines. A lone channel line is treated as "same on all
 * channels" (a common bot shortcut). Returns null when nothing usable.
 */
export function parseAIReply(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    // Drop fenced code blocks' fences but keep their contents.
    let s = text.replace(/```[a-zA-Z]*\n?/g, "\n").replace(/```/g, "");
    const found = {};
    for (const line of s.split(/\r?\n/)) {
        const m = /^\s*\**\s*([rgbRGB])\s*[:=]\s*\**\s*(.+?)\s*$/.exec(line);
        if (m && !(m[1].toLowerCase() in found)) {
            found[m[1].toLowerCase()] = m[2].trim();
        }
    }
    const keys = Object.keys(found);
    if (keys.length === 0) return null;
    // One channel given → treat as identical across R/G/B.
    if (keys.length === 1) {
        const v = found[keys[0]];
        if (!v) return null;
        return { r: v, g: v, b: v };
    }
    if (!("r" in found && "g" in found && "b" in found)) return null;
    if (!found.r || !found.g || !found.b) return null;
    return { r: found.r, g: found.g, b: found.b };
}

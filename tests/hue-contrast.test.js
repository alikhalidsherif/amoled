// Accent contrast guarantee (docs/PLAN_UI_UX_OVERHAUL.md §2.1, §7):
// the drifting accent is oklch(65% 0.14 var(--h)) for every hue; near-black
// ink (#0a0a0c) must stay >= 4.5:1 against it at all times, covering both
// "accent text on dark" (same numbers) and "dark text on an accent fill".
import assert from "node:assert";

let passed = 0;
let failed = 0;
function ok(cond, name) {
    if (cond) { passed++; }
    else { failed++; console.log("FAIL:", name); }
}

// --- sRGB <-> linear ---
function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(rgb255) {
    return 0.2126 * srgbToLinear(rgb255[0] / 255)
        + 0.7152 * srgbToLinear(rgb255[1] / 255)
        + 0.0722 * srgbToLinear(rgb255[2] / 255);
}
function contrast(y1, y2) {
    const hi = Math.max(y1, y2), lo = Math.min(y1, y2);
    return (hi + 0.05) / (lo + 0.05);
}

// --- OKLab/OKLCH -> linear sRGB (CSS Color 4 spec) ---
function oklchToLinearSrgb(L, C, hDeg) {
    const h = hDeg * Math.PI / 180;
    const a = C * Math.cos(h), b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
}
function linearToSrgb255(lin) {
    const c = lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

const ACCENT_L = 0.65, ACCENT_C = 0.14;
const INK = [0x0a, 0x0a, 0x0c];
const inkY = luminance(INK);

// 1. Every hue on the cycle keeps >= 4.5:1 against the ink.
{
    let worst = { ratio: Infinity, hue: -1 };
    for (let h = 0; h < 360; h += 2) {
        const lin = oklchToLinearSrgb(ACCENT_L, ACCENT_C, h);
        // Browser clips out-of-gamut oklch to sRGB; clip the same way.
        const rgb = lin.map(linearToSrgb255);
        const ratio = contrast(luminance(rgb), inkY);
        if (ratio < worst.ratio) worst = { ratio, hue: h };
    }
    ok(worst.ratio >= 4.5,
        `accent ink contrast all hues (worst ${worst.ratio.toFixed(2)}:1 at hue ${worst.hue})`);
}

// 2. Sanity: the math itself — pure white vs pure black is 21:1.
{
    const c = contrast(luminance([255, 255, 255]), luminance([0, 0, 0]));
    assert.ok(Math.abs(c - 21) < 0.01, "white/black contrast is 21:1");
    passed++;
}

// 3. Sanity: a known OKLCH value converts correctly.
//    oklch(100% 0 0) is white, oklch(0% 0 0) is black.
{
    ok(linearToSrgb255(oklchToLinearSrgb(1, 0, 0)[0]) === 255, "oklch L=1 -> white");
    ok(linearToSrgb255(oklchToLinearSrgb(0, 0, 0)[0]) === 0, "oklch L=0 -> black");
}

// 4. Fallback hue 250 (no @property support / reduced motion) is in range.
{
    const lin = oklchToLinearSrgb(ACCENT_L, ACCENT_C, 250);
    const rgb = lin.map(linearToSrgb255);
    const ratio = contrast(luminance(rgb), inkY);
    ok(ratio >= 4.5, `fallback hue 250 contrast ${ratio.toFixed(2)}:1`);
}

console.log(`hue-contrast: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

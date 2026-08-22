// Phase 8 acceptance: negotiation ladder, art-key immutability, static
// exemption — pure Node with mocked renderer/runtime metrics.
// Run: node tests/quality.test.js
import { createQualityNegotiator, WRITABLE_KEYS } from "../src/player/quality.js";
const FPS_FLOOR = 12;

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(`${name}: ${e.message}`); }
}

function makeMocks({ fps = 60 } = {}) {
    const writtenPatches = [];
    const renderer = {
        config: { supersample: 2, maxDevicePixelRatio: 2 },
        updateConfig(patch) {
            for (const k of Object.keys(patch)) {
                if (!WRITABLE_KEYS.includes(k)) {
                    throw new Error(`ART-KEY VIOLATION: wrote "${k}"`);
                }
                this.config[k] = patch[k];
            }
            writtenPatches.push({ ...patch });
        }
    };
    const runtime = {
        overrides: [],
        setQualityOverride(o) {
            for (const k of Object.keys(o)) {
                if (!WRITABLE_KEYS.includes(k)) {
                    throw new Error(`ART-KEY VIOLATION: wrote "${k}"`);
                }
            }
            this.overrides.push({ ...o });
        },
        isRunning: true,
        isStatic: false
    };
    return { renderer, runtime, writtenPatches };
}

const BASE_REQUEST = { logicalWidth: 320, logicalHeight: 180, fps: 30 };

ok("initial publish applies requested quality via whitelisted keys", () => {
    const { renderer, runtime } = makeMocks();
    let events = 0;
    const neg = createQualityNegotiator({
        renderer, runtime, lowTier: false,
        getRequested: () => BASE_REQUEST,
        isAnimated: () => true,
        getMeasured: () => ({ renderCostMs: 1, measuredFps: 60 }),
        onqualitychange: () => events++
    });
    const actual = neg.getActual();
    if (actual.logicalWidth !== 320 || actual.fps !== 30) throw new Error("request not applied");
    if (events < 1) throw new Error("no onqualitychange");
});

ok("sustained FPS miss walks resolution down first", () => {
    const { renderer, runtime } = makeMocks();
    const neg = createQualityNegotiator({
        renderer, runtime, lowTier: false,
        getRequested: () => BASE_REQUEST,
        isAnimated: () => true,
        getMeasured: () => ({ renderCostMs: 0, measuredFps: 5 }) // dying
    });
    // 3 strikes down + cooldown expiry per step; walk several samples
    let now = Date.now();
    for (let i = 0; i < 12; i++) { neg.sample(now); now += 6000; }
    const a = neg.getActual();
    if (!(a.logicalWidth < 320)) throw new Error(`resolution not reduced: ${a.logicalWidth}`);
});

ok("ladder reaches FPS floor and DPR cap under sustained overload", () => {
    const { renderer, runtime } = makeMocks();
    const neg = createQualityNegotiator({
        renderer, runtime, lowTier: false,
        getRequested: () => BASE_REQUEST,
        isAnimated: () => true,
        getMeasured: () => ({ renderCostMs: 999, measuredFps: 3 })
    });
    let now = Date.now();
    for (let i = 0; i < 40; i++) { neg.sample(now); now += 6000; }
    const a = neg.getActual();
    if (a.fps > 15 || a.fps < FPS_FLOOR) throw new Error(`fps floor: ${a.fps}`);
    if (a.maxDevicePixelRatio !== 1) throw new Error("dpr cap");
    if (a.supersample !== 1) throw new Error("ss drop");
});

ok("recovery walks back up after sustained good streak", () => {
    const mocks = makeMocks();
    const measured = { renderCostMs: 999, measuredFps: 3 };
    const neg = createQualityNegotiator({
        renderer: mocks.renderer, runtime: mocks.runtime, lowTier: false,
        getRequested: () => BASE_REQUEST,
        isAnimated: () => true,
        getMeasured: () => measured
    });
    let now = Date.now();
    for (let i = 0; i < 40; i++) { neg.sample(now); now += 6000; }
    const floor = { ...neg.getActual() };
    if (floor.maxDevicePixelRatio !== 1) throw new Error("setup: floor not reached");

    // recovery: healthy fps, tiny cost
    measured.renderCostMs = 0.5;
    measured.measuredFps = 60;
    for (let i = 0; i < 30; i++) { neg.sample(now); now += 11000; }
    const recovered = neg.getActual();
    if (recovered.maxDevicePixelRatio === 1 && recovered.supersample === 1 && recovered.fps === 12) {
        throw new Error("never recovered");
    }
});

ok("static scenes are exempt (no downgrades despite awful metrics)", () => {
    const { renderer, runtime } = makeMocks();
    const neg = createQualityNegotiator({
        renderer, runtime, lowTier: false,
        getRequested: () => BASE_REQUEST,
        isAnimated: () => false,
        getMeasured: () => ({ renderCostMs: 9999, measuredFps: 0 })
    });
    let now = Date.now();
    for (let i = 0; i < 20; i++) { neg.sample(now); now += 6000; }
    const a = neg.getActual();
    if (a.logicalWidth !== 320 || a.fps !== 30 || a.supersample !== null) {
        throw new Error("static scene was downgraded");
    }
});

ok("scene refresh resets ladder", () => {
    const mocks = makeMocks();
    const neg = createQualityNegotiator({
        renderer: mocks.renderer, runtime: mocks.runtime, lowTier: false,
        getRequested: () => BASE_REQUEST,
        isAnimated: () => true,
        getMeasured: () => ({ renderCostMs: 999, measuredFps: 3 })
    });
    let now = Date.now();
    for (let i = 0; i < 40; i++) { neg.sample(now); now += 6000; }
    neg.refreshRequest(BASE_REQUEST);
    const a = neg.getActual();
    if (a.logicalWidth !== 320 || a.fps !== 30 || a.supersample !== null || a.maxDevicePixelRatio !== 2) {
        throw new Error("refresh did not reset ladder: " + JSON.stringify(a));
    }
});

// Art-key immutability is enforced structurally by every mock above throwing
// on non-whitelisted writes — the fact that all previous tests passed IS the
// assertion. One explicit demonstration:
ok("explicit art-key write attempt throws", () => {
    const { renderer } = makeMocks();
    const neg = createQualityNegotiator({
        renderer, runtime: makeMocks().runtime, lowTier: false,
        getRequested: () => BASE_REQUEST,
        isAnimated: () => true,
        getMeasured: () => ({ renderCostMs: 0, measuredFps: 60 })
    });
    let threw = false;
    try {
        // simulate a buggy future change trying to write an artistic key
        renderer.updateConfig({ opticalSpill: 0.99 }); // NOT in WRITABLE_KEYS
    } catch (e) {
        threw = /violation/i.test(e.message);
    }
    if (!threw) throw new Error("art-key guard did not fire");
    void neg;
});

// ------------------------------------------------------------------
console.log(`\nquality: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log(failures.map(f => "  FAIL " + f).join("\n"));
    process.exit(1);
}
